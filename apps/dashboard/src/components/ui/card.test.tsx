// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";

describe("Card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Card with all sub-components", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Test Title</CardTitle>
          <CardDescription>Test Description</CardDescription>
          <CardAction>
            <button>Action</button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <p>Card body content</p>
        </CardContent>
        <CardFooter>
          <span>Footer text</span>
        </CardFooter>
      </Card>
    );

    expect(screen.getByText("Test Title")).toBeInTheDocument();
    expect(screen.getByText("Test Description")).toBeInTheDocument();
    expect(screen.getByText("Card body content")).toBeInTheDocument();
    expect(screen.getByText("Footer text")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
  });

  it("applies data-slot attributes for semantic identification", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>
    );

    expect(screen.getByText("Title").closest("[data-slot='card-title']")).toBeTruthy();
    expect(screen.getByText("Content").closest("[data-slot='card-content']")).toBeTruthy();
    expect(screen.getByText("Footer").closest("[data-slot='card-footer']")).toBeTruthy();
  });

  it("renders CardAction within CardHeader", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardAction>
            <button>Configure</button>
          </CardAction>
        </CardHeader>
      </Card>
    );

    const actionButton = screen.getByRole("button", { name: "Configure" });
    expect(actionButton).toBeInTheDocument();
    expect(actionButton.closest("[data-slot='card-action']")).toBeTruthy();
  });

  it("renders CardDescription with proper slot attribute", () => {
    render(
      <Card>
        <CardDescription>A detailed description</CardDescription>
      </Card>
    );

    const description = screen.getByText("A detailed description");
    expect(description.closest("[data-slot='card-description']")).toBeTruthy();
  });
});
