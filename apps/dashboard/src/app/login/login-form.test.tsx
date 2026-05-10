// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import LoginForm from "./login-form";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockSignIn = vi.fn();

vi.mock("next-auth/react", () => ({
  signIn: (...args: any[]) => mockSignIn(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert" />,
  Loader2: (props: any) => <span data-testid="icon-loader" {...props} />,
}));

vi.mock("./actions", () => ({
  validateTenantAction: vi.fn().mockResolvedValue({
    success: true,
    provider: "tenant-oauth",
    cookieTenantSlug: "acme-corp",
  }),
}));

describe("LoginForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the login card with Monet branding", () => {
    render(<LoginForm />);
    expect(screen.getByText("Monet")).toBeInTheDocument();
  });

  it("renders the organization input field", () => {
    render(<LoginForm />);
    const input = screen.getByLabelText("Organization");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "e.g. acme-corp");
  });

  it("renders the submit button", () => {
    render(<LoginForm />);
    expect(screen.getByRole("button", { name: /continue to sign in/i })).toBeInTheDocument();
  });

  it("shows description text for organization slug", () => {
    render(<LoginForm />);
    expect(
      screen.getByText("Enter your organization slug to sign in to your dashboard")
    ).toBeInTheDocument();
  });

  it("allows typing into the organization input", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    const input = screen.getByLabelText("Organization");
    await user.type(input, "acme-corp");
    expect(input).toHaveValue("acme-corp");
  });

  it("calls validateTenantAction and signIn on form submission", async () => {
    const user = userEvent.setup();
    const { validateTenantAction } = await import("./actions");
    render(<LoginForm />);

    const input = screen.getByLabelText("Organization");
    await user.type(input, "acme-corp");
    await user.click(screen.getByRole("button", { name: /continue to sign in/i }));

    await waitFor(() => {
      expect(validateTenantAction).toHaveBeenCalledWith("acme-corp");
    });

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalled();
    });
  });

  it("has required attribute on the organization input", () => {
    render(<LoginForm />);
    const input = screen.getByLabelText("Organization");
    expect(input).toHaveAttribute("required");
  });

  it("shows error when validateTenantAction returns empty slug error", async () => {
    const user = userEvent.setup();
    const { validateTenantAction } = await import("./actions");
    (validateTenantAction as any).mockResolvedValueOnce({
      error: "Please enter your organization slug",
    });

    render(<LoginForm />);

    const input = screen.getByLabelText("Organization");
    // Type whitespace to bypass HTML required, JS will trim and send to server action
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: /continue to sign in/i }));

    await waitFor(() => {
      expect(screen.getByText("Please enter your organization slug")).toBeInTheDocument();
    });
  });

  it("shows error when validateTenantAction returns error", async () => {
    const user = userEvent.setup();
    const { validateTenantAction } = await import("./actions");
    (validateTenantAction as any).mockResolvedValueOnce({
      error: "Organization not found",
    });

    render(<LoginForm />);

    const input = screen.getByLabelText("Organization");
    await user.type(input, "nonexistent");
    await user.click(screen.getByRole("button", { name: /continue to sign in/i }));

    // The error text appears in both AlertTitle and AlertDescription
    await waitFor(() => {
      const errorElements = screen.getAllByText("Organization not found");
      expect(errorElements.length).toBeGreaterThanOrEqual(1);
    });
  });
});
