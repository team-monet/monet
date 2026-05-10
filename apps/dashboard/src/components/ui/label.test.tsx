// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

describe("Label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders label text", () => {
    render(<Label>Username</Label>);
    expect(screen.getByText("Username")).toBeInTheDocument();
  });

  it("associates label with input via htmlFor", () => {
    render(
      <>
        <Label htmlFor="username">Username</Label>
        <Input id="username" />
      </>
    );

    const label = screen.getByText("Username");
    expect(label).toHaveAttribute("for", "username");

    // Verify the label points to the input
    const input = screen.getByLabelText("Username");
    expect(input).toBeInTheDocument();
  });

  it("applies data-slot attribute", () => {
    render(<Label>Email</Label>);
    const label = screen.getByText("Email");
    expect(label).toHaveAttribute("data-slot", "label");
  });
});
