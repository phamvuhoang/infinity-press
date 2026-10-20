// @vitest-environment node
//
// Fix round 1, Ruling BC: job-store.test.ts only ever exercises InMemoryJobStore, a fake
// written by hand to mirror the real RPCs' semantics - it cannot catch drift in the TS↔RPC
// seam itself (argument names, the hand-written ClaimJobRow shape, bucket names, `upsert`,
// the EB001 -> STALE_VERSION mapping). pgTAP covers the SQL side independently. This file
// covers SupabaseJobStore against a mocked Supabase client, the same way lib/epub/upload.
// test.ts mocks the session/admin clients - it is the one thing that would catch, say, a
// renamed RPC argument or a resource field left in camelCase.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ProcessingError } from "@/lib/epub/errors";
import { STALE_VERSION_SQLSTATE, SupabaseJobStore, type ProcessingJob } from "@/lib/epub/job-store";
import type { StorageRetryPolicy } from "@/lib/epub/storage-retry";
import type { Database } from "@/lib/supabase/database.types";
import type { ProcessedPublication, ProcessedResource } from "@/lib/epub/types";

const job: ProcessingJob = {
  id: "job-1",
  targetId: "asset-1",
  editionId: "edition-1",
  version: 1,
  sourceStorageKey: "edition-1/asset-1/source.epub",
  sourceChecksum: "checksum-1",
  attempt: 1,
  correlationId: "corr-1",
  leaseOwner: "worker-a",
};

// Mirrors the shape upload.test.ts's sessionClient()/adminClient() helpers use: a stubbable
// `.rpc()` and `.storage.from(bucket)` returning stubbable `download`/`upload`. Cast through
// `unknown`, same as those helpers - the point is to control the wire shape, not to satisfy
// the full SupabaseClient interface.
function mockClient(config: {
  rpcImpl?: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
  download?: ReturnType<typeof vi.fn>;
  upload?: ReturnType<typeof vi.fn>;
}) {
  const rpc = vi.fn(config.rpcImpl ?? (async () => ({ data: null, error: null })));
  const download = config.download ?? vi.fn();
  const upload = config.upload ?? vi.fn();
  const from = vi.fn(() => ({ download, upload }));
  const client = { rpc, storage: { from } } as unknown as SupabaseClient<Database>;
  return { client, rpc, from, download, upload };
}

// What supabase-js hands back when `fetch` itself throws: the errno is two levels down,
// under StorageUnknownError.originalError.cause.
function transportError(code = "ECONNRESET") {
  const errno = Object.assign(new Error(`read ${code}`), { code });
  return Object.assign(new Error("fetch failed"), {
    name: "StorageUnknownError",
    originalError: Object.assign(new TypeError("fetch failed"), { cause: errno }),
  });
}

// Same attempt budget as production, minus the real waiting.
const noSleepRetry: StorageRetryPolicy = { attempts: 4, baseDelayMs: 1, sleep: async () => {} };

describe("SupabaseJobStore.claimNext / claimTarget", () => {
  it("calls claim_processing_job with no p_target_id and maps the returned row", async () => {
    const row = {
      job_id: "job-1",
      target_id: "asset-1",
      edition_id: "edition-1",
      version: 1,
      source_storage_key: "edition-1/asset-1/source.epub",
      source_checksum: "checksum-1",
      attempt: 1,
      correlation_id: "corr-1",
    };
    const { client, rpc } = mockClient({ rpcImpl: async () => ({ data: [row], error: null }) });
    const store = new SupabaseJobStore(client);

    const claimed = await store.claimNext("worker-a", 60);

    expect(rpc).toHaveBeenCalledWith("claim_processing_job", { p_worker_id: "worker-a", p_lease_seconds: 60 });
    expect(claimed).toEqual({
      id: "job-1",
      targetId: "asset-1",
      editionId: "edition-1",
      version: 1,
      sourceStorageKey: "edition-1/asset-1/source.epub",
      sourceChecksum: "checksum-1",
      attempt: 1,
      correlationId: "corr-1",
      leaseOwner: "worker-a",
    });
  });

  it("calls claim_processing_job with p_target_id set when claiming a specific target", async () => {
    const { client, rpc } = mockClient({ rpcImpl: async () => ({ data: [], error: null }) });
    const store = new SupabaseJobStore(client);

    const claimed = await store.claimTarget("asset-9", "worker-b", 30);

    expect(rpc).toHaveBeenCalledWith("claim_processing_job", {
      p_worker_id: "worker-b",
      p_lease_seconds: 30,
      p_target_id: "asset-9",
    });
    expect(claimed).toBeNull();
  });

  it("throws a plain error when the RPC call itself fails", async () => {
    const { client } = mockClient({ rpcImpl: async () => ({ data: null, error: { message: "connection refused" } }) });
    const store = new SupabaseJobStore(client);

    await expect(store.claimNext("worker-a", 60)).rejects.toThrow(/claim_processing_job failed/);
  });
});

describe("SupabaseJobStore.downloadSource", () => {
  it("downloads from the source bucket by the job's exact storage key", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const download = vi.fn().mockResolvedValue({ data: { arrayBuffer: () => Promise.resolve(bytes.buffer) }, error: null });
    const { client, from } = mockClient({ download });
    const store = new SupabaseJobStore(client);

    const result = await store.downloadSource(job);

    expect(from).toHaveBeenCalledWith("ebook-source");
    expect(download).toHaveBeenCalledWith(job.sourceStorageKey);
    expect(result).toEqual(bytes);
  });

  it("surfaces a download error as STORAGE_FAILURE, never a raw passthrough", async () => {
    const download = vi.fn().mockResolvedValue({ data: null, error: { message: "not found" } });
    const { client } = mockClient({ download });
    const store = new SupabaseJobStore(client);

    await expect(store.downloadSource(job)).rejects.toBeInstanceOf(ProcessingError);
    await expect(store.downloadSource(job)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  });

  it("keeps the underlying errno in the failure message instead of a bare 'fetch failed'", async () => {
    const download = vi.fn().mockResolvedValue({ data: null, error: transportError("ECONNRESET") });
    const { client } = mockClient({ download });
    const store = new SupabaseJobStore(client);

    await expect(store.downloadSource(job)).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      message: expect.stringContaining("ECONNRESET"),
    });
  });
});

describe("SupabaseJobStore.putDerived / putManifest", () => {
  const resource: ProcessedResource = {
    href: "OEBPS/text/chapter1.xhtml",
    mediaType: "application/xhtml+xml",
    byteSize: 3,
    sha256: "abc",
    accessClass: "paid",
    bytes: new Uint8Array([1, 2, 3]),
    text: "<html/>",
  };

  it("uploads a derived resource to its exact deterministic key, upserting", async () => {
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null });
    const { client, from } = mockClient({ upload });
    const store = new SupabaseJobStore(client);

    await store.putDerived(job, resource);

    expect(from).toHaveBeenCalledWith("ebook-derived");
    expect(upload).toHaveBeenCalledWith("edition-1/asset-1/OEBPS/text/chapter1.xhtml", resource.bytes, {
      contentType: "application/xhtml+xml",
      upsert: true,
    });
  });

  it("surfaces an upload error as STORAGE_FAILURE", async () => {
    const upload = vi.fn().mockResolvedValue({ data: null, error: { message: "bucket full" } });
    const { client } = mockClient({ upload });
    const store = new SupabaseJobStore(client);

    await expect(store.putDerived(job, resource)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  });

  // Regression: job dc92185d failed its whole 830-resource run on a single dropped socket at
  // resource #269, with no retry anywhere in the upload loop (lib/epub/worker.ts).
  it("retries a dropped connection rather than failing the whole job on one bad request", async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: transportError() })
      .mockResolvedValueOnce({ data: {}, error: null });
    const { client } = mockClient({ upload });
    const store = new SupabaseJobStore(client, noSleepRetry);

    await expect(store.putDerived(job, resource)).resolves.toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("keeps the underlying errno in the failure message instead of a bare 'fetch failed'", async () => {
    const upload = vi.fn().mockResolvedValue({ data: null, error: transportError("ETIMEDOUT") });
    const { client } = mockClient({ upload });
    const store = new SupabaseJobStore(client, noSleepRetry);

    await expect(store.putDerived(job, resource)).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      message: expect.stringContaining("ETIMEDOUT"),
    });
  });

  it("retries a dropped connection on the manifest upload too", async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: transportError() })
      .mockResolvedValueOnce({ data: {}, error: null });
    const { client } = mockClient({ upload });
    const store = new SupabaseJobStore(client, noSleepRetry);

    const key = await store.putManifest(job, {
      metadata: { title: "T", language: "en", identifier: "i", authors: [] },
      readingOrder: [],
      toc: [],
    });

    expect(key).toBe("edition-1/asset-1/manifest.json");
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("uploads the manifest to its exact deterministic key and returns it", async () => {
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null });
    const { client, from } = mockClient({ upload });
    const store = new SupabaseJobStore(client);

    const key = await store.putManifest(job, {
      metadata: { title: "T", language: "en", identifier: "i", authors: [] },
      readingOrder: [],
      toc: [],
    });

    expect(key).toBe("edition-1/asset-1/manifest.json");
    expect(from).toHaveBeenCalledWith("ebook-derived");
    expect(upload).toHaveBeenCalledWith(key, expect.any(Uint8Array), {
      contentType: "application/webpub+json",
      upsert: true,
    });
  });
});

describe("SupabaseJobStore.complete", () => {
  const publication: ProcessedPublication = {
    metadata: { title: "T", language: "en", identifier: "i", authors: ["A"] },
    readingOrder: [{ href: "OEBPS/text/chapter1.xhtml", mediaType: "application/xhtml+xml" }],
    resources: [
      {
        href: "OEBPS/text/chapter1.xhtml",
        mediaType: "application/xhtml+xml",
        byteSize: 3,
        sha256: "abc",
        accessClass: "paid",
        bytes: new Uint8Array([1]),
        text: "x",
      },
    ],
    toc: [{ title: "Ch1", href: "OEBPS/text/chapter1.xhtml", children: [] }],
    sampleHrefs: [],
    searchChunks: [
      {
        href: "OEBPS/text/chapter1.xhtml",
        chapterTitle: "Ch1",
        ordinal: 0,
        plainText: "chapter text",
        locator: {
          href: "OEBPS/text/chapter1.xhtml",
          progression: 0,
          totalProgression: null,
          locations: { cssSelector: "p", textOffset: 0 },
          text: { highlight: "chapter text" },
        },
      },
    ],
    positions: [{ href: "OEBPS/text/chapter1.xhtml", progression: 0, totalProgression: null, locations: { position: 1 } }],
  };

  it("calls complete_processing_job with the exact snake_case resource shape and derived keys", async () => {
    const { client, rpc } = mockClient({ rpcImpl: async () => ({ data: "pub-1", error: null }) });
    const store = new SupabaseJobStore(client);

    await store.complete(job, publication);

    expect(rpc).toHaveBeenCalledWith("complete_processing_job", {
      p_job_id: job.id,
      p_worker_id: job.leaseOwner,
      p_manifest_key: "edition-1/asset-1/manifest.json",
      p_toc: publication.toc,
      p_resources: [
        {
          href: "OEBPS/text/chapter1.xhtml",
          media_type: "application/xhtml+xml",
          storage_key: "edition-1/asset-1/OEBPS/text/chapter1.xhtml",
          byte_size: 3,
          sha256: "abc",
          access_class: "paid",
        },
      ],
      p_sample_hrefs: publication.sampleHrefs,
      p_search_chunks: [
        {
          href: "OEBPS/text/chapter1.xhtml",
          chapter_title: "Ch1",
          ordinal: 0,
          plain_text: "chapter text",
          locator_json: publication.searchChunks[0].locator,
        },
      ],
      p_positions: publication.positions,
    });
  });

  it("maps the EB001 SQLSTATE to a STALE_VERSION ProcessingError, not a generic Error", async () => {
    const { client } = mockClient({
      rpcImpl: async () => ({ data: null, error: { code: STALE_VERSION_SQLSTATE, message: "asset x is stale" } }),
    });
    const store = new SupabaseJobStore(client);

    await expect(store.complete(job, publication)).rejects.toBeInstanceOf(ProcessingError);
    await expect(store.complete(job, publication)).rejects.toMatchObject({ code: "STALE_VERSION" });
  });

  it("maps every other RPC error to a generic Error, not STALE_VERSION", async () => {
    const { client } = mockClient({
      rpcImpl: async () => ({ data: null, error: { code: "42501", message: "does not hold the lease" } }),
    });
    const store = new SupabaseJobStore(client);

    await expect(store.complete(job, publication)).rejects.toThrow(/complete_processing_job failed/);
    const rejection = await store.complete(job, publication).catch((error: unknown) => error);
    expect(rejection).not.toBeInstanceOf(ProcessingError);
  });
});

describe("SupabaseJobStore.fail", () => {
  it("calls fail_processing_job with the failure's code and message", async () => {
    const { client, rpc } = mockClient({ rpcImpl: async () => ({ data: null, error: null }) });
    const store = new SupabaseJobStore(client);

    await store.fail(job, { code: "STORAGE_FAILURE", message: "boom", retryable: true });

    expect(rpc).toHaveBeenCalledWith("fail_processing_job", {
      p_job_id: job.id,
      p_worker_id: job.leaseOwner,
      p_error_code: "STORAGE_FAILURE",
      p_error_message: "boom",
    });
  });

  it("throws a plain error when the RPC call itself fails", async () => {
    const { client } = mockClient({ rpcImpl: async () => ({ data: null, error: { message: "timeout" } }) });
    const store = new SupabaseJobStore(client);

    await expect(store.fail(job, { code: "PROCESSING_FAILURE", message: "x", retryable: true })).rejects.toThrow(
      /fail_processing_job failed/,
    );
  });
});
