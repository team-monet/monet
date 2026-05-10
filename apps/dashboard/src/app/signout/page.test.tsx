// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import SignOutPage from "./page";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockSignOut = vi.fn();

vi.mock("next-auth/react", () => ({
  signOut: (...args: any[]) => mockSignOut(...args),
}));

vi.mock("lucide-react", () => ({
  LogOut: () => <span data-testid="icon-logout" />,
}));

describe("SignOutPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the sign out heading", () => {
    render(<SignOutPage />);
    expect(screen.getByText("Sign Out", { selector: "div" })).toBeInTheDocument();
  });

  it("renders the confirmation description", () => {
    render(<SignOutPage />);
    expect(
      screen.getByText("Are you sure you want to sign out?")
    ).toBeInTheDocument();
  });

  it("renders the redirect notice", () => {
    render(<SignOutPage />);
    expect(
      screen.getByText("You will be redirected to the login page.")
    ).toBeInTheDocument();
  });

  it("renders the Sign Out button", () => {
    render(<SignOutPage />);
    expect(
      screen.getByRole("button", { name: "Sign Out" })
    ).toBeInTheDocument();
  });

  it("renders the Go Back button", () => {
    render(<SignOutPage />);
    expect(
      screen.getByRole("button", { name: "Go Back" })
    ).toBeInTheDocument();
  });

  it("calls signOut with callbackUrl when Sign Out button is clicked", async () => {
    const user = userEvent.setup();
    render(<SignOutPage />);

    await user.click(screen.getByRole("button", { name: "Sign Out" }));

    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });

  it("calls window.history.back when Go Back is clicked", async () => {
    const mockBack = vi.fn();
    vi.spyOn(window.history, "back").mockImplementation(mockBack);

    const user = userEvent.setup();
    render(<SignOutPage />);

    await user.click(screen.getByRole("button", { name: "Go Back" }));

    expect(mockBack).toHaveBeenCalled();
  });
});
