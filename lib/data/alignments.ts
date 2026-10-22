// Computes and stores passage alignments for every pair of a work's live editions. Service role:
// called by `ebook align <bookId>` (scripts/ebook.ts), by the admin recompute action after
// requireAdmin(), and best-effort after a publish. Unlike its lib/data siblings this module does not
// import "server-only", because the CLI imports it outside Next.js; createJobStoreClient (not
// lib/supabase/admin.ts) for the same reason. Never import it into browser code.
import type { SupabaseClient } from "@supabase/supabase-js";

import { alignChunks, type AlignChunk } from "@/lib/epub/align";
import { createJobStoreClient } from "@/lib/epub/job-store";
import type { Database } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;

// PostgREST caps each response at max_rows, so chunks are read a page at a time.
const PAGE_SIZE = 1000;

async function loadChunks(client: Client, publicationId: string): Promise<AlignChunk[]> {
  const chunks: AlignChunk[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    // chunk_lengths returns char_length(plain_text), so the text itself never leaves the database.
    const { data, error } = await client
      .rpc("chunk_lengths", { p_publication_id: publicationId })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`computeAlignmentsForBook: failed to load chunks (${error.code ?? "unknown"})`);
    chunks.push(...data);
    if (data.length < PAGE_SIZE) return chunks;
  }
}

export type AlignmentRun = { sourcePublicationId: string; targetPublicationId: string; pairs: number; coverage: number };

export async function computeAlignmentsForBook(bookId: string, client: Client = createJobStoreClient()): Promise<AlignmentRun[]> {
  const { data: editions, error } = await client
    .from("editions")
    .select("active_publication_id")
    .eq("book_id", bookId)
    .not("active_publication_id", "is", null)
    .order("id");
  if (error) throw new Error(`computeAlignmentsForBook: failed to load editions (${error.code ?? "unknown"})`);
  const publicationIds = editions.flatMap((edition) => (edition.active_publication_id ? [edition.active_publication_id] : []));

  // Pairs left from a publication that is no longer live are dropped first, even when fewer than two
  // editions remain to pair.
  const stale = client.from("passage_alignments").delete().eq("book_id", bookId);
  const live = `(${publicationIds.join(",")})`;
  const { error: pruneError } =
    publicationIds.length > 0
      ? await stale.or(`source_publication_id.not.in.${live},target_publication_id.not.in.${live}`)
      : await stale;
  if (pruneError) throw new Error(`computeAlignmentsForBook: failed to prune alignments (${pruneError.code ?? "unknown"})`);
  if (publicationIds.length < 2) return [];

  const chunks = new Map<string, AlignChunk[]>();
  for (const publicationId of publicationIds) chunks.set(publicationId, await loadChunks(client, publicationId));

  // Every ordered pair: each direction's rows come from its own run (replace_passage_alignments).
  const runs: AlignmentRun[] = [];
  for (const sourcePublicationId of publicationIds) {
    for (const targetPublicationId of publicationIds) {
      if (sourcePublicationId === targetPublicationId) continue;
      const { pairs, coverage } = alignChunks(chunks.get(sourcePublicationId)!, chunks.get(targetPublicationId)!);
      const { error: replaceError } = await client.rpc("replace_passage_alignments", {
        p_book_id: bookId,
        p_source_publication_id: sourcePublicationId,
        p_target_publication_id: targetPublicationId,
        p_pairs: pairs,
      });
      if (replaceError) throw new Error(`computeAlignmentsForBook: replace failed (${replaceError.code ?? "unknown"})`);
      runs.push({ sourcePublicationId, targetPublicationId, pairs: pairs.length, coverage });
    }
  }
  return runs;
}
