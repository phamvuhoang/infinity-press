// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/catalog/books/[bookId]/action-state/route";
import { getBookActionState, getBookCardById } from "@/lib/data/catalog";
import { findBookEdition } from "@/lib/data/editions";

vi.mock("@/lib/data/catalog", () => ({ getBookActionState: vi.fn(), getBookCardById: vi.fn() }));
vi.mock("@/lib/data/editions", () => ({ findBookEdition: vi.fn() }));

const BOOK_ID = "e40dae04-b8de-43bd-9545-c56f86b25971";

const EDITION_ID = "50000000-0000-4000-8000-000000000001";

function request(locale?: string, edition?: string) {
  const query = new URLSearchParams();
  if (locale) query.set("locale", locale);
  if (edition) query.set("edition", edition);
  return new Request(`http://t/?${query}`);
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/catalog/books/[bookId]/action-state", () => {
  it("answers with the viewer's own state", async () => {
    vi.mocked(getBookCardById).mockResolvedValue({ bookId: BOOK_ID, offer: null, hasActivePublication: true } as never);
    vi.mocked(getBookActionState).mockResolvedValue({ action: "read", signedIn: true });

    const response = await GET(request("en"), { params: Promise.resolve({ bookId: BOOK_ID }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "read", signedIn: true });
    expect(getBookCardById).toHaveBeenCalledWith("en", BOOK_ID);
    expect(getBookCardById).toHaveBeenCalledTimes(1);
  });

  it("is a 404 for a book the public catalog does not show in the requested locale, rather than an oracle for hidden ids", async () => {
    vi.mocked(getBookCardById).mockResolvedValue(null);

    const response = await GET(request("en"), { params: Promise.resolve({ bookId: BOOK_ID }) });

    expect(response.status).toBe(404);
    expect(getBookActionState).not.toHaveBeenCalled();
  });

  it("is never cached, because the answer is per viewer", async () => {
    vi.mocked(getBookCardById).mockResolvedValue({ bookId: BOOK_ID, offer: null, hasActivePublication: true } as never);
    vi.mocked(getBookActionState).mockResolvedValue({ action: "buy", signedIn: false });

    const response = await GET(request("en"), { params: Promise.resolve({ bookId: BOOK_ID }) });

    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("is never cached on a 400 or 404 either", async () => {
    vi.mocked(getBookCardById).mockResolvedValue(null);

    const notFound = await GET(request("en"), { params: Promise.resolve({ bookId: BOOK_ID }) });
    expect(notFound.headers.get("cache-control")).toContain("no-store");

    const badLocale = await GET(request("fr"), { params: Promise.resolve({ bookId: BOOK_ID }) });
    expect(badLocale.headers.get("cache-control")).toContain("no-store");
  });

  it("resolves only in the locale it was asked for, not across locales", async () => {
    vi.mocked(getBookCardById).mockImplementation(async (locale) =>
      locale === "vi" ? ({ bookId: BOOK_ID, offer: null, hasActivePublication: true } as never) : null,
    );
    vi.mocked(getBookActionState).mockResolvedValue({ action: "read", signedIn: true });

    const response = await GET(request("vi"), { params: Promise.resolve({ bookId: BOOK_ID }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "read", signedIn: true });
    expect(getBookCardById).toHaveBeenCalledWith("vi", BOOK_ID);
    expect(getBookCardById).toHaveBeenCalledTimes(1);
  });

  it("is a 400 for a missing or unsupported locale, rather than guessing one", async () => {
    const missing = await GET(request(), { params: Promise.resolve({ bookId: BOOK_ID }) });
    expect(missing.status).toBe(400);

    const unsupported = await GET(request("fr"), { params: Promise.resolve({ bookId: BOOK_ID }) });
    expect(unsupported.status).toBe(400);

    expect(getBookCardById).not.toHaveBeenCalled();
  });

  describe("for one named edition", () => {
    const card = { bookId: BOOK_ID, editionId: "default-edition", offer: null, hasActivePublication: true } as never;

    it("answers for that edition, not the default one", async () => {
      vi.mocked(getBookCardById).mockResolvedValue(card);
      vi.mocked(findBookEdition).mockResolvedValue({
        editionId: EDITION_ID,
        languageCode: "ja",
        epubLanguage: "ja",
        isDefault: false,
        offer: { offerId: "o1", priceMinor: 500, currency: "JPY", listPriceMinor: null, saleEndsAt: null },
        hasSample: false,
        record: null,
      });
      vi.mocked(getBookActionState).mockResolvedValue({ action: "buy", signedIn: true });

      const response = await GET(request("en", EDITION_ID), { params: Promise.resolve({ bookId: BOOK_ID }) });

      expect(response.status).toBe(200);
      expect(findBookEdition).toHaveBeenCalledWith(BOOK_ID, "en", EDITION_ID);
      expect(getBookActionState).toHaveBeenCalledWith({
        editionId: EDITION_ID,
        offer: { offerId: "o1", priceMinor: 500, currency: "JPY", listPriceMinor: null, saleEndsAt: null },
        hasActivePublication: true,
      });
    });

    it("is a 404, not the default edition's answer, for an edition the work does not offer", async () => {
      vi.mocked(getBookCardById).mockResolvedValue(card);
      vi.mocked(findBookEdition).mockResolvedValue(null);

      const response = await GET(request("en", EDITION_ID), { params: Promise.resolve({ bookId: BOOK_ID }) });

      expect(response.status).toBe(404);
      expect(getBookActionState).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toContain("no-store");
    });

    it("is a 404 for an edition that is not an id, without asking the database", async () => {
      vi.mocked(getBookCardById).mockResolvedValue(card);

      const response = await GET(request("en", "not-a-uuid"), { params: Promise.resolve({ bookId: BOOK_ID }) });

      expect(response.status).toBe(404);
      expect(findBookEdition).not.toHaveBeenCalled();
    });
  });
});
