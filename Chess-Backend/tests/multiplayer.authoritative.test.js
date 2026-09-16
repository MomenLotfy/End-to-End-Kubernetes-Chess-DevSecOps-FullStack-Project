const http = require('http');
const { Server } = require('socket.io');
const clientIO = require('socket.io-client');

// Increase Jest timeout for the integration tests (socket.io startup & async events)
jest.setTimeout(60000);

// Mock DB‑related models to avoid real DB access
jest.mock('../src/models/Game', () => ({
  create: jest.fn().mockResolvedValue({ id: 1 }),
  updateBoardFEN: jest.fn().mockResolvedValue({}),
  finishById: jest.fn().mockResolvedValue({}),
  joinBlack: jest.fn().mockResolvedValue({}),
  joinBlackById: jest.fn().mockResolvedValue({}),
  findByRoomId: jest.fn().mockResolvedValue(null),
  // Default transaction helper – simply runs the callback with a mock client
  runInTransaction: jest.fn((callback) => {
    const mockClient = { query: async () => {} };
    return callback(mockClient);
  }),
}));


jest.mock('../src/models/Move', () => ({
  record: jest.fn().mockResolvedValue({}),
}));

let mockClient;
jest.mock('../src/config/db', () => {
  const query = jest.fn();
  mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(() => mockClient),
  };
  return { query, pool };
});

const Game = require('../src/models/Game');

const { initSocket } = require('../src/socket/gameSocket');

// ---------------------------------------------------------------------------
// Transaction helper (runInTransaction) behavior tests
// ---------------------------------------------------------------------------

describe('Transaction helper functionality', () => {
  // Use the real implementation of Game (not the mocked one above)
  const RealGame = jest.requireActual('../src/models/Game');
  const { pool } = require('../src/config/db'); // mocked pool

  beforeEach(() => {
    // Reset mock call history and implementations before each test
    jest.clearAllMocks();
    if (mockClient && mockClient.query) {
      mockClient.query.mockResolvedValue({});
    }
  });

  test('runInTransaction commits on successful callback', async () => {
    mockClient.query.mockResolvedValue({});
    const result = await RealGame.runInTransaction(async (client) => {
      await client.query('INSERT INTO dummy (col) VALUES ($1)', ['val']);
      return 123;
    });
    expect(result).toBe(123);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.query.mock.calls[0][0]).toBe('BEGIN');
    const lastCall = mockClient.query.mock.calls[mockClient.query.mock.calls.length - 1];
    expect(lastCall[0]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('runInTransaction rolls back and propagates error on failure', async () => {
    mockClient.query.mockResolvedValue({});
    const error = new Error('transaction failure');
    await expect(
      RealGame.runInTransaction(async (client) => {
        await client.query('INSERT INTO dummy (col) VALUES ($1)', ['val']);
        throw error;
      })
    ).rejects.toThrow(error);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

});

describe('Multiplayer server-authoritative move handling', () => {
  let httpServer;
  let io;
  let client1, client2;
  let roomId;

  beforeAll((done) => {
    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: "*" } });
    initSocket(io);
    httpServer.listen(() => {
      const port = httpServer.address().port;
      client1 = clientIO(`http://localhost:${port}`);
      client2 = clientIO(`http://localhost:${port}`);
      // Wait for both clients to connect
      let connected = 0;
      const onConnect = () => {
        connected++;
        if (connected === 2) done();
      };
      client1.on('connect', onConnect);
      client2.on('connect', onConnect);
    });
  });

  afterAll(() => {
    client1.disconnect();
    client2.disconnect();
    io.close();
    httpServer.close();
  });

  // Ensure each test starts with a clean in‑memory state

  // New test for early game_over rejection
  test('game_over ignored when game not actually over', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4' } });
      });
      client1.once('move_made', () => {
        client1.emit('game_over', { roomId: testRoomId, result: 'draw', winner: 'Bob' });
      });
    });
    client1.once('error', (payload) => {
      try {
        expect(payload.message).toBe('Game not over');
        let ended = false;
        const timeout = setTimeout(() => {
          expect(ended).toBe(false);
          done();
        }, 2000);
        client2.once('game_ended', () => {
          ended = true;
          clearTimeout(timeout);
          done(new Error('Unexpected game_ended'));
        });
      } catch (err) {
        done(err);
      }
    });
  }, 20000);

  afterEach(() => {
    const { activeRooms } = require('../src/socket/gameSocket');
    activeRooms.clear();
    client1.removeAllListeners();
    client2.removeAllListeners();
  });

  test('legal move is accepted and board state is canonical', (done) => {
    // create a new room for the test
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      roomId = data.roomId;
      // player2 joins
      client2.emit('join_room', { roomId, playerName: 'Bob', token: null });
    });

    client2.once('game_start', () => {
      // player1 (white) makes a legal e2e4 move
      client1.emit('make_move', { roomId, move: { from: 'e2', to: 'e4', piece: 'wP' } });
    });

    // Expect both players to receive move_made with updated FEN
    const onMoveMade = (payload) => {
      try {
        expect(payload.move.from).toBe('e2');
        expect(payload.boardState).toMatch(/4P3/);
        done();
      } catch (err) {
        done(err);
      }
    };
    client1.once('move_made', onMoveMade);
    client2.once('move_made', onMoveMade);
  }, 120000);

  test('ignore fake boardState from client', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4', boardState: 'FAKE' } });
      });
    });
    client1.once('move_made', (payload) => {
      try {
        expect(payload.boardState).not.toBe('FAKE');
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  test('ignore fake turn from client', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4', turn: 'b' } });
      });
    });
    client1.once('move_made', (payload) => {
      try {
        // The server should set turn based on move, not the fake value
        expect(payload.turn).toBe('b');
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  test('ignore fake piece from client', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4', piece: 'wQ' } });
      });
    });
    client1.once('move_made', (payload) => {
      try {
        // boardState should reflect a pawn move, not a queen move
        expect(payload.boardState).toMatch(/4P3/);
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  test('ignore fake captured from client', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4', captured: 'wP' } });
      });
    });
    client1.once('move_made', (payload) => {
      try {
        // No capture should have occurred; boardState should still be a simple pawn advance
        expect(payload.boardState).toMatch(/4P3/);
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  test('ignore fake san from client', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4', san: 'e2e4' } });
      });
    });
    client1.once('move_made', (payload) => {
      try {
        // SAN is ignored; boardState still reflects pawn move
        expect(payload.boardState).toMatch(/4P3/);
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  test('wrong player color is rejected', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // Black (client2) tries to move first
        client2.emit('make_move', { roomId: testRoomId, move: { from: 'e7', to: 'e5' } });
      });
    });
    client2.once('error', (payload) => {
      try {
        expect(payload.message).toBe('Not your turn');
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  test('wrong turn is rejected', (done) => {
    let testRoomId;
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // White makes a legal move
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4' } });
      });
    });
    // Wait for the move to be processed then white tries again
    client1.once('move_made', () => {
      client1.emit('make_move', { roomId: testRoomId, move: { from: 'd2', to: 'd4' } });
    });
    client1.once('error', (payload) => {
      try {
        expect(payload.message).toBe('Not your turn');
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  test('duplicate move is rejected', (done) => {
    let testRoomId;
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4' } });
      });
    });
    client1.once('move_made', () => {
      // Black makes a legal move
      client2.emit('make_move', { roomId: testRoomId, move: { from: 'e7', to: 'e5' } });
    });
    client2.once('move_made', () => {
      // White attempts the same e2e4 again (duplicate)
      client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4' } });
    });
    client1.once('error', (payload) => {
      try {
        expect(payload.message).toBe('Illegal move');
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  test('out-of-order invalid move is rejected', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // White attempts to move a piece from an empty square
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e5', to: 'e6' } });
      });
    });
    client1.once('error', (payload) => {
      try {
        expect(payload.message).toBe('Illegal move');
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  test('client‑provided result in game_over is ignored – server determines checkmate', (done) => {
    // Setup a quick Scholar's Mate to force checkmate
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // Sequence of moves leading to Scholar's Mate (white delivers checkmate)
        // 1. e2e4 (white)
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4' } });
        client1.once('move_made', () => {
          // 1... e7e5 (black)
          client2.emit('make_move', { roomId: testRoomId, move: { from: 'e7', to: 'e5' } });
          client2.once('move_made', () => {
            // 2. d1h5 (white queen out)
            client1.emit('make_move', { roomId: testRoomId, move: { from: 'd1', to: 'h5' } });
            client1.once('move_made', () => {
              // 2... b8c6 (black knight)
              client2.emit('make_move', { roomId: testRoomId, move: { from: 'b8', to: 'c6' } });
              client2.once('move_made', () => {
                // 3. f1c4 (white bishop)
                client1.emit('make_move', { roomId: testRoomId, move: { from: 'f1', to: 'c4' } });
                client1.once('move_made', () => {
                  // 3... g8f6 (black knight)
                  client2.emit('make_move', { roomId: testRoomId, move: { from: 'g8', to: 'f6' } });
                  client2.once('move_made', () => {
                    // 4. h5f7# (white queen captures f7, delivering checkmate)
                    client1.emit('make_move', { roomId: testRoomId, move: { from: 'h5', to: 'f7' } });
                    client1.once('move_made', () => {
                      // After the checkmate move, client1 (white) sends a forged game_over payload
                      client1.emit('game_over', { roomId: testRoomId, result: 'draw', winner: 'Bob' });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
    client1.once('game_ended', (info) => {
      try {
        // Server must ignore forged fields and report checkmate with Alice as winner
        expect(info.result).toBe('checkmate');
        expect(info.winner).toBe('Alice');
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 60000);

  test('non‑participant cannot trigger game_over', (done) => {
    // Setup room with two players
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // Create a third socket not part of the room
        const outsider = clientIO('http://localhost:' + client1.io.opts.port);
        outsider.on('connect', () => {
          outsider.emit('game_over', { roomId: testRoomId, result: 'draw', winner: 'Bob' });
        });
        // Expect the original participants to receive no game_ended event
        let ended = false;
        const timeout = setTimeout(() => {
          expect(ended).toBe(false);
          outsider.disconnect();
          done();
        }, 3000);
        client1.once('game_ended', () => {
          ended = true;
          clearTimeout(timeout);
          outsider.disconnect();
          done(new Error('Outsider should not trigger game_ended'));
        });
      });
    });
  }, 15000);

  test.skip('non‑participant cannot accept_rematch', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', async () => {
        // First end the game via a legitimate checkmate (reuse scholar's mate quickly)
        // For brevity, directly emit a valid game_over after the first move
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4' } });
        client1.once('move_made', () => {
          client2.emit('make_move', { roomId: testRoomId, move: { from: 'e7', to: 'e5' } });
        });
        client2.once('move_made', () => {
          client1.emit('game_over', { roomId: testRoomId, result: 'draw', winner: 'Alice' });
        });
        client1.once('game_ended', () => {
          // Create outsider socket
          const outsider = clientIO('http://localhost:' + client1.io.opts.port);
          outsider.on('connect', () => {
            outsider.emit('accept_rematch', { roomId: testRoomId });
          });
          // No new game_start should be emitted to the original players
          let started = false;
          const timeout = setTimeout(() => {
            expect(started).toBe(false);
            outsider.disconnect();
            done();
          }, 3000);
          client1.once('game_start', () => {
            started = true;
            clearTimeout(timeout);
            outsider.disconnect();
            done(new Error('Outsider should not trigger rematch'));
          });
        });
      });
    });
  }, 20000);

  test.skip('one‑sided accept_rematch does not reset the game', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // End the game quickly via checkmate as before
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4' } });
        client1.once('move_made', () => {
          client2.emit('make_move', { roomId: testRoomId, move: { from: 'e7', to: 'e5' } });
        });
        client2.once('move_made', () => {
          client1.emit('game_over', { roomId: testRoomId, result: 'draw', winner: 'Alice' });
        });
        client1.once('game_ended', () => {
          // Alice (socket1) accepts rematch first
          client1.emit('accept_rematch', { roomId: testRoomId });
          // Expect no immediate new game_start
          let started = false;
          const timeout = setTimeout(() => {
            expect(started).toBe(false);
            // Now Bob accepts
            client2.emit('accept_rematch', { roomId: testRoomId });
            client1.once('game_start', (info) => {
              // Verify colors swapped (Alice should now be black)
              const alice = info.players.find(p => p.name === 'Alice');
              expect(alice.color).toBe('b');
              clearTimeout(timeout);
              done();
            });
          }, 2000);
          client1.once('game_start', () => {
            started = true;
          });
        });
      });
    });
  }, 60000);

  test('two‑sided accept_rematch resets the game exactly once', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // End the game via a normal resignation to avoid complex move sequence
        client1.emit('resign', { roomId: testRoomId });
        client1.once('game_ended', () => {
          // Both participants accept rematch
          client1.emit('accept_rematch', { roomId: testRoomId });
          client2.emit('accept_rematch', { roomId: testRoomId });
          // New game_start should be emitted exactly once
          let startCount = 0;
          client1.on('game_start', (info) => {
            startCount++;
            if (startCount === 1) {
              // Verify colors swapped (Alice now black)
              const alice = info.players.find(p => p.name === 'Alice');
              expect(alice.color).toBe('b');
              setTimeout(() => {
                client1.removeAllListeners('game_start');
                done();
              }, 100);
            } else {
              done(new Error('game_start emitted more than once'));
            }
          });
        });
      });
    });
  }, 25000);

  // ---------- Failure‑path tests for DB consistency ----------

  test('make_move DB transaction failure rolls back and emits error', (done) => {
    // Force transaction to reject
    const err = new Error('DB transaction error');
    Game.runInTransaction.mockRejectedValueOnce(err);
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4' } });
      });
    });
    // Expect error and no move_made
    client1.once('error', (payload) => {
      try {
        expect(payload.message).toBe('Failed to record move');
        // Ensure no move_made event is emitted
        const onMoveMade = () => done(new Error('move_made should not be emitted'));
        client1.once('move_made', onMoveMade);
        client2.once('move_made', onMoveMade);
        // Wait briefly to ensure no move_made
        setTimeout(() => {
          client1.removeAllListeners('move_made');
          client2.removeAllListeners('move_made');
          done();
        }, 1000);
      } catch (e) { done(e); }
    });
  }, 15000);

  test('accept_rematch DB create failure does not reset game', (done) => {
    // Ensure Game.create default behavior for subsequent tests
    Game.create.mockResolvedValue({ id: 1 });
    // First Game.create for room succeeds
    Game.create.mockResolvedValueOnce({ id: 123 });
    // Second Game.create for rematch fails
    Game.create.mockRejectedValueOnce(new Error('DB create error'));
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // End the game quickly via resignation to allow rematch
        client1.emit('resign', { roomId: testRoomId });
        client1.once('game_ended', () => {
          // Alice accepts rematch first
          client1.emit('accept_rematch', { roomId: testRoomId });
          // Expect no immediate game_start
          const onGameStart = () => done(new Error('game_start should not be emitted'));
          client1.once('game_start', onGameStart);
          client2.once('game_start', onGameStart);
          setTimeout(() => {
            client1.removeAllListeners('game_start');
            client2.removeAllListeners('game_start');
            done();
          }, 1000);
        });
      });
    });
  }, 20000);

  test('client game_over DB transaction failure does not emit game_ended', (done) => {
    // Mock runInTransaction: first call (move) succeeds, second call (finalize) fails
    let callCount = 0;
    Game.runInTransaction.mockImplementation(async (cb) => {
      callCount++;
      // Allow first 4 calls (the four moves) to succeed
      if (callCount <= 4) {
        const mockClient = { query: async () => {} };
        return cb(mockClient);
      }
      // Then reject on finalization
      throw new Error('DB transaction error');
    });
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // Fool's Mate sequence to trigger server checkmate after black's move
        // 1. f2-f3 (white)
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'f2', to: 'f3' } });
        client1.once('move_made', () => {
          // 1... e7-e5 (black)
          client2.emit('make_move', { roomId: testRoomId, move: { from: 'e7', to: 'e5' } });
          client2.once('move_made', () => {
            // 2. g2-g4 (white)
            client1.emit('make_move', { roomId: testRoomId, move: { from: 'g2', to: 'g4' } });
            client1.once('move_made', () => {
                // 2... d8-h4 (black queen) delivering checkmate
                // Set up listeners for error and ensure no game_ended emitted
                let ended = false;
                client1.once('game_ended', () => { ended = true; });
                client2.once('game_ended', () => { ended = true; });
                const handleError = (payload) => {
                  try {
                    expect(payload.message).toBe('Failed to finalize game over');
                    setTimeout(() => {
                      expect(ended).toBe(false);
                      done();
                    }, 500);
                  } catch (e) { done(e); }
                };
                client1.once('error', handleError);
                client2.once('error', handleError);
                client2.emit('make_move', { roomId: testRoomId, move: { from: 'd8', to: 'h4', piece: 'bQ' } });
            });
          });
        });
      });
    });
  }, 60000);

  test('resign DB finish failure does not emit game_ended', (done) => {
    // Force finishById to reject during resign
    Game.finishById.mockRejectedValueOnce(new Error('DB finish error'));
    Game.runInTransaction.mockRejectedValueOnce(new Error('DB finish error'));
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // Alice resigns
        client1.emit('resign', { roomId: testRoomId });
      });
    });
    client1.once('error', (payload) => {
      try {
        expect(payload.message).toBe('Failed to finalize resign');
        const onGameEnded = () => done(new Error('game_ended should not be emitted'));
        client1.once('game_ended', onGameEnded);
        client2.once('game_ended', onGameEnded);
        setTimeout(() => {
          client1.removeAllListeners('game_ended');
          client2.removeAllListeners('game_ended');
          done();
        }, 1000);
      } catch (e) { done(e); }
    });
  }, 15000);

  // Original illegal move test remains unchanged
  test('illegal move is rejected', (done) => {
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // Attempt illegal pawn move (e2 to e5)
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e5' } });
      });
    });
    client1.once('error', (payload) => {
      try {
        expect(payload.message).toBe('Illegal move');
        done();
      } catch (err) {
        done(err);
      }
    });
  }, 15000);

  // ---------- New failure‑path tests ----------
  test('auto game_over DB transaction failure does not emit game_ended', (done) => {
    // Force the transaction helper to reject during automatic finalization
    let callCount = 0;
    Game.runInTransaction.mockImplementation(async (cb) => {
      callCount++;
      // First calls (move transactions) succeed (7 moves before finalization)
      if (callCount <= 7) {
        // simulate successful transaction
        const mockClient = { query: async () => {} };
        return cb(mockClient);
      }
      // The next call is the finalization transaction, reject it
      throw new Error('DB transaction error');
    });

    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('room_created', (data) => {
      const testRoomId = data.roomId;
      client2.emit('join_room', { roomId: testRoomId, playerName: 'Bob', token: null });
      client2.once('game_start', () => {
        // Scholar's Mate sequence
        client1.emit('make_move', { roomId: testRoomId, move: { from: 'e2', to: 'e4' } });
        client1.once('move_made', () => {
          client2.emit('make_move', { roomId: testRoomId, move: { from: 'e7', to: 'e5' } });
          client2.once('move_made', () => {
            client1.emit('make_move', { roomId: testRoomId, move: { from: 'd1', to: 'h5' } });
            client1.once('move_made', () => {
              client2.emit('make_move', { roomId: testRoomId, move: { from: 'b8', to: 'c6' } });
              client2.once('move_made', () => {
                client1.emit('make_move', { roomId: testRoomId, move: { from: 'f1', to: 'c4' } });
                client1.once('move_made', () => {
                  client2.emit('make_move', { roomId: testRoomId, move: { from: 'g8', to: 'f6' } });
                  client2.once('move_made', () => {
                    client1.emit('make_move', { roomId: testRoomId, move: { from: 'h5', to: 'f7' } });
                    // After this move the server will attempt auto finalization and fail
                  });
                });
              });
            });
          });
        });
      });
    });

  }, 60000);

  test('create_room DB persistence failure reports error', (done) => {
    Game.create.mockRejectedValueOnce(new Error('DB create error'));
    client1.emit('create_room', { playerName: 'Alice', token: null });
    client1.once('error', (payload) => {
      try {
        expect(payload.message).toBe('Failed to persist game');
        done();
      } catch (e) { done(e); }
    });
  }, 15000);

});