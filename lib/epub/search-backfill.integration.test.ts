// @vitest-environment node
// This test intentionally needs a real, isolated Supabase stack: it proves backfill reads
// private storage and changes only the derived index rows. Enable it explicitly through the
// local wrapper; ordinary unit runs do not have credentials or permission to seed publications.
import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EBOOK_DERIVED_BUCKET } from "@/lib/epub/job-store";
import { indexPublicationSearch } from "@/lib/epub/search-backfill";
import { seedProcessedBook } from "@/e2e/support/publication";
import { createServiceRoleClient } from "@/e2e/support/supabase";

const localIntegration = process.env.RUN_LOCAL_BACKFILL_INTEGRATION === "1" ? it : it.skip;

function requireData<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error || result.data === null) throw new Error(result.error?.message ?? "local integration query returned no data");
  return result.data as NonNullable<T>;
}

async function readObjectHash(storageKey: string): Promise<string> {
  const service = createServiceRoleClient();
  const object = requireData(await service.storage.from(EBOOK_DERIVED_BUCKET).download(storageKey));
  return createHash("sha256").update(new Uint8Array(await object.arrayBuffer())).digest("hex");
}

async function snapshotPublication(publicationId: string, bookId: string) {
  const service = createServiceRoleClient();
  const publication = requireData(
    await service
      .from("ebook_publications")
      .select("id, ebook_asset_id, version, manifest_key, toc_json, positions_json, status, processed_at")
      .eq("id", publicationId)
      .single(),
  );
  const resources = requireData(
    await service
      .from("ebook_resources")
      .select("href, media_type, storage_key, byte_size, sha256, access_class")
      .eq("publication_id", publicationId)
      .order("href"),
  );
  const chunks = requireData(
    await service
      .from("ebook_search_chunks")
      .select("href, chapter_title, ordinal, plain_text, locator_json")
      .eq("publication_id", publicationId)
      .order("ordinal"),
  );
  const book = requireData(await service.from("books").select("active_publication_id").eq("id", bookId).single());
  return {
    publication,
    resources,
    resourceObjectHashes: await Promise.all(resources.map(async (resource) => ({ href: resource.href, hash: await readObjectHash(resource.storage_key) }))),
    manifestObjectHash: await readObjectHash(publication.manifest_key),
    chunks,
    activePublicationId: book.active_publication_id,
  };
}

describe("indexPublicationSearch local storage/database integration", () => {
  localIntegration("is idempotent and preserves all immutable publication data while leaving another publication unchanged", async () => {
    const suffix = `backfill-${randomUUID().slice(0, 8)}`;
    const first = await seedProcessedBook({ suffix: `${suffix}-a`, localizations: { en: { slug: `${suffix}-a`, title: "Backfill A" } } });
    const second = await seedProcessedBook({ suffix: `${suffix}-b`, localizations: { en: { slug: `${suffix}-b`, title: "Backfill B" } } });

    const before = await snapshotPublication(first.publicationId, first.bookId);
    const otherBefore = await snapshotPublication(second.publicationId, second.bookId);
    const firstRun = await indexPublicationSearch(first.publicationId);
    const afterFirst = await snapshotPublication(first.publicationId, first.bookId);
    const secondRun = await indexPublicationSearch(first.publicationId);
    const afterSecond = await snapshotPublication(first.publicationId, first.bookId);
    const otherAfter = await snapshotPublication(second.publicationId, second.bookId);

    expect(firstRun).toEqual({ publicationId: first.publicationId, chunkCount: before.chunks.length, positionCount: before.publication.positions_json?.length ?? 0 });
    expect(secondRun).toEqual(firstRun);
    expect(afterFirst.publication).toEqual(before.publication);
    expect(afterSecond.publication).toEqual(before.publication);
    expect(afterFirst.resources).toEqual(before.resources);
    expect(afterSecond.resources).toEqual(before.resources);
    expect(afterFirst.resourceObjectHashes).toEqual(before.resourceObjectHashes);
    expect(afterSecond.resourceObjectHashes).toEqual(before.resourceObjectHashes);
    expect(afterFirst.manifestObjectHash).toBe(before.manifestObjectHash);
    expect(afterSecond.manifestObjectHash).toBe(before.manifestObjectHash);
    expect(afterFirst.chunks).toEqual(before.chunks);
    expect(afterSecond.chunks).toEqual(before.chunks);
    expect(otherAfter).toEqual(otherBefore);
  }, 60_000);
});
