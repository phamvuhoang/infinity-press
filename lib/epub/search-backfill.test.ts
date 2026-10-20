// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const { createJobStoreClient } = vi.hoisted(() => ({ createJobStoreClient: vi.fn() }));

vi.mock("@/lib/epub/job-store", () => ({ EBOOK_DERIVED_BUCKET: "ebook-derived", createJobStoreClient }));

import { indexPublicationSearch } from "@/lib/epub/search-backfill";

const publicationId = "11111111-1111-4111-8111-111111111111";
const manifest = {
  metadata: { title: "T", language: "en", identifier: "i", authors: [] },
  readingOrder: [{ href: "OEBPS/text/chapter.xhtml", mediaType: "application/xhtml+xml" }],
  toc: [{ title: "Chapter", href: "OEBPS/text/chapter.xhtml", children: [] }],
};

function backfillClient(options: { resources?: unknown[]; manifest?: unknown; xhtml?: string } = {}) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const download = vi.fn().mockResolvedValue({ data: new Blob([JSON.stringify(options.manifest ?? manifest)]), error: null });
  const xhtmlDownload = vi.fn().mockResolvedValue({ data: new Blob([options.xhtml ?? "<html><body><p>Sanitized chapter text.</p></body></html>"]), error: null });
  const from = vi.fn((table: string) => {
    if (table === "ebook_publications") {
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: publicationId, manifest_key: "edition/asset/manifest.json", toc_json: manifest.toc }, error: null }) })) })) };
    }
    return { select: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: options.resources ?? [{ href: "OEBPS/text/chapter.xhtml", media_type: "application/xhtml+xml", storage_key: "edition/asset/chapter.xhtml", byte_size: 10, sha256: "a".repeat(64), access_class: "paid" }], error: null }) })) };
  });
  const storageFrom = vi.fn(() => ({ download: vi.fn((key: string) => (key.endsWith("manifest.json") ? download() : xhtmlDownload())) }));
  return { client: { from, rpc, storage: { from: storageFrom } }, rpc, download, xhtmlDownload };
}

describe("indexPublicationSearch", () => {
  it("rejects an invalid publication UUID before creating a client or doing IO", async () => {
    await expect(indexPublicationSearch("not-a-uuid")).rejects.toMatchObject({ code: "INDEX_SEARCH_INVALID_PUBLICATION_ID" });
    expect(createJobStoreClient).not.toHaveBeenCalled();
  });

  it("reads the immutable manifest and sanitized private XHTML then replaces only derived search data", async () => {
    const { client, rpc } = backfillClient();
    createJobStoreClient.mockReturnValue(client);

    const first = await indexPublicationSearch(publicationId);
    const second = await indexPublicationSearch(publicationId);

    expect(first).toEqual({ publicationId, chunkCount: 1, positionCount: 1 });
    expect(second).toEqual(first);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("replace_publication_search", expect.objectContaining({
      p_publication_id: publicationId,
      p_search_chunks: [expect.objectContaining({ href: "OEBPS/text/chapter.xhtml", plain_text: "Sanitized chapter text." })],
      p_positions: [expect.objectContaining({ href: "OEBPS/text/chapter.xhtml" })],
    }));
  });

  it("rejects a manifest reading-order resource that is missing from stored private resources before replacement", async () => {
    const { client, rpc } = backfillClient({ resources: [] });
    createJobStoreClient.mockReturnValue(client);

    await expect(indexPublicationSearch(publicationId)).rejects.toMatchObject({ code: "INDEX_SEARCH_MALFORMED_PUBLICATION" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects malformed stored XHTML before replacing an existing private index", async () => {
    const { client, rpc } = backfillClient({ xhtml: "this is not XHTML" });
    createJobStoreClient.mockReturnValue(client);

    await expect(indexPublicationSearch(publicationId)).rejects.toMatchObject({ code: "INDEX_SEARCH_MALFORMED_PUBLICATION" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["multiple document roots", "<html><body/></html><foo/>"],
    ["a nested body", "<html><body><body/></body></html>"],
    ["a body under head", "<html><head><body/></head><body/></html>"],
  ])("rejects stored XHTML with %s before replacement", async (_label, xhtml) => {
    const { client, rpc } = backfillClient({ xhtml });
    createJobStoreClient.mockReturnValue(client);

    await expect(indexPublicationSearch(publicationId)).rejects.toMatchObject({ code: "INDEX_SEARCH_MALFORMED_PUBLICATION" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
