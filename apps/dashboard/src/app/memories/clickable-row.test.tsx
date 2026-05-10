// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import { ClickableRow } from "./clickable-row";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/memories",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/ui/table", () => ({
  TableRow: ({ children, ...props }: any) => <tr {...props}>{children}</tr>,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

describe("ClickableRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children inside a row", () => {
    render(
      <table>
        <tbody>
          <ClickableRow href="/memories/123">
            <td>Memory Content</td>
          </ClickableRow>
        </tbody>
      </table>
    );
    expect(screen.getByText("Memory Content")).toBeInTheDocument();
  });

  it("has role='link' and correct aria-label", () => {
    render(
      <table>
        <tbody>
          <ClickableRow href="/memories/123">
            <td>Test</td>
          </ClickableRow>
        </tbody>
      </table>
    );
    const row = screen.getByRole("link");
    expect(row).toHaveAttribute("aria-label", "View memory details");
  });

  it("is focusable with tabIndex=0", () => {
    render(
      <table>
        <tbody>
          <ClickableRow href="/memories/123">
            <td>Test</td>
          </ClickableRow>
        </tbody>
      </table>
    );
    const row = screen.getByRole("link");
    expect(row).toHaveAttribute("tabindex", "0");
  });

  it("navigates to the href on click", async () => {
    const user = userEvent.setup();
    render(
      <table>
        <tbody>
          <ClickableRow href="/memories/456">
            <td>Click Me</td>
          </ClickableRow>
        </tbody>
      </table>
    );

    await user.click(screen.getByText("Click Me"));
    expect(mockPush).toHaveBeenCalledWith("/memories/456");
  });

  it("navigates on Enter key press", async () => {
    const user = userEvent.setup();
    render(
      <table>
        <tbody>
          <ClickableRow href="/memories/789">
            <td>Row</td>
          </ClickableRow>
        </tbody>
      </table>
    );

    const row = screen.getByRole("link");
    row.focus();
    await user.keyboard("{Enter}");

    expect(mockPush).toHaveBeenCalledWith("/memories/789");
  });

  it("navigates on Space key press", async () => {
    const user = userEvent.setup();
    render(
      <table>
        <tbody>
          <ClickableRow href="/memories/abc">
            <td>Row</td>
          </ClickableRow>
        </tbody>
      </table>
    );

    const row = screen.getByRole("link");
    row.focus();
    await user.keyboard(" ");

    expect(mockPush).toHaveBeenCalledWith("/memories/abc");
  });

  it("does not navigate when clicking a button inside the row", async () => {
    const user = userEvent.setup();
    render(
      <table>
        <tbody>
          <ClickableRow href="/memories/should-not-navigate">
            <td>
              <button>Action</button>
            </td>
          </ClickableRow>
        </tbody>
      </table>
    );

    await user.click(screen.getByRole("button", { name: "Action" }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not navigate when clicking a link inside the row", async () => {
    const user = userEvent.setup();
    render(
      <table>
        <tbody>
          <ClickableRow href="/memories/should-not-navigate">
            <td>
              <a href="/elsewhere">Inner Link</a>
            </td>
          </ClickableRow>
        </tbody>
      </table>
    );

    await user.click(screen.getByText("Inner Link"));
    expect(mockPush).not.toHaveBeenCalled();
  });
});
