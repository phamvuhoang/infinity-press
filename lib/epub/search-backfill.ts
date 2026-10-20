// Rebuilds private search material from an immutable publication's already-sanitized derived
// resources. This deliberately does not share the source-EPUB processing path: backfill must
// never mutate manifests, resource objects, versions, or publication state.
import { EBOOK_DERIVED_BUCKET, createJobStoreClient } from "@/lib/epub/job-store";
import { buildSearchIndex, isStructuredSanitizedXhtml } from "@/lib/epub/search-index";
import type { ProcessedResource, ReadingOrderItem, TocEntry } from "@/lib/epub/types";

type BackfillCode =
  | "INDEX_SEARCH_INVALID_PUBLICATION_ID"
  | "INDEX_SEARCH_PUBLICATION_NOT_FOUND"
  | "INDEX_SEARCH_MALFORMED_PUBLICATION"
  | "INDEX_SEARCH_STORAGE_FAILURE"
  | "INDEX_SEARCH_REPLACE_FAILURE";

export class SearchBackfillError extends Error {
  constructor(
    readonly code: BackfillCode,
    readonly publicationId?: string,
  ) {
    super(code);
    this.name = "SearchBackfillError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const XHTML_MEDIA_TYPE = "application/xhtml+xml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToc(value: unknown, publicationId: string): TocEntry[] {
  if (!Array.isArray(value)) throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.title !== "string" || typeof entry.href !== "string" || !Array.isArray(entry.children)) {
      throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
    }
    return { title: entry.title, href: entry.href, children: parseToc(entry.children, publicationId) };
  });
}

function parseManifest(value: unknown, publicationId: string): { readingOrder: ReadingOrderItem[] } {
  if (!isRecord(value) || !Array.isArray(value.readingOrder) || !Array.isArray(value.toc)) {
    throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
  }
  const readingOrder = value.readingOrder.map((item) => {
    if (!isRecord(item) || typeof item.href !== "string" || typeof item.mediaType !== "string" || !item.href) {
      throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
    }
    return { href: item.href, mediaType: item.mediaType };
  });
  // The immutable manifest must itself remain structurally sound, but publication.toc_json is
  // the stored source of the TOC that was committed with this publication.
  parseToc(value.toc, publicationId);
  return { readingOrder };
}

function parseResources(value: unknown, publicationId: string): ProcessedResource[] {
  if (!Array.isArray(value)) throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
  return value.map((resource) => {
    if (
      !isRecord(resource) ||
      typeof resource.href !== "string" ||
      typeof resource.media_type !== "string" ||
      typeof resource.storage_key !== "string" ||
      typeof resource.byte_size !== "number" ||
      typeof resource.sha256 !== "string" ||
      (resource.access_class !== "paid" && resource.access_class !== "sample")
    ) {
      throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
    }
    return {
      href: resource.href,
      mediaType: resource.media_type,
      byteSize: resource.byte_size,
      sha256: resource.sha256,
      accessClass: resource.access_class,
      bytes: new Uint8Array(),
    };
  });
}

async function downloadBytes(client: ReturnType<typeof createJobStoreClient>, key: string, publicationId: string): Promise<Uint8Array> {
  const { data, error } = await client.storage.from(EBOOK_DERIVED_BUCKET).download(key);
  if (error || !data) throw new SearchBackfillError("INDEX_SEARCH_STORAGE_FAILURE", publicationId);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Replaces only the supplied publication's search rows and nullable positions extension.
 * The RPC performs the final membership validation and replacement in one locked transaction.
 */
export async function indexPublicationSearch(
  publicationId: string,
): Promise<{ publicationId: string; chunkCount: number; positionCount: number }> {
  if (!UUID_PATTERN.test(publicationId)) throw new SearchBackfillError("INDEX_SEARCH_INVALID_PUBLICATION_ID", publicationId);

  const client = createJobStoreClient();
  const { data: publication, error: publicationError } = await client
    .from("ebook_publications")
    .select("id, manifest_key, toc_json")
    .eq("id", publicationId)
    .maybeSingle();
  if (publicationError) throw new SearchBackfillError("INDEX_SEARCH_STORAGE_FAILURE", publicationId);
  if (!publication) throw new SearchBackfillError("INDEX_SEARCH_PUBLICATION_NOT_FOUND", publicationId);

  const manifestBytes = await downloadBytes(client, publication.manifest_key, publicationId);
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
  }
  const { readingOrder } = parseManifest(manifestJson, publicationId);
  const toc = parseToc(publication.toc_json, publicationId);

  const { data: resourceRows, error: resourceError } = await client
    .from("ebook_resources")
    .select("href, media_type, storage_key, byte_size, sha256, access_class")
    .eq("publication_id", publicationId);
  if (resourceError) throw new SearchBackfillError("INDEX_SEARCH_STORAGE_FAILURE", publicationId);
  const resources = parseResources(resourceRows, publicationId);
  const resourcesByHref = new Map(resources.map((resource) => [resource.href, resource]));

  for (const item of readingOrder) {
    const resource = resourcesByHref.get(item.href);
    if (!resource || resource.mediaType !== item.mediaType) throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
    if (item.mediaType !== XHTML_MEDIA_TYPE) continue;
    const source = (resourceRows ?? []).find((row) => isRecord(row) && row.href === item.href);
    if (!source || typeof source.storage_key !== "string") throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
    const bytes = await downloadBytes(client, source.storage_key, publicationId);
    try {
      resource.bytes = bytes;
      resource.text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
    }
    if (!isStructuredSanitizedXhtml(resource.text)) {
      throw new SearchBackfillError("INDEX_SEARCH_MALFORMED_PUBLICATION", publicationId);
    }
  }

  const searchIndex = buildSearchIndex({ readingOrder, resources, toc });
  const p_search_chunks = searchIndex.searchChunks.map((chunk) => ({
    href: chunk.href,
    chapter_title: chunk.chapterTitle,
    ordinal: chunk.ordinal,
    plain_text: chunk.plainText,
    locator_json: chunk.locator,
  }));
  const { error: replaceError } = await client.rpc("replace_publication_search", {
    p_publication_id: publicationId,
    p_search_chunks,
    p_positions: searchIndex.positions,
  });
  if (replaceError) throw new SearchBackfillError("INDEX_SEARCH_REPLACE_FAILURE", publicationId);

  return { publicationId, chunkCount: p_search_chunks.length, positionCount: searchIndex.positions.length };
}
