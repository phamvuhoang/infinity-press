import "server-only";

import { z } from "zod";

import { ReaderDataUnavailableError } from "@/lib/data/reader-annotations";
import { parseBoundedReaderLocator, type ReaderSearchResult } from "@/lib/reader/annotations";
import { toReaderResourceHref } from "@/lib/reader/locator-paths";
import type { AuthorizedReaderContext } from "@/lib/reader/session";
import { createClient } from "@/lib/supabase/server";

type ReaderContext = AuthorizedReaderContext & { sessionId: string };

const boundedText = (maximum: number) =>
  z.string().refine((value) => Array.from(value).length <= maximum);

const searchRowSchema = z
  .object({
    chapter_title: boundedText(500).nullable(),
    excerpt: boundedText(240),
    locator_json: z.unknown(),
  })
  .passthrough();

export function parseReaderSearchQuery(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid search query");
  const query = value.trim();
  const length = Array.from(query).length;
  if (length < 2 || length > 100) throw new Error("Invalid search query");
  return query;
}

function mapSearchRow(value: unknown, publicationId: string): ReaderSearchResult {
  try {
    const row = searchRowSchema.parse(value);
    if (typeof row.locator_json !== "object" || row.locator_json === null) throw new Error();
    const stored = row.locator_json as Record<string, unknown>;
    if (typeof stored.href !== "string") throw new Error();
    const locator = parseBoundedReaderLocator({
      ...stored,
      href: toReaderResourceHref(publicationId, stored.href),
    });
    if (
      (locator.text?.before !== undefined && Array.from(locator.text.before).length > 64) ||
      (locator.text?.highlight !== undefined && Array.from(locator.text.highlight).length > 160) ||
      (locator.text?.after !== undefined && Array.from(locator.text.after).length > 64)
    ) {
      throw new Error();
    }
    return { chapterTitle: row.chapter_title, excerpt: row.excerpt, locator };
  } catch {
    throw new ReaderDataUnavailableError("invalid_response");
  }
}

export async function searchReaderPublication(
  context: ReaderContext,
  rawQuery: unknown,
): Promise<ReaderSearchResult[]> {
  const query = parseReaderSearchQuery(rawQuery);
  const client = await createClient();
  const { data, error } = await client.rpc("search_reader_publication", {
    p_session_id: context.sessionId,
    p_publication_id: context.publicationId,
    p_query: query,
  });
  if (error) throw new ReaderDataUnavailableError(error.code ?? null);
  if (!Array.isArray(data) || data.length > 50) throw new ReaderDataUnavailableError("invalid_response");
  return data.map((row) => mapSearchRow(row, context.publicationId));
}
