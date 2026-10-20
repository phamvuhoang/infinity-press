// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/catalog/bundles/[bundleId]/action-state/route";
import { getBundleActionState, getBundleOwnership, getPublicBundleById } from "@/lib/data/public-bundles";

vi.mock("@/lib/data/public-bundles", () => ({
  getBundleActionState: vi.fn(),
  getBundleOwnership: vi.fn(),
  getPublicBundleById: vi.fn(),
}));

const BUNDLE_ID = "40000000-0000-4000-8000-000000000001";

function request(locale?: string) {
  return new Request(locale ? `http://t/?locale=${locale}` : "http://t/");
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/catalog/bundles/[bundleId]/action-state", () => {
  it("answers with the viewer's own state", async () => {
    vi.mocked(getPublicBundleById).mockResolvedValue({
      bundleId: BUNDLE_ID,
      members: [{ bookId: "book-1" }, { bookId: "book-2" }],
      offer: { priceMinor: 199000, currency: "VND" },
    } as never);
    vi.mocked(getBundleOwnership).mockResolvedValue(1);
    vi.mocked(getBundleActionState).mockResolvedValue({ action: "buy", signedIn: true });

    const response = await GET(request("en"), { params: Promise.resolve({ bundleId: BUNDLE_ID }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "buy", signedIn: true, ownedMemberCount: 1 });
    expect(getPublicBundleById).toHaveBeenCalledWith("en", BUNDLE_ID);
    expect(getBundleActionState).toHaveBeenCalledWith({
      publishedMemberCount: 2,
      ownedMemberCount: 1,
      offer: { priceMinor: 199000, currency: "VND" },
    });
  });

  it("is a 404 for a bundle the public catalog does not show in the requested locale, rather than an oracle for hidden ids", async () => {
    vi.mocked(getPublicBundleById).mockResolvedValue(null);

    const response = await GET(request("en"), { params: Promise.resolve({ bundleId: BUNDLE_ID }) });

    expect(response.status).toBe(404);
    // This ordering is what keeps the endpoint from ever being an oracle for a hidden bundle: the
    // privileged, per-viewer read must never run before the public lookup has confirmed the bundle
    // is one a visitor could see at all.
    expect(getBundleOwnership).not.toHaveBeenCalled();
    expect(getBundleActionState).not.toHaveBeenCalled();
  });

  it("is never cached, because the answer is per viewer", async () => {
    vi.mocked(getPublicBundleById).mockResolvedValue({
      bundleId: BUNDLE_ID,
      members: [],
      offer: null,
    } as never);
    vi.mocked(getBundleOwnership).mockResolvedValue(0);
    vi.mocked(getBundleActionState).mockResolvedValue({ action: "unavailable", signedIn: false });

    const response = await GET(request("en"), { params: Promise.resolve({ bundleId: BUNDLE_ID }) });

    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("is never cached on a 400 or 404 either", async () => {
    vi.mocked(getPublicBundleById).mockResolvedValue(null);

    const notFound = await GET(request("en"), { params: Promise.resolve({ bundleId: BUNDLE_ID }) });
    expect(notFound.headers.get("cache-control")).toContain("no-store");

    const badLocale = await GET(request("fr"), { params: Promise.resolve({ bundleId: BUNDLE_ID }) });
    expect(badLocale.headers.get("cache-control")).toContain("no-store");
  });

  it("is a 400 for a missing or unsupported locale, rather than guessing one", async () => {
    const missing = await GET(request(), { params: Promise.resolve({ bundleId: BUNDLE_ID }) });
    expect(missing.status).toBe(400);

    const unsupported = await GET(request("fr"), { params: Promise.resolve({ bundleId: BUNDLE_ID }) });
    expect(unsupported.status).toBe(400);

    expect(getPublicBundleById).not.toHaveBeenCalled();
  });

  // Ruling 4: the earlier cross-locale search could resolve a bundle whose `members` belonged to a
  // different locale than the one the caller asked for, giving a wrong owned-of-total count. A
  // same-locale lookup means the count and its denominator always come from the same locale.
  it("resolves only in the locale it was asked for, not by searching for whichever locale answers first", async () => {
    vi.mocked(getPublicBundleById).mockResolvedValue({
      bundleId: BUNDLE_ID,
      members: [{ bookId: "book-1" }],
      offer: { priceMinor: 199000, currency: "VND" },
    } as never);
    vi.mocked(getBundleOwnership).mockResolvedValue(1);
    vi.mocked(getBundleActionState).mockResolvedValue({ action: "owned_bundle", signedIn: true });

    const response = await GET(request("vi"), { params: Promise.resolve({ bundleId: BUNDLE_ID }) });

    expect(getPublicBundleById).toHaveBeenCalledWith("vi", BUNDLE_ID);
    expect(getPublicBundleById).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ action: "owned_bundle", signedIn: true, ownedMemberCount: 1 });
  });
});
