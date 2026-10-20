// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/catalog/books/[bookId]/action-state/route";
import { getBookActionState, getBookCardById } from "@/lib/data/catalog";

vi.mock("@/lib/data/catalog", () => ({ getBookActionState: vi.fn(), getBookCardById: vi.fn() }));

const BOOK_ID = "e40dae04-b8de-43bd-9545-c56f86b25971";

function request(locale?: string) {
  return new Request(locale ? `http://t/?locale=${locale}` : "http://t/");
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
});
