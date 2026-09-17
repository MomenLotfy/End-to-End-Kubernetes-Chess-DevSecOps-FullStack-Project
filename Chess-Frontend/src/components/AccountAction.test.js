import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AccountAction from "./AccountAction";
import { verifyEmail, resetPassword } from "../api/client";

jest.mock("../api/client", () => ({ verifyEmail: jest.fn(), resetPassword: jest.fn() }));
jest.mock("../contexts/SettingsContext", () => ({
  useSettings: () => ({ colors: { bg: "#000", tx: "#fff", gold: "#fc0", border: "#333", modalBg: "#111", danger: "#f00" } }),
}));

test("email verification shows its pending and successful states", async () => {
  let resolveVerification;
  verifyEmail.mockReturnValue(new Promise(resolve => { resolveVerification = resolve; }));
  window.history.pushState({}, "", "/verify-email?token=verification-token-value");

  render(<AccountAction />);

  expect(screen.getByText("Verifying your email…")).toBeInTheDocument();
  expect(verifyEmail).toHaveBeenCalledWith("verification-token-value");
  await act(async () => resolveVerification({ message: "Email verified" }));
  expect(await screen.findByText("Email verified")).toBeInTheDocument();
});

test("email verification displays a rejected-token state", async () => {
  verifyEmail.mockRejectedValue(new Error("Invalid or expired token"));
  window.history.pushState({}, "", "/verify-email?token=expired-token-value");

  render(<AccountAction />);

  expect(await screen.findByText("Invalid or expired token")).toBeInTheDocument();
  expect(screen.queryByText("Verifying your email…")).not.toBeInTheDocument();
});

test("password reset validates length and submits the URL token", async () => {
  resetPassword.mockResolvedValue({ message: "Password reset complete" });
  window.history.pushState({}, "", "/reset-password?token=password-reset-token");
  render(<AccountAction />);

  const user = userEvent.setup();
  const input = screen.getByPlaceholderText("At least 10 characters");
  const button = screen.getByRole("button", { name: "Reset password" });
  expect(button).toBeDisabled();
  await user.type(input, "new-secure-password");
  expect(button).toBeEnabled();
  await user.click(button);

  expect(resetPassword).toHaveBeenCalledWith("password-reset-token", "new-secure-password");
  expect(await screen.findByText("Password reset complete")).toBeInTheDocument();
  expect(screen.queryByPlaceholderText("At least 10 characters")).not.toBeInTheDocument();
});
