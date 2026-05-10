// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import { Textarea } from "@/components/ui/textarea";

describe("Textarea", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders textarea element", () => {
    render(<Textarea />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveAttribute("data-slot", "textarea");
  });

  it("handles text input via userEvent", async () => {
    const user = userEvent.setup();
    render(<Textarea />);

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "Hello from textarea");
    expect(textarea).toHaveValue("Hello from textarea");
  });

  it("supports disabled state", () => {
    render(<Textarea disabled />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeDisabled();
  });

  it("renders with placeholder text", () => {
    render(<Textarea placeholder="Enter description" />);
    const textarea = screen.getByPlaceholderText("Enter description");
    expect(textarea).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Textarea className="custom-textarea" />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveClass("custom-textarea");
  });
});
