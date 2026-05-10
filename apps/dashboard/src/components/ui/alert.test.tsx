// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

describe("Alert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders alert with title and description", () => {
    render(
      <Alert>
        <AlertTitle>Heads up!</AlertTitle>
        <AlertDescription>This is an alert description.</AlertDescription>
      </Alert>
    );

    expect(screen.getByText("Heads up!")).toBeInTheDocument();
    expect(screen.getByText("This is an alert description.")).toBeInTheDocument();
  });

  it("has role alert for accessibility", () => {
    render(
      <Alert>
        <AlertTitle>Notice</AlertTitle>
      </Alert>
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
  });

  it("renders default variant", () => {
    render(
      <Alert>
        <AlertTitle>Default Alert</AlertTitle>
      </Alert>
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-slot", "alert");
  });

  it("renders destructive variant", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Error!</AlertTitle>
        <AlertDescription>Something went wrong.</AlertDescription>
      </Alert>
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByText("Error!")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(
      <Alert className="my-alert">
        <AlertTitle>Custom</AlertTitle>
      </Alert>
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("my-alert");
  });
});
