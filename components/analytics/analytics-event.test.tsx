import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsEvent } from "@/components/analytics/analytics-event";
import { sendAnalyticsEvent } from "@/lib/analytics/browser";

vi.mock("@/lib/analytics/browser", () => ({ sendAnalyticsEvent: vi.fn() }));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setVisibility("visible");
});

describe("AnalyticsEvent", () => {
  it("sends its event once when the page is visible, even under Strict Mode", () => {
    setVisibility("visible");

    render(
      <StrictMode>
        <AnalyticsEvent bookId={BOOK_ID} eventName="view_book" locale="vi" />
      </StrictMode>,
    );

    expect(sendAnalyticsEvent).toHaveBeenCalledExactlyOnceWith({ eventName: "view_book", bookId: BOOK_ID, locale: "vi" });
  });

  it("waits for a background tab to be shown", () => {
    setVisibility("hidden");
    render(<AnalyticsEvent eventName="view_library" locale="en" />);
    expect(sendAnalyticsEvent).not.toHaveBeenCalled();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(sendAnalyticsEvent).toHaveBeenCalledExactlyOnceWith({ eventName: "view_library", locale: "en" });
  });

  it("sends nothing for a page closed before it was ever shown", () => {
    setVisibility("hidden");
    const { unmount } = render(<AnalyticsEvent eventName="view_library" locale="en" />);
    unmount();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(sendAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("renders nothing", () => {
    const { container } = render(<AnalyticsEvent eventName="view_library" locale="en" />);
    expect(container).toBeEmptyDOMElement();
  });
});
