import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const sendAnalyticsEvent = vi.fn();
vi.mock("@/lib/analytics/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/browser")>()),
  sendAnalyticsEvent: (...args: unknown[]) => sendAnalyticsEvent(...args),
}));

import { RetailLinkButton } from "@/components/catalog/retail-link-button";

afterEach(() => {
  cleanup();
  sendAnalyticsEvent.mockReset();
});

describe("RetailLinkButton", () => {
  it("is an outbound sponsored link that reports the click and keeps its href", async () => {
    render(<RetailLinkButton bookId="b1" href="https://shopee.vn/x?utm_source=infinitybookspress" label="Shopee" locale="vi" retailer="shopee" />);
    const link = screen.getByRole("link", { name: "Shopee" });
    expect(link).toHaveAttribute("href", "https://shopee.vn/x?utm_source=infinitybookspress");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "nofollow noopener sponsored");
    await userEvent.setup().click(link);
    expect(sendAnalyticsEvent).toHaveBeenCalledWith({ eventName: "click_external_store", bookId: "b1", retailer: "shopee", locale: "vi" });
  });

  it("never blocks navigation on the beacon", () => {
    render(<RetailLinkButton bookId="b1" href="https://shopee.vn/x" label="Shopee" locale="vi" retailer="shopee" />);
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.click(screen.getByRole("link", { name: "Shopee" }))).toBe(true);
    expect(sendAnalyticsEvent).toHaveBeenCalledTimes(1);
    expect(sendAnalyticsEvent).toHaveBeenCalledWith({ eventName: "click_external_store", bookId: "b1", retailer: "shopee", locale: "vi" });
  });
});
