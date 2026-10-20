// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/reader/quotes/route";
import { createSharedQuote, SharedQuoteCapError, SharedQuoteRefusedError } from "@/lib/data/shared-quotes";
import { requireReaderRequestContext, ReaderRequestUnauthorizedError } from "@/lib/reader/request-context";

vi.mock("@/lib/reader/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reader/request-context")>()),
  requireReaderRequestContext: vi.fn(),
}));
vi.mock("@/lib/data/shared-quotes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/shared-quotes")>()),
  createSharedQuote: vi.fn(),
}));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: () => ({ siteUrl: "https://books.example" }) }));

const PUB = "40000000-0000-4000-8000-000000000001";
const context = { profileId: "p1", publicationId: PUB, publicationVersion: 1, sessionId: "s1" };
const card = { id: "q1", code: "AbCdEfGh12", quote: "x", locale: "vi" as const, bookId: "b1", createdAt: "" };

function post(body: unknown, publicationId = PUB) {
  return POST(new NextRequest(`http://localhost/api/reader/quotes?publicationId=${publicationId}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireReaderRequestContext).mockResolvedValue(context);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/reader/quotes", () => {
  it("creates the card with the authorized publication and returns the absolute card URL", async () => {
    vi.mocked(createSharedQuote).mockResolvedValue(card);
    const response = await post({ quote: "Một câu.", locale: "vi" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ code: "AbCdEfGh12", url: "https://books.example/vi/q/AbCdEfGh12" });
    expect(createSharedQuote).toHaveBeenCalledWith(PUB, "Một câu.", "vi");
  });

  it("truncates to 300 graphemes before the database sees it", async () => {
    vi.mocked(createSharedQuote).mockResolvedValue(card);
    // Decomposed e + combining circumflex + combining acute: 3 code points, 1 grapheme.
    const cluster = "ế";
    await post({ quote: cluster.repeat(301), locale: "vi" });
    expect(vi.mocked(createSharedQuote).mock.calls[0][1]).toBe(cluster.repeat(300));
  });

  it.each([
    ["empty", { quote: "  ", locale: "vi" }],
    ["html", { quote: "<b>x</b>", locale: "vi" }],
    ["bad locale", { quote: "x", locale: "fr" }],
    ["extra key", { quote: "x", locale: "vi", bookId: "b1" }],
  ])("returns 400 for %s", async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(createSharedQuote).not.toHaveBeenCalled();
  });

  it("returns 409 at the cap and 502 when refused", async () => {
    vi.mocked(createSharedQuote).mockRejectedValueOnce(new SharedQuoteCapError());
    expect((await post({ quote: "x", locale: "vi" })).status).toBe(409);
    vi.mocked(createSharedQuote).mockRejectedValueOnce(new SharedQuoteRefusedError());
    expect((await post({ quote: "x", locale: "vi" })).status).toBe(502);
  });

  it("returns 401 without a session and never calls the database", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestUnauthorizedError());
    expect((await post({ quote: "x", locale: "vi" })).status).toBe(401);
    expect(createSharedQuote).not.toHaveBeenCalled();
  });
});
