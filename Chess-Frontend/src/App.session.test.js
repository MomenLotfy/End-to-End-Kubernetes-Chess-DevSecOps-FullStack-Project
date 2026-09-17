import { render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { refreshSession } from "./api/client";

jest.mock("./api/client", () => ({
  refreshSession: jest.fn(),
  saveScore: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("./contexts/SettingsContext", () => ({ SettingsProvider: ({ children }) => children }));
jest.mock("./hooks/useChessGame", () => () => ({ reset: jest.fn() }));
jest.mock("./components/HomeScreen", () => ({ user }) => (
  <div>{user ? `Signed in as ${user.username}` : "Unauthenticated home"}</div>
));
jest.mock("./components/AchievementToast", () => () => null);
jest.mock("./components/GameScreen", () => () => null);
jest.mock("./components/OnlinePlay", () => () => null);
jest.mock("./components/AIPlay", () => () => null);

const restoredUser = { id: 17, username: "restored-user", email: "restored@example.test" };

test("restores an authenticated session from the HttpOnly refresh cookie endpoint", async () => {
  refreshSession.mockResolvedValue({ user: restoredUser });

  render(<App />);

  expect(screen.queryByText(/Signed in/)).not.toBeInTheDocument();
  expect(await screen.findByText("Signed in as restored-user")).toBeInTheDocument();
  expect(refreshSession).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sessionStorage.getItem("chess_user"))).toEqual(restoredUser);
  expect(localStorage.getItem("chess_token")).toBeNull();
});

test("clears stale display state and shows the unauthenticated UI when restoration fails", async () => {
  sessionStorage.setItem("chess_user", JSON.stringify(restoredUser));
  localStorage.setItem("chess_token", "legacy-value");
  refreshSession.mockRejectedValue(new Error("Authentication required"));

  render(<App />);

  expect(await screen.findByText("Unauthenticated home")).toBeInTheDocument();
  await waitFor(() => expect(sessionStorage.getItem("chess_user")).toBeNull());
  expect(localStorage.getItem("chess_token")).toBeNull();
});
