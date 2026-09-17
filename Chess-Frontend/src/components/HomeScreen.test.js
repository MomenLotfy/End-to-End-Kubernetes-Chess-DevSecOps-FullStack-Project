import { render, screen, fireEvent } from "@testing-library/react";
import HomeScreen from "./HomeScreen";

jest.mock("../contexts/SettingsContext", () => ({
  useSettings: () => ({ colors: {
    pnl: "#111", pnlBd: "#222", txMut: "#aaa", bg: "#000", surface: "#111", border: "#333",
    tx: "#fff", gold: "#fc0", goldSoft: "#cc0", txFaint: "#777",
  } }),
}));
jest.mock("./AuthModal", () => () => <div>Authentication required</div>);
jest.mock("./LeaderboardModal", () => () => null);
jest.mock("./SettingsPanel", () => () => null);
jest.mock("./ProfileModal", () => () => null);
jest.mock("./FriendsModal", () => () => null);
jest.mock("./TournamentsModal", () => () => null);
jest.mock("./ui/Icon", () => ({ name }) => <span>{name}</span>);
jest.mock("./ui/Modal", () => ({ Sparkle: () => null }));

const requiredProps = {
  token: false,
  onLogout: jest.fn(),
  onAuthSuccess: jest.fn(),
  onPlayLocal: jest.fn(),
  onPlayAI: jest.fn(),
};

test("unauthenticated users are prompted to sign in instead of entering online play", () => {
  const onPlayOnline = jest.fn();
  render(<HomeScreen {...requiredProps} user={null} onPlayOnline={onPlayOnline} />);

  fireEvent.click(screen.getByRole("button", { name: /Play Online/ }));

  expect(onPlayOnline).not.toHaveBeenCalled();
  expect(screen.getByText("Authentication required")).toBeInTheDocument();
});

test("authenticated users can enter online play", () => {
  const onPlayOnline = jest.fn();
  render(<HomeScreen {...requiredProps} user={{ id: 4, username: "Alice" }} token onPlayOnline={onPlayOnline} />);

  fireEvent.click(screen.getByRole("button", { name: /Play Online/ }));

  expect(onPlayOnline).toHaveBeenCalledTimes(1);
});
