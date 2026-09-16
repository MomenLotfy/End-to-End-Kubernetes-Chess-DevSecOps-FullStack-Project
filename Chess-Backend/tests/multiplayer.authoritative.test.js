const http = require('http');
const { Server } = require('socket.io');
const clientIO = require('socket.io-client');
const jwt = require('jsonwebtoken');
const { socketAuthMiddleware } = require('../src/socket/socketAuth');

jest.setTimeout(60000);

// ---------------------------------------------------------------------------
// Mocks for the persistence layer used by gameSocket.js. `Game` and `Move`
// are mocked with the NEW transaction-scoped API (createWithClient,
// joinBlackByIdWithClient, updateBoardFENByIdWithClient,
// finishByIdWithClient, getUserForUpdateWithClient, updateEloWithClient,
// Move.recordWithClient). runInTransaction defaults to a fake that just
// invokes the callback with a stub client — individual tests override it to
// simulate specific DB failures.
// ---------------------------------------------------------------------------
let gameIdCounter;

jest.mock('../src/models/Game', () => ({
  runInTransaction: jest.fn((callback) => callback({ query: async () => ({ rowCount: 1, rows: [{}] }) })),
  createWithClient: jest.fn(),
  joinBlackByIdWithClient: jest.fn().mockResolvedValue({}),
  updateBoardFENByIdWithClient: jest.fn().mockResolvedValue({}),
  finishByIdWithClient: jest.fn().mockResolvedValue({}),
  getUserForUpdateWithClient: jest.fn(),
  updateEloWithClient: jest.fn(),
  findByRoomId: jest.fn().mockResolvedValue(null),
  findById: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/models/Move', () => ({
  recordWithClient: jest.fn().mockResolvedValue({}),
  getByGameId: jest.fn().mockResolvedValue([]),
}));

const Game = require('../src/models/Game');
const Move = require('../src/models/Move');

// ---------------------------------------------------------------------------
// Transaction helper (Game.runInTransaction) behavior — tested against the
// REAL implementation, with only the pg pool/client faked.
// ---------------------------------------------------------------------------
describe('Transaction helper functionality', () => {
  const RealGame = jest.requireActual('../src/models/Game');
  let mockClient;
  let connectSpy;

  beforeEach(() => {
    mockClient = { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
    const dbModule = require('../src/config/db');
    connectSpy = jest.spyOn(dbModule.pool, 'connect').mockResolvedValue(mockClient);
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  test('runInTransaction commits on successful callback and reuses the same client', async () => {
    let clientSeenByCallback;
    const result = await RealGame.runInTransaction(async (client) => {
      clientSeenByCallback = client;
      await client.query('INSERT INTO dummy (col) VALUES ($1)', ['val']);
      return 123;
    });

    expect(result).toBe(123);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(clientSeenByCallback).toBe(mockClient);
    expect(mockClient.query.mock.calls[0][0]).toBe('BEGIN');
    expect(mockClient.query.mock.calls[1][0]).toBe('INSERT INTO dummy (col) VALUES ($1)');
    const lastCall = mockClient.query.mock.calls[mockClient.query.mock.calls.length - 1];
    expect(lastCall[0]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('runInTransaction rolls back and propagates the original error on failure', async () => {
    const error = new Error('transaction failure');
    await expect(
      RealGame.runInTransaction(async (client) => {
        await client.query('INSERT INTO dummy (col) VALUES ($1)', ['val']);
        throw error;
      })
    ).rejects.toBe(error);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('runInTransaction does not hide the original error when ROLLBACK itself fails', async () => {
    const originalError = new Error('original failure');
    const rollbackError = new Error('rollback failure');
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'ROLLBACK') return Promise.reject(rollbackError);
      return Promise.resolve({});
    });

    await expect(
      RealGame.runInTransaction(async () => {
        throw originalError;
      })
    ).rejects.toMatchObject({
      originalError,
      rollbackError,
    });
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Game model transaction-scoped write methods — rowCount enforcement.
// ---------------------------------------------------------------------------
describe('Game model rowCount enforcement', () => {
  const RealGame = jest.requireActual('../src/models/Game');

  const clientReturning = (rowCount, row = {}) => ({
    query: jest.fn().mockResolvedValue({ rowCount, rows: rowCount ? [row] : [] }),
  });

  test('createWithClient throws when the insert affects zero rows', async () => {
    const client = clientReturning(0);
    await expect(
      RealGame.createWithClient(client, { roomId: 'R1', whiteUsername: 'Alice' })
    ).rejects.toThrow('Failed to create game row');
  });

  test('joinBlackByIdWithClient throws when no matching in-progress/open game is found', async () => {
    const client = clientReturning(0);
    await expect(
      RealGame.joinBlackByIdWithClient(client, 1, { blackUsername: 'Bob' })
    ).rejects.toThrow(/Failed to join black player/);
  });

  test('updateBoardFENByIdWithClient throws when the game row is not in progress', async () => {
    const client = clientReturning(0);
    await expect(
      RealGame.updateBoardFENByIdWithClient(client, 1, 'fen')
    ).rejects.toThrow(/Failed to update board FEN/);
  });

  test('finishByIdWithClient throws ALREADY_FINALIZED when the game is already finished', async () => {
    const client = clientReturning(0);
    await expect(
      RealGame.finishByIdWithClient(client, 1, { result: 'resign', winnerColor: 'w' })
    ).rejects.toThrow('ALREADY_FINALIZED');
  });

  test('updateEloWithClient throws when the user row is not found', async () => {
    const client = clientReturning(0);
    await expect(RealGame.updateEloWithClient(client, 1, 1200)).rejects.toThrow(/Failed to update ELO/);
  });
});

// ---------------------------------------------------------------------------
// Socket.io integration: server-authoritative multiplayer flow.
// ---------------------------------------------------------------------------
describe('Multiplayer server-authoritative flow', () => {
  let httpServer;
  let io;
  let client1, client2;
  let port;

  const { initSocket, activeRooms } = require('../src/socket/gameSocket');

  const connectClient = () => clientIO(`http://localhost:${port}`);

  const createRoom = (client, playerName = 'Alice') =>
    new Promise((resolve, reject) => {
      client.emit('create_room', { playerName });
      client.once('room_created', resolve);
      client.once('error', reject);
    });

  const joinRoom = (client, roomId, playerName = 'Bob') =>
    new Promise((resolve, reject) => {
      const onStart = (info) => {
        client.off('error', onError);
        resolve(info);
      };
      const onError = (err) => {
        client.off('game_start', onStart);
        reject(err);
      };
      client.once('game_start', onStart);
      client.once('error', onError);
      client.emit('join_room', { roomId, playerName });
    });

  // Registers "drain" listeners on every other participant BEFORE emitting
  // the move, so whichever order the room broadcast happens to arrive in
  // relative to the mover's own copy, it is consumed here and can never be
  // picked up by a later, unrelated `.once('move_made', ...)` registered on
  // that same socket for a subsequent move (this is a property of the two
  // independent client connections used by the test harness, not of the
  // server, which only ever sends one `move_made` per accepted move).
  const makeMove = (mover, others, roomId, move) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const otherDrains = others.map((o) => new Promise((res) => o.once('move_made', res)));

      const onError = (err) => {
        if (settled) return;
        settled = true;
        mover.off('move_made', onMoveMade);
        reject(err);
      };
      const onMoveMade = (payload) => {
        if (settled) return;
        settled = true;
        mover.off('error', onError);
        Promise.all(otherDrains).then(() => resolve(payload));
      };
      mover.once('move_made', onMoveMade);
      mover.once('error', onError);
      mover.emit('make_move', { roomId, move });
    });

  beforeAll((done) => {
    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: '*' } });
    io.use(socketAuthMiddleware);
    initSocket(io);
    httpServer.listen(() => {
      port = httpServer.address().port;
      done();
    });
  });

  afterAll(() => {
    io.close();
    httpServer.close();
  });

  beforeEach((done) => {
    gameIdCounter = 0;
    jest.clearAllMocks();

    // Default happy-path DB behavior for this test group.
    Game.runInTransaction.mockImplementation((callback) =>
      callback({ query: async () => ({ rowCount: 1, rows: [{}] }) })
    );
    Game.createWithClient.mockImplementation(async () => ({ id: ++gameIdCounter }));
    Game.joinBlackByIdWithClient.mockResolvedValue({});
    Game.updateBoardFENByIdWithClient.mockResolvedValue({});
    Game.finishByIdWithClient.mockResolvedValue({});
    Move.recordWithClient.mockResolvedValue({});

    client1 = connectClient();
    client2 = connectClient();
    let connected = 0;
    const onConnect = () => {
      connected++;
      if (connected === 2) done();
    };
    client1.on('connect', onConnect);
    client2.on('connect', onConnect);
  });

  afterEach(() => {
    activeRooms.clear();
    client1.removeAllListeners();
    client2.removeAllListeners();
    client1.disconnect();
    client2.disconnect();
  });

  // ---------------- create_room / join_room ----------------

  test('create_room only emits room_created after DB persistence succeeds', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    expect(roomId).toBeDefined();
    expect(Game.createWithClient).toHaveBeenCalledTimes(1);
    expect(activeRooms.get(roomId)).toBeDefined();
  });

  test('create_room reports an error and creates no room when DB persistence fails', async () => {
    Game.runInTransaction.mockRejectedValueOnce(new Error('DB create error'));
    await expect(createRoom(client1, 'Alice')).rejects.toMatchObject({ message: 'Failed to persist game' });
    expect(activeRooms.size).toBe(0);
  });

  test('join_room only starts the game after DB persistence succeeds', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    const info = await joinRoom(client2, roomId, 'Bob');
    expect(info.players).toHaveLength(2);
    expect(activeRooms.get(roomId).status).toBe('playing');
    expect(Game.joinBlackByIdWithClient).toHaveBeenCalledTimes(1);
  });

  test('join_room reports an error and does not start the game when DB persistence fails', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    Game.runInTransaction.mockRejectedValueOnce(new Error('DB join error'));
    await expect(joinRoom(client2, roomId, 'Bob')).rejects.toMatchObject({ message: 'Failed to join game' });
    expect(activeRooms.get(roomId).status).toBe('waiting');
  });

  // ---------------- make_move ----------------

  test('legal move is accepted and board state is canonical', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    const payload = await makeMove(client1, [client2], roomId, { from: 'e2', to: 'e4' });
    expect(payload.move.from).toBe('e2');
    expect(payload.boardState).toMatch(/4P3/);
    expect(payload.turn).toBe('b');
  });

  test('illegal move is rejected', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    await expect(makeMove(client1, [client2], roomId, { from: 'e2', to: 'e5' })).rejects.toMatchObject({
      message: 'Illegal move',
    });
  });

  test('client-forged move metadata (piece/captured/san/turn/boardState) is ignored', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    const payload = await makeMove(client1, [client2], roomId, {
      from: 'e2',
      to: 'e4',
      piece: 'wQ',
      captured: 'wP',
      san: 'FORGED',
      turn: 'w',
      boardState: 'FAKE',
    });
    // The board reflects a real pawn advance, not the forged fields.
    expect(payload.boardState).toMatch(/4P3/);
    expect(payload.boardState).not.toBe('FAKE');
    expect(payload.turn).toBe('b');
  });

  test('wrong player color is rejected ("not your turn")', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    await expect(makeMove(client2, [client1], roomId, { from: 'e7', to: 'e5' })).rejects.toMatchObject({
      message: 'Not your turn',
    });
  });

  test('wrong turn (moving twice in a row) is rejected', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    await makeMove(client1, [client2], roomId, { from: 'e2', to: 'e4' });
    await expect(makeMove(client1, [client2], roomId, { from: 'd2', to: 'd4' })).rejects.toMatchObject({
      message: 'Not your turn',
    });
  });

  test('duplicate move is rejected', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    await makeMove(client1, [client2], roomId, { from: 'e2', to: 'e4' });
    await makeMove(client2, [client1], roomId, { from: 'e7', to: 'e5' });
    await expect(makeMove(client1, [client2], roomId, { from: 'e2', to: 'e4' })).rejects.toMatchObject({
      message: 'Illegal move',
    });
  });

  test('out-of-order invalid move (empty source square) is rejected', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    await expect(makeMove(client1, [client2], roomId, { from: 'e5', to: 'e6' })).rejects.toMatchObject({
      message: 'Illegal move',
    });
  });

  test('make_move DB transaction failure rolls back and emits no move_made', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    Game.runInTransaction.mockRejectedValueOnce(new Error('DB transaction error'));

    const forbidden = jest.fn();
    client2.once('move_made', forbidden);

    await expect(makeMove(client1, [client2], roomId, { from: 'e2', to: 'e4' })).rejects.toMatchObject({
      message: 'Failed to record move',
    });
    // Ordering guarantee: the handler either emits move_made or emits
    // error for a given request, never both — so once error has been
    // received, move_made for that same request cannot still be pending.
    expect(forbidden).not.toHaveBeenCalled();
    expect(activeRooms.get(roomId).chess.fen()).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    );
  });

  // ---------------- Game over / checkmate ----------------

  const scholarsMate = async (roomId) => {
    await makeMove(client1, [client2], roomId, { from: 'e2', to: 'e4' });
    await makeMove(client2, [client1], roomId, { from: 'e7', to: 'e5' });
    await makeMove(client1, [client2], roomId, { from: 'd1', to: 'h5' });
    await makeMove(client2, [client1], roomId, { from: 'b8', to: 'c6' });
    await makeMove(client1, [client2], roomId, { from: 'f1', to: 'c4' });
    await makeMove(client2, [client1], roomId, { from: 'g8', to: 'f6' });
  };

  test('server auto-detects checkmate and reports the correct winner', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    await scholarsMate(roomId);

    const ended = new Promise((resolve) => client1.once('game_ended', resolve));
    await makeMove(client1, [client2], roomId, { from: 'h5', to: 'f7' }); // checkmate
    const info = await ended;
    expect(info.result).toBe('checkmate');
    expect(info.winner).toBe('Alice');
    expect(activeRooms.get(roomId).status).toBe('finished');
  });

  test('client-provided result/winner on game_over is ignored once the server already auto-finalized', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    await scholarsMate(roomId);
    const ended = new Promise((resolve) => client1.once('game_ended', resolve));
    await makeMove(client1, [client2], roomId, { from: 'h5', to: 'f7' });
    const info = await ended;
    expect(info.result).toBe('checkmate');
    expect(info.winner).toBe('Alice');

    // A forged game_over is now rejected because the game is finished.
    const err = await new Promise((resolve) => {
      client1.once('error', resolve);
      client1.emit('game_over', { roomId, result: 'draw', winner: 'Bob' });
    });
    expect(err.message).toBe('Game already finished');
  });

  test('game_over is rejected with "Game not over" when the position is not terminal', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    await makeMove(client1, [client2], roomId, { from: 'e2', to: 'e4' });

    const gameEndedSpy = jest.fn();
    client2.once('game_ended', gameEndedSpy);

    const err = await new Promise((resolve) => {
      client1.once('error', resolve);
      client1.emit('game_over', { roomId, result: 'draw', winner: 'Bob' });
    });
    expect(err.message).toBe('Game not over');
    // Same handler invocation: no code path after this error also emits
    // game_ended, so this check is deterministic without any delay.
    expect(gameEndedSpy).not.toHaveBeenCalled();
  });

  test('non-participant cannot trigger game_over', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');

    const outsider = connectClient();
    await new Promise((resolve) => outsider.on('connect', resolve));

    const gameEndedSpy = jest.fn();
    client1.once('game_ended', gameEndedSpy);

    const err = await new Promise((resolve) => {
      outsider.once('error', resolve);
      outsider.emit('game_over', { roomId, result: 'draw', winner: 'Bob' });
    });
    expect(err.message).toBe('Not authorized for game_over');
    expect(gameEndedSpy).not.toHaveBeenCalled();
    outsider.disconnect();
  });

  test('auto-finalization DB failure after checkmate emits no game_ended (Fool\'s Mate)', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');

    // First 3 moves (f2f3, e7e5, g2g4) persist fine; the 4th call — the
    // checkmating move itself — also succeeds; the 5th call (finalization)
    // is rejected.
    let call = 0;
    Game.runInTransaction.mockImplementation((callback) => {
      call++;
      if (call <= 4) return callback({ query: async () => ({ rowCount: 1, rows: [{}] }) });
      return Promise.reject(new Error('DB finalize error'));
    });

    await makeMove(client1, [client2], roomId, { from: 'f2', to: 'f3' });
    await makeMove(client2, [client1], roomId, { from: 'e7', to: 'e5' });
    await makeMove(client1, [client2], roomId, { from: 'g2', to: 'g4' });

    const gameEndedSpy = jest.fn();
    client1.once('game_ended', gameEndedSpy);
    client2.once('game_ended', gameEndedSpy);

    // d8-h4 delivers checkmate (Fool's Mate) and triggers auto-finalization,
    // which is mocked to fail.
    const err = await new Promise((resolve) => {
      client2.once('error', resolve);
      client2.emit('make_move', { roomId, move: { from: 'd8', to: 'h4' } });
    });
    expect(err.message).toBe('Failed to finalize game over');
    expect(gameEndedSpy).not.toHaveBeenCalled();
    // The move itself is NOT rolled back — only finalization failed, and
    // the move was already committed in its own transaction.
    expect(activeRooms.get(roomId).status).toBe('playing');
  });

  // ---------------- Resign ----------------

  test('participant can resign and the opponent is reported as winner', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');

    const ended = new Promise((resolve) => client2.once('game_ended', resolve));
    client1.emit('resign', { roomId });
    const info = await ended;
    expect(info.result).toBe('resign');
    expect(info.winner).toBe('Bob');
    expect(activeRooms.get(roomId).status).toBe('finished');
  });

  test('non-participant cannot resign', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');

    const outsider = connectClient();
    await new Promise((resolve) => outsider.on('connect', resolve));

    const gameEndedSpy = jest.fn();
    client1.once('game_ended', gameEndedSpy);

    const err = await new Promise((resolve) => {
      outsider.once('error', resolve);
      outsider.emit('resign', { roomId });
    });
    expect(err.message).toBe('Not authorized for resign');
    expect(gameEndedSpy).not.toHaveBeenCalled();
    outsider.disconnect();
  });

  test('resign DB failure does not emit game_ended and leaves the game unfinished', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    Game.runInTransaction.mockRejectedValueOnce(new Error('DB finish error'));

    const gameEndedSpy = jest.fn();
    client1.once('game_ended', gameEndedSpy);
    client2.once('game_ended', gameEndedSpy);

    const err = await new Promise((resolve) => {
      client1.once('error', resolve);
      client1.emit('resign', { roomId });
    });
    expect(err.message).toBe('Failed to finalize resign');
    expect(gameEndedSpy).not.toHaveBeenCalled();
    expect(activeRooms.get(roomId).status).toBe('playing');
  });

  test('cannot resign twice', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');

    const ended = new Promise((resolve) => client2.once('game_ended', resolve));
    client1.emit('resign', { roomId });
    await ended;

    const err = await new Promise((resolve) => {
      client1.once('error', resolve);
      client1.emit('resign', { roomId });
    });
    expect(err.message).toBe('Game already finished');
  });

  // ---------------- Rematch ----------------

  const acceptRematch = (client, roomId) =>
    new Promise((resolve) => client.emit('accept_rematch', { roomId }, resolve));

  test('non-participant cannot accept_rematch', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    client1.emit('resign', { roomId });
    await new Promise((resolve) => client2.once('game_ended', resolve));

    const outsider = connectClient();
    await new Promise((resolve) => outsider.on('connect', resolve));
    const ack = await acceptRematch(outsider, roomId);
    expect(ack).toMatchObject({ ok: false, error: 'Not authorized for accept_rematch' });
    outsider.disconnect();
  });

  test('one-sided accept_rematch does not reset the game', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    client1.emit('resign', { roomId });
    await new Promise((resolve) => client2.once('game_ended', resolve));

    const gameStartSpy = jest.fn();
    client1.once('game_start', gameStartSpy);

    const ack = await acceptRematch(client1, roomId);
    expect(ack).toMatchObject({ ok: true, waitingForOpponent: true });
    // Deterministic: accept_rematch's ack is only sent after the server has
    // fully decided the outcome of this vote (no game_start pending).
    expect(gameStartSpy).not.toHaveBeenCalled();
    expect(activeRooms.get(roomId).status).toBe('finished');
  });

  test('two-sided accept_rematch resets the game exactly once with correct colors and a new gameId', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    const oldGameId = activeRooms.get(roomId).gameId;

    client1.emit('resign', { roomId });
    await new Promise((resolve) => client2.once('game_ended', resolve));

    let startCount = 0;
    client1.on('game_start', () => startCount++);

    const [ack1, ack2] = await Promise.all([acceptRematch(client1, roomId), acceptRematch(client2, roomId)]);
    const successAck = [ack1, ack2].find((a) => a.waitingForOpponent === false);
    expect(successAck).toMatchObject({ ok: true, waitingForOpponent: false });

    await new Promise((resolve) => setImmediate(resolve)); // let queued game_start events flush
    expect(startCount).toBe(1);

    const room = activeRooms.get(roomId);
    expect(room.status).toBe('playing');
    expect(room.gameId).not.toBe(oldGameId);
    expect(room.chess.fen()).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const alice = room.players.find((p) => p.name === 'Alice');
    expect(alice.color).toBe('b'); // Alice was white, now black
  });

  test('accept_rematch DB failure leaves the old finished game intact and resets nothing', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    const oldGameId = activeRooms.get(roomId).gameId;

    client1.emit('resign', { roomId });
    await new Promise((resolve) => client2.once('game_ended', resolve));

    const ack1 = await acceptRematch(client1, roomId); // waitingForOpponent
    expect(ack1.waitingForOpponent).toBe(true);

    Game.runInTransaction.mockRejectedValueOnce(new Error('DB create error'));
    const gameStartSpy = jest.fn();
    client1.once('game_start', gameStartSpy);
    client2.once('game_start', gameStartSpy);

    const ack2 = await acceptRematch(client2, roomId);
    expect(ack2).toMatchObject({ ok: false, error: 'Rematch failed to create new game' });
    expect(gameStartSpy).not.toHaveBeenCalled();

    const room = activeRooms.get(roomId);
    expect(room.status).toBe('finished');
    expect(room.gameId).toBe(oldGameId);
  });

  // ---------------- Disconnect ----------------

  test('disconnect while waiting removes the room with no DB call', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    client1.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activeRooms.has(roomId)).toBe(false);
  });

  test('disconnect while playing finalizes the game as a disconnect win for the opponent, no ELO', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');

    const ended = new Promise((resolve) => client2.once('game_ended', resolve));
    client1.disconnect();
    const info = await ended;
    expect(info.result).toBe('disconnect');
    expect(info.winner).toBe('Bob');
    expect(info.eloChange).toBeNull();
    expect(activeRooms.get(roomId).status).toBe('finished');
  });

  test('disconnect after the game is already finished only removes bookkeeping', async () => {
    const { roomId } = await createRoom(client1, 'Alice');
    await joinRoom(client2, roomId, 'Bob');
    client1.emit('resign', { roomId });
    await new Promise((resolve) => client2.once('game_ended', resolve));

    const gameEndedSpy = jest.fn();
    client2.once('game_ended', gameEndedSpy);
    client2.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gameEndedSpy).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------------------
 * Socket authentication middleware.
 * Uses the exact same middleware wired in production server.js.
 * ------------------------------------------------------------------------- */
describe('Socket authentication middleware', () => {
  let authHttpServer;
  let authIo;
  let authPort;

  beforeAll((done) => {
    authHttpServer = http.createServer();
    authIo = new Server(authHttpServer, { cors: { origin: '*' } });

    authIo.use(socketAuthMiddleware);

    authIo.on('connection', (socket) => {
      socket.emit('auth_identity', {
        userId: socket.userId,
        authenticated: socket.authenticated,
      });
    });

    authHttpServer.listen(() => {
      authPort = authHttpServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    authIo.close();
    authHttpServer.close(done);
  });

  test('guest connection is allowed without a token', async () => {
    const client = clientIO(`http://localhost:${authPort}`);

    const identity = await new Promise((resolve, reject) => {
      client.once('auth_identity', resolve);
      client.once('connect_error', reject);
    });

    expect(identity).toEqual({
      userId: null,
      authenticated: false,
    });

    client.disconnect();
  });

  test('valid JWT binds its user id to socket.userId', async () => {
    const userId = 'user-123';
    const token = jwt.sign(
      { id: userId },
      process.env.JWT_SECRET || 'chess-secret-key'
    );

    const client = clientIO(`http://localhost:${authPort}`, {
      auth: { token },
    });

    const identity = await new Promise((resolve, reject) => {
      client.once('auth_identity', resolve);
      client.once('connect_error', reject);
    });

    expect(identity).toEqual({
      userId,
      authenticated: true,
    });

    client.disconnect();
  });

  test('invalid JWT is rejected during the Socket.IO handshake', async () => {
    const client = clientIO(`http://localhost:${authPort}`, {
      auth: { token: 'this-is-not-a-valid-jwt' },
    });

    const error = await new Promise((resolve) => {
      client.once('connect_error', resolve);
    });

    expect(error.message).toBe('Invalid authentication token');
    expect(client.connected).toBe(false);

    client.disconnect();
  });

  test('JWT without an id claim is rejected', async () => {
    const token = jwt.sign(
      { username: 'Alice' },
      process.env.JWT_SECRET || 'chess-secret-key'
    );

    const client = clientIO(`http://localhost:${authPort}`, {
      auth: { token },
    });

    const error = await new Promise((resolve) => {
      client.once('connect_error', resolve);
    });

    expect(error.message).toBe('Invalid authentication token');
    expect(client.connected).toBe(false);

    client.disconnect();
  });

  test('expired JWT is rejected during the Socket.IO handshake', async () => {
    const token = jwt.sign(
      { id: 'expired-user' },
      process.env.JWT_SECRET || 'chess-secret-key',
      { expiresIn: -1 }
    );

    const client = clientIO(`http://localhost:${authPort}`, {
      auth: { token },
    });

    const error = await new Promise((resolve) => {
      client.once('connect_error', resolve);
    });

    expect(error.message).toBe('Invalid authentication token');
    expect(client.connected).toBe(false);

    client.disconnect();
  });
});
