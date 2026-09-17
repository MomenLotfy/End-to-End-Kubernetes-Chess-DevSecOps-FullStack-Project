import { act, renderHook } from "@testing-library/react";
import useMultiplayer from "./useMultiplayer";

const handlers = new Map();
const mockSocket = {
  connected: false,
  on: jest.fn((name, handler) => { handlers.set(name, handler); }),
  off: jest.fn((name) => { handlers.delete(name); }),
  emit: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
};
const mockGame = {
  status: null,
  turn: "w",
  reset: jest.fn(),
  loadFEN: jest.fn(),
  applyRemoteMove: jest.fn(),
};

jest.mock("../utils/socket", () => ({ getSocket: () => mockSocket }));
jest.mock("./useChessGame", () => () => mockGame);

beforeEach(() => {
  handlers.clear();
  jest.clearAllMocks();
  mockSocket.connected = false;
  mockSocket.on.mockImplementation((name, handler) => { handlers.set(name, handler); });
  mockSocket.off.mockImplementation(name => { handlers.delete(name); });
});

function dispatch(name, payload) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler registered for ${name}`);
  act(() => handler(payload));
}

test("loads recovered board and move history from game_start", () => {
  const { result } = renderHook(() => useMultiplayer("Alice", true));
  const boardState = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2";
  const moveHistory = [
    { from: "e2", to: "e4", san: "e4" },
    { from: "e7", to: "e5", san: "e5" },
  ];

  dispatch("game_start", {
    roomId: "ROOM123",
    recovered: true,
    boardState,
    moveHistory,
    players: [
      { id: "socket-a", name: "Alice", color: "w", userId: 1 },
      { id: "socket-b", name: "Bob", color: "b", userId: 2 },
    ],
  });

  expect(result.current.phase).toBe("playing");
  expect(result.current.roomId).toBe("ROOM123");
  expect(result.current.myColor).toBe("w");
  expect(mockGame.loadFEN).toHaveBeenCalledWith(boardState, moveHistory);
  expect(mockGame.reset).not.toHaveBeenCalled();
});

test("rejoins the current room after Socket.io reconnect without sending a token", () => {
  const { result } = renderHook(() => useMultiplayer("Alice", "legacy-token-must-not-be-used"));

  act(() => result.current.joinRoom("ROOM456", "Alice"));
  expect(mockSocket.emit).toHaveBeenCalledWith("join_room", { roomId: "ROOM456", playerName: "Alice" });
  expect(mockSocket.emit.mock.calls.at(-1)[1]).not.toHaveProperty("token");

  mockSocket.emit.mockClear();
  dispatch("connect");
  expect(mockSocket.emit).toHaveBeenCalledWith("join_room", { roomId: "ROOM456" });
  expect(mockSocket.emit.mock.calls[0][1]).not.toHaveProperty("token");
});

test("room creation does not include the legacy session indicator as a JWT", () => {
  const { result } = renderHook(() => useMultiplayer("Alice", "legacy-token-must-not-be-used"));

  act(() => result.current.createRoom("Alice"));

  expect(mockSocket.emit).toHaveBeenCalledWith("create_room", { playerName: "Alice" });
  expect(mockSocket.emit.mock.calls.at(-1)[1]).not.toHaveProperty("token");
});
