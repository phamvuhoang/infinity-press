// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSharedQuote, getSharedQuote, listMySharedQuotes, removeMySharedQuote, SharedQuoteCapError, SharedQuoteRefusedError } from "@/lib/data/shared-quotes";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/public", () => ({ createPublicClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const PUB_ID = "40000000-0000-4000-8000-000000000001";
const base = { id: "90000000-0000-4000-8000-000000000001", code: "AbCdEfGh12", quote: "Một câu.", locale: "vi", bookId: "30000000-0000-4000-8000-000000000001", createdAt: "2026-10-09T00:00:00+00:00" };
const card = { ...base, chunkOrdinal: null, question: null, textKind: "verbatim" };
const publicCard = { ...card, editionId: "10000000-0000-4000-8000-000000000001", chunkExists: false, sampleAllowsChunk: false, languages: [] };

function rpcResult(data: unknown, error: { code?: string; message?: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  vi.mocked(createClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof createClient>>);
  vi.mocked(createPublicClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createPublicClient>);
  return rpc;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("shared quote DAL", () => {
  it("creates through the publication and returns the card", async () => {
    const rpc = rpcResult(card);
    expect(await createSharedQuote(PUB_ID, { quote: "Một câu.", locale: "vi", textKind: "verbatim" })).toEqual(card);
    expect(rpc).toHaveBeenCalledWith("create_shared_quote", { p_publication_id: PUB_ID, p_quote: "Một câu.", p_locale: "vi", p_text_kind: "verbatim" });
  });

  it("passes the question, the kind, and the chunk the locator falls in", async () => {
    const rpc = vi.fn(async (name: string) => ({ data: name === "reader_chunk_for_locator" ? 7 : { ...card, chunkOrdinal: 7, question: "Vì sao?", textKind: "paraphrase" }, error: null }));
    vi.mocked(createClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof createClient>>);
    const created = await createSharedQuote(PUB_ID, { quote: "Một câu.", locale: "vi", question: "Vì sao?", textKind: "paraphrase", locator: { href: "OEBPS/c1.xhtml", progression: 0.4 } });
    expect(created.chunkOrdinal).toBe(7);
    expect(rpc).toHaveBeenNthCalledWith(1, "reader_chunk_for_locator", { p_publication_id: PUB_ID, p_href: "OEBPS/c1.xhtml", p_progression: 0.4 });
    expect(rpc).toHaveBeenNthCalledWith(2, "create_shared_quote", { p_publication_id: PUB_ID, p_quote: "Một câu.", p_locale: "vi", p_text_kind: "paraphrase", p_question: "Vì sao?", p_chunk_ordinal: 7 });
  });

  it("shares without an anchor when the chunk lookup fails or finds nothing", async () => {
    for (const lookup of [{ data: null, error: { code: "XX000" } }, { data: null, error: null }]) {
      const rpc = vi.fn(async (name: string) => (name === "reader_chunk_for_locator" ? lookup : { data: card, error: null }));
      vi.mocked(createClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof createClient>>);
      await createSharedQuote(PUB_ID, { quote: "x", locale: "vi", textKind: "verbatim", locator: { href: "c1", progression: 0 } });
      expect(rpc).toHaveBeenLastCalledWith("create_shared_quote", { p_publication_id: PUB_ID, p_quote: "x", p_locale: "vi", p_text_kind: "verbatim" });
    }
  });

  it("maps EB038 to the cap error and EB039 to the refused error", async () => {
    rpcResult(null, { code: "EB038" });
    await expect(createSharedQuote(PUB_ID, { quote: "x", locale: "vi", textKind: "verbatim" })).rejects.toBeInstanceOf(SharedQuoteCapError);
    rpcResult(null, { code: "EB039" });
    await expect(createSharedQuote(PUB_ID, { quote: "x", locale: "vi", textKind: "verbatim" })).rejects.toBeInstanceOf(SharedQuoteRefusedError);
  });

  it("reads a public card, returns null for an unknown code, and logs an unparseable payload", async () => {
    const rpc = rpcResult(publicCard);
    expect(await getSharedQuote("AbCdEfGh12")).toEqual(publicCard);
    expect(rpc).toHaveBeenCalledWith("catalog_shared_quote", { p_code: "AbCdEfGh12" });
    rpcResult(null);
    expect(await getSharedQuote("nope000000")).toBeNull();
    rpcResult({ id: 1, quote: "secret text" });
    await expect(getSharedQuote("bad0000000")).rejects.toThrow("getSharedQuote failed.");
    expect(console.error).toHaveBeenCalledWith("Shared quote operation failed.", { operation: "getSharedQuote", code: "invalid_response", requestId: expect.any(String) });
  });

  it("refuses to look up a malformed code without calling the database", async () => {
    const rpc = rpcResult(card);
    expect(await getSharedQuote("../etc")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("lists the owner's cards with view counts and removes by code", async () => {
    const list = rpcResult([{ ...base, bookTitle: "Sách", viewCount: 3 }]);
    expect(await listMySharedQuotes()).toEqual([{ ...base, bookTitle: "Sách", viewCount: 3 }]);
    expect(list).toHaveBeenCalledWith("my_shared_quotes", {});
    const remove = rpcResult(null);
    await removeMySharedQuote("AbCdEfGh12");
    expect(remove).toHaveBeenCalledWith("remove_shared_quote", { p_code: "AbCdEfGh12" });
  });
});
