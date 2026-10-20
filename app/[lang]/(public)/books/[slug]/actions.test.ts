// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buyEbookAction, getFreeEbookAction } from "@/app/[lang]/(public)/books/[slug]/actions";
import { acquireFreeEdition, EmailNotVerifiedError, NoFreeOfferError } from "@/lib/access/grant";
import { trackEventBestEffort } from "@/lib/analytics/events";
import { requireUser } from "@/lib/auth/session";
import {
  AlreadyOwnedError,
  CurrencyNotPayableError,
  EditionRequiredError,
  NotPurchasableError,
  OfferChangedError,
  PaymentsDisabledError,
} from "@/lib/commerce/errors";
import { createEditionOrder } from "@/lib/commerce/orders";
import { getCurrentProfile } from "@/lib/data/profiles";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ "x-request-id": "req-12345678" })) }));
vi.mock("@/lib/analytics/events", () => ({ trackEventBestEffort: vi.fn() }));
vi.mock("@/lib/data/profiles", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/commerce/orders", () => ({ createEditionOrder: vi.fn() }));
vi.mock("@/lib/access/grant", () => {
  class EmailNotVerifiedError extends Error {}
  class NoFreeOfferError extends Error {}
  return { acquireFreeEdition: vi.fn(), EmailNotVerifiedError, NoFreeOfferError };
});

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const EDITION_ID = "50000000-0000-4000-8000-000000000001";
const OFFER_ID = "60000000-0000-4000-8000-000000000001";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const PROFILE_ID = "20000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(trackEventBestEffort).mockResolvedValue(undefined);
  vi.mocked(getCurrentProfile).mockResolvedValue({ id: PROFILE_ID, auth_user_id: "auth-1", display_name: null, locale: "vi" });
});

describe("getFreeEbookAction", () => {
  it("sends the reader to the reader after a free acquisition", async () => {
    vi.mocked(acquireFreeEdition).mockResolvedValue({ entitlementId: "e1" });
    await expect(getFreeEbookAction("en", BOOK_ID, "a-book", EDITION_ID)).rejects.toThrow(`NEXT_REDIRECT /en/read/editions/${EDITION_ID}`);
    expect(requireUser).toHaveBeenCalledWith("en", "/en/books/a-book");
    expect(acquireFreeEdition).toHaveBeenCalledWith("en", EDITION_ID);
  });

  it.each([
    [new EmailNotVerifiedError(), "email-not-verified"],
    [new NoFreeOfferError(), "no-free-offer"],
    [new Error("boom"), "unexpected"],
  ])("returns to the book with an error code (%s)", async (error, code) => {
    vi.mocked(acquireFreeEdition).mockRejectedValue(error);
    await expect(getFreeEbookAction("en", BOOK_ID, "a-book", EDITION_ID)).rejects.toThrow(`NEXT_REDIRECT /en/books/a-book?action-error=${code}`);
  });

  it("redirects home for an invalid locale or book ID without acquiring", async () => {
    await expect(getFreeEbookAction("fr", BOOK_ID, "a-book", EDITION_ID)).rejects.toThrow("NEXT_REDIRECT /en");
    await expect(getFreeEbookAction("en", "not-a-uuid", "a-book", EDITION_ID)).rejects.toThrow("NEXT_REDIRECT /en");
    expect(acquireFreeEdition).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure", async () => {
    vi.mocked(acquireFreeEdition).mockRejectedValue(new Error("boom"));
    await expect(getFreeEbookAction("en", BOOK_ID, "a-book", EDITION_ID)).rejects.toThrow(`NEXT_REDIRECT /en/books/a-book?action-error=unexpected`);
    expect(console.error).toHaveBeenCalledWith("Get free ebook failed.", expect.objectContaining({ bookId: BOOK_ID }));
  });

  it("does not log a typed error", async () => {
    vi.mocked(acquireFreeEdition).mockRejectedValue(new EmailNotVerifiedError());
    await expect(getFreeEbookAction("en", BOOK_ID, "a-book", EDITION_ID)).rejects.toThrow(
      `NEXT_REDIRECT /en/books/a-book?action-error=email-not-verified`,
    );
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("buyEbookAction", () => {
  it("sends the reader to checkout for the new order", async () => {
    vi.mocked(createEditionOrder).mockResolvedValue({ orderId: ORDER_ID });
    await expect(buyEbookAction("vi", BOOK_ID, "mot-cuon-sach", EDITION_ID, OFFER_ID, 129000)).rejects.toThrow(`NEXT_REDIRECT /vi/checkout/${ORDER_ID}`);
    expect(createEditionOrder).toHaveBeenCalledWith("vi", EDITION_ID, OFFER_ID, 129000);
  });

  it("sends an owner to the reader", async () => {
    vi.mocked(createEditionOrder).mockRejectedValue(new AlreadyOwnedError());
    await expect(buyEbookAction("en", BOOK_ID, "a-book", EDITION_ID, OFFER_ID, 129000)).rejects.toThrow(`NEXT_REDIRECT /en/read/editions/${EDITION_ID}`);
  });

  it.each([
    [new EmailNotVerifiedError(), "email-not-verified"],
    [new PaymentsDisabledError(), "payments-unavailable"],
    [new NotPurchasableError(), "not-purchasable"],
    [new CurrencyNotPayableError(), "currency-unavailable"],
    [new EditionRequiredError(), "choose-edition"],
    [new OfferChangedError(), "price-changed"],
    [new Error("boom"), "unexpected"],
  ])("returns to the book with an error code (%s)", async (error, code) => {
    vi.mocked(createEditionOrder).mockRejectedValue(error);
    await expect(buyEbookAction("en", BOOK_ID, "a-book", EDITION_ID, OFFER_ID, 129000)).rejects.toThrow(`NEXT_REDIRECT /en/books/a-book?action-error=${code}`);
  });

  it("logs an unexpected failure", async () => {
    vi.mocked(createEditionOrder).mockRejectedValue(new Error("boom"));
    await expect(buyEbookAction("en", BOOK_ID, "a-book", EDITION_ID, OFFER_ID, 129000)).rejects.toThrow("NEXT_REDIRECT");
    expect(console.error).toHaveBeenCalledWith("Buy ebook failed.", expect.objectContaining({ bookId: BOOK_ID }));
  });

  it("records begin_checkout for the order after it exists", async () => {
    vi.mocked(createEditionOrder).mockResolvedValue({ orderId: ORDER_ID });

    await expect(buyEbookAction("vi", BOOK_ID, "mot-cuon-sach", EDITION_ID, OFFER_ID, 129000)).rejects.toThrow(`NEXT_REDIRECT /vi/checkout/${ORDER_ID}`);

    expect(trackEventBestEffort).toHaveBeenCalledExactlyOnceWith(
      {
        eventName: "begin_checkout",
        dedupeKey: `checkout/${ORDER_ID}`,
        profileId: PROFILE_ID,
        bookId: BOOK_ID,
        orderId: ORDER_ID,
        locale: "vi",
      },
      { requestId: "req-12345678" },
    );
    expect(vi.mocked(createEditionOrder).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(trackEventBestEffort).mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["the event write rejects", () => vi.mocked(trackEventBestEffort).mockRejectedValue(new Error("analytics down"))],
    ["the profile lookup throws", () => vi.mocked(getCurrentProfile).mockRejectedValue(new Error("auth down"))],
  ])("still sends the reader to checkout when %s", async (_label, breakAnalytics) => {
    vi.mocked(createEditionOrder).mockResolvedValue({ orderId: ORDER_ID });
    breakAnalytics();

    await expect(buyEbookAction("en", BOOK_ID, "a-book", EDITION_ID, OFFER_ID, 129000)).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}`);
  });

  it.each([
    [new AlreadyOwnedError()],
    [new NotPurchasableError()],
    [new Error("boom")],
  ])("records no checkout when no order was created (%s)", async (error) => {
    vi.mocked(createEditionOrder).mockRejectedValue(error);

    await expect(buyEbookAction("en", BOOK_ID, "a-book", EDITION_ID, OFFER_ID, 129000)).rejects.toThrow("NEXT_REDIRECT");

    expect(trackEventBestEffort).not.toHaveBeenCalled();
  });

  it("uses the catalog page when the slug is not a slug", async () => {
    vi.mocked(createEditionOrder).mockRejectedValue(new NotPurchasableError());
    await expect(buyEbookAction("en", BOOK_ID, "../evil", EDITION_ID, OFFER_ID, 129000)).rejects.toThrow("NEXT_REDIRECT /en/books");
  });

  // The edition, the offer and the price the reader saw all come from the page they were looking at,
  // and come back from the browser: anything that is not exactly what the page could have sent goes
  // home without touching the database.
  it.each([
    ["an edition that is not a uuid", ["en", BOOK_ID, "a-book", "nope", OFFER_ID, 1000]],
    ["an offer that is not a uuid", ["en", BOOK_ID, "a-book", EDITION_ID, "nope", 1000]],
    ["a fractional price", ["en", BOOK_ID, "a-book", EDITION_ID, OFFER_ID, 10.5]],
    ["a negative price", ["en", BOOK_ID, "a-book", EDITION_ID, OFFER_ID, -1]],
    ["a price beyond the safe range", ["en", BOOK_ID, "a-book", EDITION_ID, OFFER_ID, Number.MAX_SAFE_INTEGER + 2]],
  ] as const)("refuses %s before ordering anything", async (_label, args) => {
    await expect(buyEbookAction(...(args as unknown as Parameters<typeof buyEbookAction>))).rejects.toThrow("NEXT_REDIRECT /en");
    expect(createEditionOrder).not.toHaveBeenCalled();
  });
});
