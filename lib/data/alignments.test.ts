// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { computeAlignmentsForBook } from "@/lib/data/alignments";
import { alignChunks, type AlignChunk } from "@/lib/epub/align";

type Row = Record<string, unknown>;

// A thenable that also answers the chain methods the module calls on it.
function result<T>(data: T, record?: (method: string, args: unknown[]) => void) {
  const builder: Record<string, unknown> = {
    then: (resolve: (value: { data: T; error: null }) => unknown) => resolve({ data, error: null }),
  };
  for (const method of ["select", "not", "order", "range", "eq", "or", "delete"]) {
    builder[method] = (...args: unknown[]) => {
      record?.(method, args);
      return builder;
    };
  }
  return builder;
}

function fakeClient(editions: Row[], chunks: Record<string, AlignChunk[]>) {
  const prune: Array<[string, unknown[]]> = [];
  const rpc = vi.fn((name: string, args: { p_publication_id?: string }) =>
    name === "chunk_lengths" ? result(chunks[args.p_publication_id!] ?? []) : result(null),
  );
  const from = (table: string) =>
    table === "editions" ? result(editions) : result(null, (method, args) => prune.push([method, args]));
  return { client: { from, rpc } as never, rpc, prune };
}

const en: AlignChunk[] = [
  { id: "en-0", href: "a", ordinal: 0, length: 3 },
  { id: "en-1", href: "a", ordinal: 1, length: 3 },
];
const viChunks: AlignChunk[] = [
  { id: "vi-0", href: "x", ordinal: 0, length: 3 },
  { id: "vi-1", href: "x", ordinal: 1, length: 3 },
];

describe("computeAlignmentsForBook", () => {
  it("prunes non-live pairs, then replaces each direction with alignChunks' pairs", async () => {
    const { client, rpc, prune } = fakeClient(
      [{ active_publication_id: "pub-en" }, { active_publication_id: "pub-vi" }],
      { "pub-en": en, "pub-vi": viChunks },
    );

    const runs = await computeAlignmentsForBook("book-1", client);

    expect(prune).toEqual([
      ["delete", []],
      ["eq", ["book_id", "book-1"]],
      ["or", ["source_publication_id.not.in.(pub-en,pub-vi),target_publication_id.not.in.(pub-en,pub-vi)"]],
    ]);
    expect(rpc).toHaveBeenCalledWith("chunk_lengths", { p_publication_id: "pub-en" });
    expect(rpc).toHaveBeenCalledWith("replace_passage_alignments", {
      p_book_id: "book-1",
      p_source_publication_id: "pub-en",
      p_target_publication_id: "pub-vi",
      p_pairs: alignChunks(en, viChunks).pairs,
    });
    expect(rpc).toHaveBeenCalledWith("replace_passage_alignments", expect.objectContaining({
      p_source_publication_id: "pub-vi",
      p_target_publication_id: "pub-en",
    }));
    expect(runs).toEqual([
      { sourcePublicationId: "pub-en", targetPublicationId: "pub-vi", pairs: 2, coverage: 1 },
      { sourcePublicationId: "pub-vi", targetPublicationId: "pub-en", pairs: 2, coverage: 1 },
    ]);
  });

  it("still prunes, and replaces nothing, for a book with one live edition", async () => {
    const { client, rpc, prune } = fakeClient([{ active_publication_id: "pub-en" }], { "pub-en": en });
    await expect(computeAlignmentsForBook("book-1", client)).resolves.toEqual([]);
    expect(prune.map(([method]) => method)).toEqual(["delete", "eq", "or"]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("drops every pair of a book with no live edition", async () => {
    const { client, prune } = fakeClient([], {});
    await expect(computeAlignmentsForBook("book-1", client)).resolves.toEqual([]);
    expect(prune.map(([method]) => method)).toEqual(["delete", "eq"]);
  });
});
