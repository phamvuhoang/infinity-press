import "server-only";

import { ReaderDataUnavailableError } from "@/lib/data/reader-annotations";
import { alignedPassageSchema, type AlignedPassage } from "@/lib/reader/aligned";
import type { AuthorizedReaderContext } from "@/lib/reader/session";
import { createClient } from "@/lib/supabase/server";

// The passage another edition aligns with where the reader is. `href` is the in-publication href.
// Both RPCs check the caller's entitlement themselves; a refusal or an unaligned place is null.
export async function getAlignedPassage(
  context: AuthorizedReaderContext,
  place: { ordinal: number } | { href: string; progression: number },
): Promise<AlignedPassage | null> {
  const client = await createClient();
  let ordinal: number;
  if ("ordinal" in place) {
    ordinal = place.ordinal;
  } else {
    const { data, error } = await client.rpc("reader_chunk_for_locator", {
      p_publication_id: context.publicationId,
      p_href: place.href,
      p_progression: place.progression,
    });
    if (error) throw new ReaderDataUnavailableError(error.code ?? null);
    if (typeof data !== "number") return null;
    ordinal = data;
  }

  const { data, error } = await client.rpc("reader_aligned_passage", {
    p_publication_id: context.publicationId,
    p_ordinal: ordinal,
  });
  if (error) throw new ReaderDataUnavailableError(error.code ?? null);
  if (data === null) return null;
  const parsed = alignedPassageSchema.safeParse(data);
  if (!parsed.success) throw new ReaderDataUnavailableError("invalid_response");
  return parsed.data;
}
