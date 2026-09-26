const mockSocket = { disconnect: jest.fn() };
const mockIo = jest.fn(() => mockSocket);

jest.mock("socket.io-client", () => ({ io: (...args) => mockIo(...args) }));

import { getSocket, disconnectSocket } from "./socket";

beforeEach(() => {
  mockIo.mockImplementation(() => mockSocket);
});

test("creates Socket.io with browser cookie credentials and no client token payload", () => {
  const socket = getSocket();

  expect(socket).toBe(mockSocket);
  expect(mockIo).toHaveBeenCalledWith(window.location.origin, {
    autoConnect: false,
    transports: ["websocket"],
    withCredentials: true,
  });
  expect(mockIo.mock.calls[0][1]).not.toHaveProperty("auth");
  expect(mockIo.mock.calls[0][1]).not.toHaveProperty("query");
  disconnectSocket();
  expect(mockSocket.disconnect).toHaveBeenCalledTimes(1);
});
