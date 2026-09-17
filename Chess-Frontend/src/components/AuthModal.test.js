import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AuthModal from "./AuthModal";
import { forgotPassword } from "../api/client";

jest.mock("../api/client", () => ({
  login: jest.fn(),
  register: jest.fn(),
  forgotPassword: jest.fn(),
}));
jest.mock("../utils/authStorage", () => ({ storeAuth: jest.fn() }));
jest.mock("../contexts/SettingsContext", () => ({
  useSettings: () => ({ colors: {
    pnl: "#111", pnlBd: "#222", tx: "#fff", surfaceHover: "#111", modalBg: "#000",
    border: "#333", gold: "#fc0", danger: "#f00", txMut: "#aaa",
  } }),
}));

test("forgot-password mode submits only the email and shows the generic response", async () => {
  forgotPassword.mockResolvedValue({ message: "If that account exists, a reset email has been sent" });
  const user = userEvent.setup();
  render(<AuthModal onClose={jest.fn()} onSuccess={jest.fn()} />);

  await user.click(screen.getByRole("button", { name: "Forgot password?" }));
  expect(screen.queryByPlaceholderText("Password")).not.toBeInTheDocument();
  await user.type(screen.getByPlaceholderText("Email"), "person@example.test");
  await user.click(screen.getByRole("button", { name: "Send reset link" }));

  expect(forgotPassword).toHaveBeenCalledWith("person@example.test");
  expect(await screen.findByText("If that account exists, a reset email has been sent")).toBeInTheDocument();
});
