// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import { AppSidebar } from "./app-sidebar";

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// Mock next/link as a simple anchor
// ---------------------------------------------------------------------------
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

// ---------------------------------------------------------------------------
// Mock lucide-react icons as accessible spans
// ---------------------------------------------------------------------------
vi.mock("lucide-react", () => {
  const icons = [
    "BookOpen", "Bot", "User", "LayoutDashboard", "Search", "Users",
    "ShieldCheck", "History", "Scale", "BarChart3", "LogOut",
  ];
  const mock: Record<string, React.FC> = {};
  for (const name of icons) {
    mock[name] = () => <span data-testid={`icon-${name}`} />;
  }
  return mock;
});

// ---------------------------------------------------------------------------
// Mock @/components/ui/sidebar as simple pass-through elements
// ---------------------------------------------------------------------------
vi.mock("@/components/ui/sidebar", () => {
  const SidebarDiv = ({ children, collapsible: _collapsible, ...props }: any) => (
    <div {...props}>{children}</div>
  );

  const SidebarMenuButton = ({ children, asChild, isActive: _isActive, tooltip: _tooltip, ...props }: any) => {
    if (asChild) return <>{children}</>;
    return <button type="button" {...props}>{children}</button>;
  };

  return {
    Sidebar: SidebarDiv,
    SidebarContent: SidebarDiv,
    SidebarFooter: SidebarDiv,
    SidebarHeader: SidebarDiv,
    SidebarMenu: ({ children }: any) => <ul>{children}</ul>,
    SidebarMenuButton,
    SidebarMenuItem: ({ children }: any) => <li>{children}</li>,
    SidebarRail: () => <div data-testid="sidebar-rail" />,
    SidebarGroup: ({ children }: any) => <div>{children}</div>,
    SidebarGroupLabel: ({ children }: any) => <div>{children}</div>,
  };
});

// ---------------------------------------------------------------------------
// Mock dropdown-menu components
// ---------------------------------------------------------------------------
vi.mock("@/components/ui/dropdown-menu", () => {
  const Passthrough = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: ({ children, side: _side, align: _align, sideOffset: _sideOffset, ...props }: any) => (
      <div {...props}>{children}</div>
    ),
    DropdownMenuItem: ({ children, asChild, ...props }: any) => {
      if (asChild) return <>{children}</>;
      return <div {...props}>{children}</div>;
    },
    DropdownMenuLabel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: ({ children, asChild }: any) => {
      if (asChild) return <>{children}</>;
      return <button type="button">{children}</button>;
    },
  };
});

// ---------------------------------------------------------------------------
// Mock avatar components
// ---------------------------------------------------------------------------
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  AvatarImage: () => null,
  AvatarFallback: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

describe("AppSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Monet brand name", () => {
    render(<AppSidebar />);
    expect(screen.getByText("Monet")).toBeInTheDocument();
  });

  it("renders all main navigation items", () => {
    render(<AppSidebar />);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Memories")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("My Rules")).toBeInTheDocument();
  });

  it("does not render admin section for non-admin users", () => {
    render(<AppSidebar user={{ name: "User", email: "user@test.com", role: "user" }} />);
    expect(screen.queryByText("Shared Rules")).not.toBeInTheDocument();
    expect(screen.queryByText("User Groups")).not.toBeInTheDocument();
    expect(screen.queryByText("Audit Log")).not.toBeInTheDocument();
  });

  it("renders admin section when user is tenant_admin", () => {
    render(
      <AppSidebar
        user={{ name: "Admin", email: "admin@test.com", role: "tenant_admin" }}
      />
    );
    expect(screen.getByText("Shared Rules")).toBeInTheDocument();
    expect(screen.getByText("User Groups")).toBeInTheDocument();
    expect(screen.getByText("Agent Groups")).toBeInTheDocument();
    expect(screen.getByText("Audit Log")).toBeInTheDocument();
    expect(screen.getByText("Quotas")).toBeInTheDocument();
    expect(screen.getByText("Metrics")).toBeInTheDocument();
  });

  it("renders user avatar fallback with initials", () => {
    render(
      <AppSidebar user={{ name: "John Doe", email: "john@test.com", role: "user" }} />
    );
    // The initials should be "JO" (first two characters of "John Doe")
    // Appears in both trigger and dropdown, so use getAllByText
    const initials = screen.getAllByText("JO");
    expect(initials.length).toBeGreaterThanOrEqual(1);
  });

  it("renders user name and email in the footer", () => {
    render(
      <AppSidebar user={{ name: "Jane Smith", email: "jane@acme.com", role: "user" }} />
    );
    // Name and email appear in both trigger and dropdown menu
    const names = screen.getAllByText("Jane Smith");
    expect(names.length).toBeGreaterThanOrEqual(1);
    const emails = screen.getAllByText("jane@acme.com");
    expect(emails.length).toBeGreaterThanOrEqual(1);
  });

  it("shows Log out link in dropdown", () => {
    render(<AppSidebar user={{ name: "User", email: "user@test.com" }} />);
    expect(screen.getByText("Log out")).toBeInTheDocument();
  });

  it("renders without user prop", () => {
    render(<AppSidebar />);
    // Should render nav items without crashing
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    // Default fallback should be "US" (appears in trigger + dropdown)
    const fallbacks = screen.getAllByText("US");
    expect(fallbacks.length).toBeGreaterThanOrEqual(1);
  });
});
