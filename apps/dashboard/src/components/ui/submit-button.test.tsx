// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import { SubmitButtonCore } from "@/components/ui/submit-button";

// Mock react-dom's useFormStatus
vi.mock("react-dom", () => ({
  useFormStatus: vi.fn(() => ({ pending: false })),
}));

import { useFormStatus } from "react-dom";

const mockUseFormStatus = vi.mocked(useFormStatus);

describe("SubmitButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFormStatus.mockReturnValue({ pending: false });
  });

  it("renders submit button with label", () => {
    render(<SubmitButtonCore label="Save Changes" />);
    const button = screen.getByRole("button", { name: "Save Changes" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("type", "submit");
  });

  it("renders children when not pending and no label", () => {
    render(<SubmitButtonCore>Click Me</SubmitButtonCore>);
    expect(screen.getByRole("button", { name: "Click Me" })).toBeInTheDocument();
  });

  it("shows loading state from form context (useFormStatus pending)", () => {
    mockUseFormStatus.mockReturnValue({ pending: true });
    render(<SubmitButtonCore label="Submit" pendingLabel="Submitting..." />);

    expect(screen.getByText("Submitting...")).toBeInTheDocument();
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("shows loading state from pending prop override", () => {
    render(<SubmitButtonCore label="Save" pendingLabel="Saving..." pending />);

    expect(screen.getByText("Saving...")).toBeInTheDocument();
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("shows default pending text when no pendingLabel provided", () => {
    render(<SubmitButtonCore pending />);
    expect(screen.getByText("Submitting...")).toBeInTheDocument();
  });

  it("uses label as fallback for pending text when no pendingLabel", () => {
    render(<SubmitButtonCore label="Save" pending />);
    // When pending, it shows label if no pendingLabel
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("is disabled when disabled prop is true", () => {
    render(<SubmitButtonCore label="Submit" disabled />);
    const button = screen.getByRole("button", { name: "Submit" });
    expect(button).toBeDisabled();
  });
});
