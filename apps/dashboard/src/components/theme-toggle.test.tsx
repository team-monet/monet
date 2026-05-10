// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./theme-toggle";

// Mock lucide-react icons as simple SVG elements with data-testid
vi.mock("lucide-react", () => ({
  Moon: () => <svg data-testid="icon-moon" />,
  Sun: () => <svg data-testid="icon-sun" />,
}));

// Mock the Button UI component as a plain button
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));

describe("ThemeToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a button element", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
  });

  it("shows moon icon before mount (defaulting to light mode)", () => {
    render(<ThemeToggle />);
    const moonIcon = screen.getByTestId("icon-moon");
    expect(moonIcon).toBeInTheDocument();
  });

  it("shows 'Switch to dark mode' label before mount in light mode", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", "Switch to dark mode");
  });

  it("applies dark theme to document and shows sun icon after toggling", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    // Wait for useEffect to run (initial mount)
    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Switch to dark mode");
    });

    // Click to toggle to dark mode
    await user.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Switch to light mode");
    });

    expect(screen.getByTestId("icon-sun")).toBeInTheDocument();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("persists theme in localStorage after toggling", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Switch to dark mode");
    });

    await user.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(window.localStorage.getItem("theme")).toBe("dark");
    });
  });

  it("toggles back to light mode on second click", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Switch to dark mode");
    });

    // Click to dark
    await user.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Switch to light mode");
    });

    // Click back to light
    await user.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Switch to dark mode");
    });

    expect(screen.getByTestId("icon-moon")).toBeInTheDocument();
  });

  it("respects saved localStorage theme on initial render", async () => {
    window.localStorage.setItem("theme", "dark");

    render(<ThemeToggle />);

    // After mount, the component should read "dark" from localStorage
    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Switch to light mode");
    });
  });

  it("respects system dark mode preference when no saved theme", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<ThemeToggle />);

    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Switch to light mode");
    });
  });
});
