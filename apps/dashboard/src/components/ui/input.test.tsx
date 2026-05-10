// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import { Input } from "@/components/ui/input";

describe("Input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders input element", () => {
    render(<Input />);
    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("data-slot", "input");
  });

  it("renders input associated with a label", () => {
    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" type="email" />
      </>
    );

    const input = screen.getByLabelText("Email");
    expect(input).toBeInTheDocument();
  });

  it("handles text input via userEvent", async () => {
    const user = userEvent.setup();
    render(<Input />);

    const input = screen.getByRole("textbox");
    await user.type(input, "Hello World");
    expect(input).toHaveValue("Hello World");
  });

  it("renders with placeholder text", () => {
    render(<Input placeholder="Enter your name" />);
    const input = screen.getByPlaceholderText("Enter your name");
    expect(input).toBeInTheDocument();
  });

  it("supports disabled state", () => {
    render(<Input disabled placeholder="Disabled input" />);
    const input = screen.getByPlaceholderText("Disabled input");
    expect(input).toBeDisabled();
  });

  it("supports type attribute", () => {
    render(<Input type="password" placeholder="Password" />);
    const input = screen.getByPlaceholderText("Password");
    expect(input).toHaveAttribute("type", "password");
  });

  it("applies custom className", () => {
    render(<Input className="my-input-class" />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveClass("my-input-class");
  });
});
