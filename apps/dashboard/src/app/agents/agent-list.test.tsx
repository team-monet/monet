// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import AgentList from "./agent-list";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("lucide-react", () => ({
  Activity: () => <span data-testid="icon-activity" />,
  Bot: () => <span data-testid="icon-bot" />,
  Calendar: () => <span data-testid="icon-calendar" />,
  ChevronRight: () => <span data-testid="icon-chevron" />,
  Loader2: () => <span data-testid="icon-loader" />,
  ShieldAlert: () => <span data-testid="icon-shield" />,
  User: () => <span data-testid="icon-user" />,
}));

vi.mock("./actions", () => ({
  getAgentStatusAction: vi.fn().mockResolvedValue({ activeSessions: 0, revoked: false }),
}));

vi.mock("@/lib/agent-display", () => ({
  formatAgentDisplayName: (agent: any) => agent.displayName || agent.externalId,
}));

vi.mock("@/components/ui/table", () => {
  return {
    Table: ({ children, ...props }: any) => <table {...props}>{children}</table>,
    TableHeader: ({ children, ...props }: any) => <thead {...props}>{children}</thead>,
    TableBody: ({ children, ...props }: any) => <tbody {...props}>{children}</tbody>,
    TableHead: ({ children, ...props }: any) => <th {...props}>{children}</th>,
    TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
    TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
  };
});

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

describe("AgentList", () => {
  const mockAgents = [
    {
      id: "agent-1",
      externalId: "my-agent",
      displayName: "My Agent",
      isAutonomous: false,
      revokedAt: null,
      createdAt: "2025-01-15T10:00:00.000Z",
      owner: { label: "John Doe" },
    },
    {
      id: "agent-2",
      externalId: "auto-bot",
      displayName: "Auto Bot",
      isAutonomous: true,
      revokedAt: null,
      createdAt: "2025-02-20T14:30:00.000Z",
      owner: null,
    },
  ];

  const mockGroupMemberships = {
    "agent-1": ["Engineering", "DevOps"],
    "agent-2": [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders table headers", () => {
    render(
      <AgentList
        initialAgents={mockAgents}
        initialGroupMemberships={mockGroupMemberships}
        isAdmin={false}
      />
    );
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("Groups")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
  });

  it("renders agent display names", () => {
    render(
      <AgentList
        initialAgents={mockAgents}
        initialGroupMemberships={mockGroupMemberships}
        isAdmin={false}
      />
    );
    expect(screen.getByText("My Agent")).toBeInTheDocument();
    expect(screen.getByText("Auto Bot")).toBeInTheDocument();
  });

  it("renders agent IDs in monospace text", () => {
    render(
      <AgentList
        initialAgents={mockAgents}
        initialGroupMemberships={mockGroupMemberships}
        isAdmin={false}
      />
    );
    expect(screen.getByText("agent-1")).toBeInTheDocument();
    expect(screen.getByText("agent-2")).toBeInTheDocument();
  });

  it("renders type badges for each agent", () => {
    render(
      <AgentList
        initialAgents={mockAgents}
        initialGroupMemberships={mockGroupMemberships}
        isAdmin={false}
      />
    );
    expect(screen.getByText("User Proxy")).toBeInTheDocument();
    expect(screen.getByText("Autonomous")).toBeInTheDocument();
  });

  it("renders group names for agents with groups", () => {
    render(
      <AgentList
        initialAgents={mockAgents}
        initialGroupMemberships={mockGroupMemberships}
        isAdmin={false}
      />
    );
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("DevOps")).toBeInTheDocument();
  });

  it("renders dash for agents with no groups", () => {
    render(
      <AgentList
        initialAgents={mockAgents}
        initialGroupMemberships={mockGroupMemberships}
        isAdmin={false}
      />
    );
    // agent-2 has no groups, so there should be a "-" 
    const dashes = screen.getAllByText("-");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("shows empty state when no agents are provided", () => {
    render(
      <AgentList
        initialAgents={[]}
        initialGroupMemberships={{}}
        isAdmin={false}
      />
    );
    expect(
      screen.getByText("You have not registered any agents yet.")
    ).toBeInTheDocument();
  });

  it("shows admin-specific empty state for admin users with no agents", () => {
    render(
      <AgentList
        initialAgents={[]}
        initialGroupMemberships={{}}
        isAdmin={true}
      />
    );
    expect(
      screen.getByText("No agents registered in this tenant.")
    ).toBeInTheDocument();
  });

  it("renders Owner column when admin", () => {
    render(
      <AgentList
        initialAgents={mockAgents}
        initialGroupMemberships={mockGroupMemberships}
        isAdmin={true}
      />
    );
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("does not render Owner column for non-admin", () => {
    render(
      <AgentList
        initialAgents={mockAgents}
        initialGroupMemberships={mockGroupMemberships}
        isAdmin={false}
      />
    );
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
  });

  it("navigates to agent detail on row click", async () => {
    const user = userEvent.setup();
    render(
      <AgentList
        initialAgents={[mockAgents[0]]}
        initialGroupMemberships={mockGroupMemberships}
        isAdmin={false}
      />
    );

    const rowLink = screen.getByRole("link", { name: /my agent/i });
    await user.click(rowLink);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/agents/agent-1");
    });
  });
});
