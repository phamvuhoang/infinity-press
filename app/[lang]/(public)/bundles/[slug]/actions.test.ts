// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buyBundleAction } from "@/app/[lang]/(public)/bundles/[slug]/actions";
import { EmailNotVerifiedError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import { AlreadyOwnedError, NotPurchasableError, PaymentsDisabledError } from "@/lib/commerce/errors";
import { createBundleOrder } from "@/lib/commerce/orders";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ "x-request-id": "req-12345678" })) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/commerce/orders", () => ({ createBundleOrder: vi.fn() }));
vi.mock("@/lib/access/grant", () => {
  class EmailNotVerifiedError extends Error {}
  return { EmailNotVerifiedError };
});

const BUNDLE_ID = "40000000-0000-4000-8000-000000000001";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("buyBundleAction", () => {
  it("sends the reader to checkout for the new order", async () => {
    vi.mocked(createBundleOrder).mockResolvedValue({ orderId: ORDER_ID });

    await expect(buyBundleAction("en", BUNDLE_ID, "starter-bundle")).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}`);
    expect(createBundleOrder).toHaveBeenCalledWith("en", BUNDLE_ID);
  });

  // The action is a POST endpoint of its own: rendering the form only for a signed-in reader is not
  // the gate, this is - and it carries the bundle page as the return path.
  it("gates on the signed-in reader, returning them to the bundle page", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT /en/sign-in"));

    await expect(buyBundleAction("en", BUNDLE_ID, "starter-bundle")).rejects.toThrow("NEXT_REDIRECT /en/sign-in");
    expect(requireUser).toHaveBeenCalledWith("en", "/en/bundles/starter-bundle");
    expect(createBundleOrder).not.toHaveBeenCalled();
  });

  // Bound arguments come back from the browser, so an unusable slug must not become a path.
  it("falls back to the catalog for a slug that is not a slug", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(buyBundleAction("en", BUNDLE_ID, "../../admin")).rejects.toThrow("NEXT_REDIRECT");
    expect(requireUser).toHaveBeenCalledWith("en", "/en/books");
  });

  it("redirects home for an invalid locale or bundle ID without creating an order", async () => {
    await expect(buyBundleAction("fr", BUNDLE_ID, "starter-bundle")).rejects.toThrow("NEXT_REDIRECT /en");
    await expect(buyBundleAction("en", "not-a-uuid", "starter-bundle")).rejects.toThrow("NEXT_REDIRECT /en");
    expect(createBundleOrder).not.toHaveBeenCalled();
  });

  // A bundle is never opened, so owning all of it sends the reader to the library rather than to a
  // reader route that has no bundle to show.
  it("sends a reader who already owns every book to their library", async () => {
    vi.mocked(createBundleOrder).mockRejectedValue(new AlreadyOwnedError());

    await expect(buyBundleAction("en", BUNDLE_ID, "starter-bundle")).rejects.toThrow("NEXT_REDIRECT /en/library");
  });

  it.each([
    [new EmailNotVerifiedError(), "email-not-verified"],
    [new PaymentsDisabledError(), "payments-unavailable"],
    [new NotPurchasableError(), "not-purchasable"],
    [new Error("boom"), "unexpected"],
  ])("returns to the bundle page with a stable error code (%s)", async (error, code) => {
    vi.mocked(createBundleOrder).mockRejectedValue(error);

    await expect(buyBundleAction("en", BUNDLE_ID, "starter-bundle")).rejects.toThrow(
      `NEXT_REDIRECT /en/bundles/starter-bundle?action-error=${code}`,
    );
  });

  it("logs only the unexpected failure, and never the reader's identity", async () => {
    vi.mocked(createBundleOrder).mockRejectedValue(new NotPurchasableError());
    await expect(buyBundleAction("en", BUNDLE_ID, "starter-bundle")).rejects.toThrow("NEXT_REDIRECT");
    expect(console.error).not.toHaveBeenCalled();

    vi.mocked(createBundleOrder).mockRejectedValue(new Error("boom"));
    await expect(buyBundleAction("en", BUNDLE_ID, "starter-bundle")).rejects.toThrow("NEXT_REDIRECT");
    expect(console.error).toHaveBeenCalledWith(
      "Buy bundle failed.",
      expect.objectContaining({ bundleId: BUNDLE_ID, requestId: "req-12345678" }),
    );
  });
});
