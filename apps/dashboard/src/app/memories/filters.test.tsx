// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import { MemoryFilters } from "./filters";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockReplace = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, refresh: vi.fn() }),
  usePathname: () => "/memories",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Loader2: () => <span data-testid="icon-loader" />,
  X: () => <span data-testid="icon-x" />,
}));

// Mock the Shadcn Select component with a native <select> for testability
vi.mock("@/components/ui/select", () => {
  const React = require("react");
  const SelectContext = React.createContext({ value: "", onValueChange: (_value: string) => {} });

  return {
    Select: ({ children, value, onValueChange }: any) => (
      <SelectContext.Provider value={{ value, onValueChange: onValueChange ?? (() => {}) }}>
        <select
          data-testid="mock-select"
          value={value}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onValueChange?.(e.target.value)}
        >
          {children}
        </select>
      </SelectContext.Provider>
    ),
    SelectContent: ({ children }: any) => <>{children}</>,
    SelectItem: ({ children, value }: any) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
  };
});

// Mock checkbox as a simple input
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ id, checked, onCheckedChange }: any) => (
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onCheckedChange?.(e.target.checked)}
      data-testid={`checkbox-${id}`}
    />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

describe("MemoryFilters", () => {
  const defaultGroups = [
    { id: "group-1", name: "Engineering" },
    { id: "group-2", name: "Marketing" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Memory Type filter label", () => {
    render(
      <MemoryFilters
        groups={defaultGroups}
        initialIncludeUser={false}
        initialIncludePrivate={false}
      />
    );
    expect(screen.getByText("Memory Type")).toBeInTheDocument();
  });

  it("renders the Group filter label", () => {
    render(
      <MemoryFilters
        groups={defaultGroups}
        initialIncludeUser={false}
        initialIncludePrivate={false}
      />
    );
    expect(screen.getByText("Group")).toBeInTheDocument();
  });

  it("renders Include User checkbox", () => {
    render(
      <MemoryFilters
        groups={defaultGroups}
        initialIncludeUser={false}
        initialIncludePrivate={false}
      />
    );
    expect(screen.getByTestId("checkbox-includeUser")).toBeInTheDocument();
  });

  it("renders Include Private checkbox", () => {
    render(
      <MemoryFilters
        groups={defaultGroups}
        initialIncludeUser={false}
        initialIncludePrivate={false}
      />
    );
    expect(screen.getByTestId("checkbox-includePrivate")).toBeInTheDocument();
  });

  it("renders group options in the select", () => {
    render(
      <MemoryFilters
        groups={defaultGroups}
        initialIncludeUser={false}
        initialIncludePrivate={false}
      />
    );
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Marketing")).toBeInTheDocument();
  });

  it("renders memory type options", () => {
    render(
      <MemoryFilters
        groups={defaultGroups}
        initialIncludeUser={false}
        initialIncludePrivate={false}
      />
    );
    expect(screen.getByText("All Types")).toBeInTheDocument();
    expect(screen.getByText("Fact")).toBeInTheDocument();
    expect(screen.getByText("Preference")).toBeInTheDocument();
  });

  it("does not show Clear Filters when no filters are active and no query params", () => {
    render(
      <MemoryFilters
        groups={defaultGroups}
        initialIncludeUser={false}
        initialIncludePrivate={false}
      />
    );
    expect(screen.queryByText("Clear Filters")).not.toBeInTheDocument();
  });

  it("shows Clear Filters when initialType is set", () => {
    render(
      <MemoryFilters
        groups={defaultGroups}
        initialType="fact" as any
        initialIncludeUser={false}
        initialIncludePrivate={false}
      />
    );
    expect(screen.getByText("Clear Filters")).toBeInTheDocument();
  });
});
