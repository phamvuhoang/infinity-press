// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  deriveManifestStorageKey,
  deriveResourceStorageKey,
  InMemoryJobStore,
  type FakeAsset,
} from "@/lib/epub/job-store";
import { ProcessingError } from "@/lib/epub/errors";
import type { ProcessedPublication } from "@/lib/epub/types";

const editionId = "edition-1";
const assetV1 = "asset-v1";
const assetV2 = "asset-v2";

function asset(overrides: Partial<FakeAsset> = {}): FakeAsset {
  return {
    id: assetV1,
    editionId,
    version: 1,
    sourceStorageKey: `${editionId}/${assetV1}/source.epub`,
    sourceChecksum: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    sourceBytes: new Uint8Array([1, 2, 3]),
    status: "queued",
    ...overrides,
  };
}

function publication(overrides: Partial<ProcessedPublication> = {}): ProcessedPublication {
  return {
    metadata: { title: "T", language: "en", identifier: "urn:uuid:1", authors: ["A"] },
    readingOrder: [{ href: "OEBPS/text/chapter1.xhtml", mediaType: "application/xhtml+xml" }],
    resources: [
      {
        href: "OEBPS/text/chapter1.xhtml",
        mediaType: "application/xhtml+xml",
        byteSize: 3,
        sha256: "abc",
        accessClass: "paid",
        bytes: new Uint8Array([1, 2, 3]),
        text: "<html/>",
      },
    ],
    toc: [{ title: "Chapter 1", href: "OEBPS/text/chapter1.xhtml", children: [] }],
    sampleHrefs: [],
    searchChunks: [
      {
        href: "OEBPS/text/chapter1.xhtml",
        chapterTitle: "Chapter 1",
        ordinal: 0,
        plainText: "chapter",
        locator: { href: "OEBPS/text/chapter1.xhtml", progression: 0, totalProgression: null, locations: { cssSelector: "p", textOffset: 0 }, text: { highlight: "chapter" } },
      },
    ],
    positions: [{ href: "OEBPS/text/chapter1.xhtml", progression: 0, totalProgression: null, locations: { position: 1 } }],
    ...overrides,
  };
}

describe("deriveResourceStorageKey / deriveManifestStorageKey (Ruling AU)", () => {
  it("is bucket-relative and scoped under editionId/assetId, with no bucket segment", () => {
    const job = { editionId, targetId: assetV1 };
    expect(deriveResourceStorageKey(job, "OEBPS/text/chapter1.xhtml")).toBe(
      `${editionId}/${assetV1}/OEBPS/text/chapter1.xhtml`,
    );
    expect(deriveManifestStorageKey(job)).toBe(`${editionId}/${assetV1}/manifest.json`);
  });

  it("is deterministic in (editionId, targetId, href) alone - independent of attempt number", () => {
    const attempt1 = { editionId, targetId: assetV1 };
    const attempt2 = { editionId, targetId: assetV1 };
    expect(deriveResourceStorageKey(attempt1, "a.css")).toBe(deriveResourceStorageKey(attempt2, "a.css"));
  });

  it.each([
    ["a leading slash", "/etc/passwd"],
    ["a parent-directory segment", "../evil.txt"],
    ["an embedded parent-directory segment", "OEBPS/../../evil.txt"],
    ["a double slash", "OEBPS//evil.txt"],
  ])("rejects an href with %s as INVALID_EPUB", (_label, href) => {
    expect(() => deriveResourceStorageKey({ editionId, targetId: assetV1 }, href)).toThrow(ProcessingError);
    try {
      deriveResourceStorageKey({ editionId, targetId: assetV1 }, href);
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_EPUB" });
    }
  });
});

describe("InMemoryJobStore lease correctness (Ruling AK)", () => {
  it("does not let a second worker claim the same active lease", async () => {
    const store = new InMemoryJobStore();
    store.seedAsset(asset());
    store.seedJob({ id: "job-1", targetId: assetV1, status: "queued", attempt: 0, leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorMessage: null, correlationId: "corr-1" });

    const claimedByA = await store.claimNext("worker-a", 60);
    const claimedByB = await store.claimNext("worker-b", 60);

    expect(claimedByA).not.toBeNull();
    expect(claimedByA?.leaseOwner).toBe("worker-a");
    expect(claimedByB).toBeNull();
  });

  it("lets a different worker reclaim an expired lease", async () => {
    let now = 1_000_000;
    const store = new InMemoryJobStore({ now: () => now });
    store.seedAsset(asset());
    store.seedJob({ id: "job-1", targetId: assetV1, status: "queued", attempt: 0, leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorMessage: null, correlationId: "corr-1" });

    const claimedByA = await store.claimNext("worker-a", 30);
    expect(claimedByA?.attempt).toBe(1);

    // Still within the lease: no one else can claim it.
    now += 20_000;
    expect(await store.claimNext("worker-b", 30)).toBeNull();

    // Lease has now expired.
    now += 20_000;
    const claimedByB = await store.claimNext("worker-b", 30);
    expect(claimedByB).not.toBeNull();
    expect(claimedByB?.leaseOwner).toBe("worker-b");
    expect(claimedByB?.attempt).toBe(2);
  });

  it("never lets claimNext pick up a failed job - only an explicit claimTarget can reclaim one", async () => {
    const store = new InMemoryJobStore();
    store.seedAsset(asset());
    store.seedJob({ id: "job-1", targetId: assetV1, status: "failed", attempt: 1, leaseOwner: null, leaseExpiresAt: null, errorCode: "INVALID_EPUB", errorMessage: "bad", correlationId: "corr-1" });

    expect(await store.claimNext("worker-a", 60)).toBeNull();

    const reclaimed = await store.claimTarget(assetV1, "worker-a", 60);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.attempt).toBe(2);
  });

  it("rejects complete()/fail() from a worker that does not hold the job's lease", async () => {
    const store = new InMemoryJobStore();
    store.seedAsset(asset());
    store.seedJob({ id: "job-1", targetId: assetV1, status: "queued", attempt: 0, leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorMessage: null, correlationId: "corr-1" });

    const claimed = await store.claimNext("worker-a", 60);
    const impostor = { ...claimed!, leaseOwner: "worker-b" };

    await expect(store.complete(impostor, publication())).rejects.toThrow(/does not hold the lease/);
    await expect(store.fail(impostor, { code: "PROCESSING_FAILURE", message: "x", retryable: true })).rejects.toThrow(
      /does not hold the lease/,
    );
  });
});

describe("InMemoryJobStore stale-version handling", () => {
  it("fails a stale asset version with STALE_VERSION without touching the active output", async () => {
    const store = new InMemoryJobStore();
    store.seedAsset(asset({ id: assetV1, version: 1 }));
    store.seedAsset(asset({ id: assetV2, version: 2, sourceStorageKey: `${editionId}/${assetV2}/source.epub` }));
    store.seedJob({ id: "job-v1", targetId: assetV1, status: "queued", attempt: 0, leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorMessage: null, correlationId: "corr-1" });
    store.seedJob({ id: "job-v2", targetId: assetV2, status: "queued", attempt: 0, leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorMessage: null, correlationId: "corr-2" });

    // Represents the edition's current active output: v2 already completed while job-v1
    // was still in flight.
    const v2Job = await store.claimTarget(assetV2, "worker-b", 60);
    await store.complete(v2Job!, publication());
    const activeOutputBefore = store.publications.get(assetV2);

    const job = await store.claimNext("worker-a", 60);
    expect(job?.targetId).toBe(assetV1);

    await expect(store.complete(job!, publication())).rejects.toMatchObject({ code: "STALE_VERSION" });

    // complete() only detects and raises - it never mutates state itself. The worker's
    // catch block is what actually records the failure via fail().
    expect(store.publications.has(assetV1)).toBe(false);
    expect(store.publications.get(assetV2)).toEqual(activeOutputBefore);

    await store.fail(job!, { code: "STALE_VERSION", message: "stale", retryable: false });
    expect(store.jobs.get("job-v1")?.status).toBe("failed");
    expect(store.jobs.get("job-v1")?.errorCode).toBe("STALE_VERSION");
    expect(store.assets.get(assetV1)?.status).toBe("failed");
    // Still untouched after the failure is recorded.
    expect(store.publications.get(assetV2)).toEqual(activeOutputBefore);
  });
});

describe("InMemoryJobStore storage failures", () => {
  it("records STORAGE_FAILURE and leaves the active publication unchanged", async () => {
    const store = new InMemoryJobStore({
      failStorageOnce: new Set([deriveResourceStorageKey({ editionId, targetId: assetV1 }, "OEBPS/text/chapter1.xhtml")]),
    });
    store.seedAsset(asset());
    store.seedJob({ id: "job-1", targetId: assetV1, status: "queued", attempt: 0, leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorMessage: null, correlationId: "corr-1" });

    const job = await store.claimNext("worker-a", 60);

    await expect(store.putDerived(job!, publication().resources[0])).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(store.publications.has(assetV1)).toBe(false);
  });

  it("retrying the same job after a storage failure writes the same versioned key", async () => {
    const key = deriveResourceStorageKey({ editionId, targetId: assetV1 }, "OEBPS/text/chapter1.xhtml");
    const store = new InMemoryJobStore({ failStorageOnce: new Set([key]) });
    store.seedAsset(asset());
    store.seedJob({ id: "job-1", targetId: assetV1, status: "queued", attempt: 0, leaseOwner: null, leaseExpiresAt: null, errorCode: null, errorMessage: null, correlationId: "corr-1" });

    const attempt1 = await store.claimNext("worker-a", 60);
    await expect(store.putDerived(attempt1!, publication().resources[0])).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    await store.fail(attempt1!, { code: "STORAGE_FAILURE", message: "x", retryable: true });

    const attempt2 = await store.claimTarget(assetV1, "worker-a", 60);
    await store.putDerived(attempt2!, publication().resources[0]);

    expect(store.derivedWriteLog.filter((k) => k === key)).toHaveLength(1);
    expect(deriveResourceStorageKey(attempt1!, "OEBPS/text/chapter1.xhtml")).toBe(
      deriveResourceStorageKey(attempt2!, "OEBPS/text/chapter1.xhtml"),
    );
  });
});
