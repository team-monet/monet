// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert" />,
  Loader2: () => <span data-testid="icon-loader" />,
}));

vi.mock("./login-form", () => ({
  default: () => <div data-testid="login-form">LoginForm Mock</div>,
}));

vi.mock("@/lib/bootstrap", () => ({
  getBootstrapStatus: vi.fn().mockResolvedValue({ setupRequired: false }),
}));

import LoginPage from "./page";
import { getBootstrapStatus } from "@/lib/bootstrap";

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the login form when setup is not required", async () => {
    (getBootstrapStatus as any).mockResolvedValueOnce({ setupRequired: false });

    const result = await LoginPage();
    render(result);

    expect(screen.getByText("LoginForm Mock")).toBeInTheDocument();
  });

  it("redirects to /setup when setup is required", async () => {
    const { redirect } = await import("next/navigation");
    (getBootstrapStatus as any).mockResolvedValueOnce({ setupRequired: true });

    await LoginPage();

    expect(redirect).toHaveBeenCalledWith("/setup");
  });
});
