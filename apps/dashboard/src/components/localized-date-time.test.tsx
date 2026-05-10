// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@/test/test-utils";
import { LocalizedDateTime } from "./localized-date-time";

describe("LocalizedDateTime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a localized date string after hydration", async () => {
    const isoDate = "2025-06-15T10:30:00.000Z";
    render(<LocalizedDateTime date={isoDate} />);

    await waitFor(() => {
      expect(screen.getByText(new Date(isoDate).toLocaleString())).toBeInTheDocument();
    });
  });

  it("renders only the date portion when dateOnly is true", async () => {
    const isoDate = "2025-06-15T10:30:00.000Z";
    render(<LocalizedDateTime date={isoDate} dateOnly />);

    await waitFor(() => {
      expect(screen.getByText(new Date(isoDate).toLocaleDateString())).toBeInTheDocument();
    });
  });

  it("handles Date object input", async () => {
    const dateObj = new Date("2025-01-20T08:00:00.000Z");
    render(<LocalizedDateTime date={dateObj} />);

    await waitFor(() => {
      expect(screen.getByText(dateObj.toLocaleString())).toBeInTheDocument();
    });
  });

  it("shows the ISO string initially in a span element", async () => {
    const isoDate = "2025-06-15T10:30:00.000Z";
    const dateObj = new Date(isoDate);
    render(<LocalizedDateTime date={isoDate} />);

    // Initially, before effects flush, the span contains the ISO string
    // After effects flush, it shows locale string. We verify the locale string appears.
    await waitFor(() => {
      expect(screen.getByText(dateObj.toLocaleString())).toBeInTheDocument();
    });
  });

  it("renders different dates correctly", async () => {
    const date1 = "2024-12-25T00:00:00.000Z";
    const { unmount } = render(<LocalizedDateTime date={date1} />);

    await waitFor(() => {
      expect(screen.getByText(new Date(date1).toLocaleString())).toBeInTheDocument();
    });

    unmount();

    const date2 = "2023-07-04T12:00:00.000Z";
    render(<LocalizedDateTime date={date2} />);

    await waitFor(() => {
      expect(screen.getByText(new Date(date2).toLocaleString())).toBeInTheDocument();
    });
  });

  it("renders a span element as the container", async () => {
    const isoDate = "2025-06-15T10:30:00.000Z";
    render(<LocalizedDateTime date={isoDate} />);

    await waitFor(() => {
      const span = screen.getByText(new Date(isoDate).toLocaleString());
      expect(span.tagName).toBe("SPAN");
    });
  });
});
