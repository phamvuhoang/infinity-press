// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { computeAlignmentsForBook } from "@/lib/data/alignments";
import { alignChunks } from "@/lib/epub/align";

type Row = Record<string, unknown>;

// A chainable stand-in for the few PostgREST calls the module makes: filters by eq() and resolves
// to the table's rows.
function fakeClient(tables: Record<string, Row[]>) {
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const from = (table: string) => {
    let rows = tables[table] ?? [];
    const builder = {
      select: () => builder,
      not: () => builder,
      order: () => builder,
      range: () => builder,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return builder;
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
    };
    return builder;
  };
  return { client: { from, rpc } as never, rpc };
}

const chunk = (publication_id: string, id: string, href: string, ordinal: number, plain_text: string) => ({
  publication_id,
  id,
  href,
  ordinal,
  plain_text,
});

describe("computeAlignmentsForBook", () => {
  it("replaces each direction's alignments with alignChunks' pairs", async () => {
    const enChunks = [chunk("pub-en", "en-0", "a", 0, "one"), chunk("pub-en", "en-1", "a", 1, "two")];
    const viChunks = [chunk("pub-vi", "vi-0", "x", 0, "một"), chunk("pub-vi", "vi-1", "x", 1, "hai")];
    const { client, rpc } = fakeClient({
      editions: [
        { book_id: "book-1", active_publication_id: "pub-en" },
        { book_id: "book-1", active_publication_id: "pub-vi" },
      ],
      ebook_search_chunks: [...enChunks, ...viChunks],
    });

    const runs = await computeAlignmentsForBook("book-1", client);

    const toAlign = (rows: typeof enChunks) => rows.map((row) => ({ id: row.id, href: row.href, ordinal: row.ordinal, length: row.plain_text.length }));
    expect(rpc).toHaveBeenNthCalledWith(1, "replace_passage_alignments", {
      p_book_id: "book-1",
      p_source_publication_id: "pub-en",
      p_target_publication_id: "pub-vi",
      p_pairs: alignChunks(toAlign(enChunks), toAlign(viChunks)).pairs,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "replace_passage_alignments", expect.objectContaining({
      p_source_publication_id: "pub-vi",
      p_target_publication_id: "pub-en",
    }));
    expect(runs).toEqual([
      { sourcePublicationId: "pub-en", targetPublicationId: "pub-vi", pairs: 2, coverage: 1 },
      { sourcePublicationId: "pub-vi", targetPublicationId: "pub-en", pairs: 2, coverage: 1 },
    ]);
  });

  it("makes no RPC call for a book with one live edition", async () => {
    const { client, rpc } = fakeClient({ editions: [{ book_id: "book-1", active_publication_id: "pub-en" }] });
    await expect(computeAlignmentsForBook("book-1", client)).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});
