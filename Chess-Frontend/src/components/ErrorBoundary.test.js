import { render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary";

function Broken() { throw new Error("test failure"); }

test("renders a production-safe recovery screen for an unhandled render error", () => {
  const original = console.error;
  console.error = jest.fn();
  render(<ErrorBoundary><Broken /></ErrorBoundary>);
  expect(screen.getByRole("alert")).toHaveTextContent("Chess could not continue");
  expect(screen.queryByText("test failure")).not.toBeInTheDocument();
  console.error = original;
});
