// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders badge with text content", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders badge with default variant", () => {
    render(<Badge>Default</Badge>);
    const badge = screen.getByText("Default");
    expect(badge).toHaveAttribute("data-variant", "default");
  });

  it("renders badge with secondary variant", () => {
    render(<Badge variant="secondary">Secondary</Badge>);
    const badge = screen.getByText("Secondary");
    expect(badge).toHaveAttribute("data-variant", "secondary");
  });

  it("renders badge with destructive variant", () => {
    render(<Badge variant="destructive">Error</Badge>);
    const badge = screen.getByText("Error");
    expect(badge).toHaveAttribute("data-variant", "destructive");
  });

  it("renders badge with outline variant", () => {
    render(<Badge variant="outline">Outline</Badge>);
    const badge = screen.getByText("Outline");
    expect(badge).toHaveAttribute("data-variant", "outline");
  });

  it("renders badge with ghost variant", () => {
    render(<Badge variant="ghost">Ghost</Badge>);
    const badge = screen.getByText("Ghost");
    expect(badge).toHaveAttribute("data-variant", "ghost");
  });

  it("renders badge with link variant", () => {
    render(<Badge variant="link">Link</Badge>);
    const badge = screen.getByText("Link");
    expect(badge).toHaveAttribute("data-variant", "link");
  });

  it("applies custom className", () => {
    render(<Badge className="custom-badge">Custom</Badge>);
    expect(screen.getByText("Custom")).toHaveClass("custom-badge");
  });

  it("applies data-slot attribute", () => {
    render(<Badge>Slotted</Badge>);
    expect(screen.getByText("Slotted")).toHaveAttribute("data-slot", "badge");
  });
});
