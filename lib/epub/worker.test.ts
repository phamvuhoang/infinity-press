// @vitest-environment node
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { epubMissingContainer, validEpub } from "@/scripts/fixtures/create-test-epub";
import { deriveManifestStorageKey, deriveResourceStorageKey, InMemoryJobStore, type FakeAsset } from "@/lib/epub/job-store";
import { claimNextJob, processJob } from "@/lib/epub/worker";

const editionId = "edition-1";
const assetV1 = "asset-v1";
const assetV2 = "asset-v2";

function asset(overrides: Partial<FakeAsset> = {}): FakeAsset {
  const sourceBytes = overrides.sourceBytes ?? validEpub();
  return {
    id: assetV1,
    editionId,
    version: 1,
    sourceStorageKey: `${editionId}/${assetV1}/source.epub`,
    sourceChecksum: createHash("sha256").update(sourceBytes).digest("hex"),
    sourceBytes,
    status: "queued",
    ...overrides,
  };
}

function seedQueuedJob(store: InMemoryJobStore, targetId = assetV1, jobId = "job-1") {
  store.seedJob({
    id: jobId,
    targetId,
    status: "queued",
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    errorCode: null,
    errorMessage: null,
    correlationId: "corr-1",
  });
}

describe("claimNextJob / processJob happy path", () => {
  it("downloads, processes, uploads every derived resource and the manifest, and completes the job", async () => {
    const store = new InMemoryJobStore();
    store.seedAsset(asset());
    seedQueuedJob(store);

    const job = await claimNextJob(store, "worker-a", 60);
    expect(job).not.toBeNull();

    const outcome = await processJob(store, job!);

    expect(outcome.outcome).toBe("completed");
    expect(store.jobs.get("job-1")?.status).toBe("completed");
    expect(store.assets.get(assetV1)?.status).toBe("ready_for_preview");

    const pub = store.publications.get(assetV1);
    expect(pub).toBeDefined();
    expect(pub?.resources).toHaveLength(5);
    expect(pub?.searchChunks.length).toBeGreaterThan(0);
    expect(pub?.positions.length).toBeGreaterThan(0);
    expect(outcome.outcome === "completed" && outcome.publication.searchChunks).toEqual(pub?.searchChunks);
    expect(outcome.outcome === "completed" && outcome.publication.positions).toEqual(pub?.positions);
    expect(pub?.manifestKey).toBe(deriveManifestStorageKey(job!));
    expect(store.derivedObjects.has(deriveManifestStorageKey(job!))).toBe(true);
    for (const resource of pub!.resources) {
      expect(store.derivedObjects.has(resource.storageKey)).toBe(true);
      expect(resource.storageKey).toBe(deriveResourceStorageKey(job!, resource.href));
    }
  });
});

describe("processJob failure handling", () => {
  it("rejects altered source bytes before parsing or uploading derived resources", async () => {
    const store = new InMemoryJobStore();
    store.seedAsset(asset({ sourceChecksum: "0".repeat(64) }));
    seedQueuedJob(store);

    const job = await claimNextJob(store, "worker-a", 60);
    const outcome = await processJob(store, job!);

    expect(outcome).toMatchObject({
      outcome: "failed",
      failure: { code: "SOURCE_CHECKSUM_MISMATCH", retryable: false },
    });
    expect(store.jobs.get("job-1")?.status).toBe("failed");
    expect(store.derivedWriteLog).toEqual([]);
    expect(store.publications.has(assetV1)).toBe(false);
  });

  it("records INVALID_EPUB as a non-retryable failure and leaves no publication", async () => {
    const store = new InMemoryJobStore();
    store.seedAsset(asset({ sourceBytes: epubMissingContainer() }));
    seedQueuedJob(store);

    const job = await claimNextJob(store, "worker-a", 60);
    const outcome = await processJob(store, job!);

    expect(outcome).toMatchObject({ outcome: "failed", failure: { code: "INVALID_EPUB", retryable: false } });
    expect(store.jobs.get("job-1")?.status).toBe("failed");
    expect(store.jobs.get("job-1")?.errorCode).toBe("INVALID_EPUB");
    expect(store.publications.has(assetV1)).toBe(false);
  });

  it("records STORAGE_FAILURE and leaves the active publication unchanged when a derived upload fails mid-stream", async () => {
    const failingKey = deriveResourceStorageKey({ editionId, targetId: assetV1 }, "OEBPS/text/chapter2.xhtml");
    const store = new InMemoryJobStore({ failStorageOnce: new Set([failingKey]) });
    store.seedAsset(asset());
    seedQueuedJob(store);

    const job = await claimNextJob(store, "worker-a", 60);
    const outcome = await processJob(store, job!);

    expect(outcome).toMatchObject({ outcome: "failed", failure: { code: "STORAGE_FAILURE", retryable: true } });
    expect(store.jobs.get("job-1")?.status).toBe("failed");
    // Partial derived output is the accepted failure mode: resources sorted before
    // chapter2.xhtml were already uploaded when the injected failure hit.
    expect(store.derivedObjects.has(deriveResourceStorageKey({ editionId, targetId: assetV1 }, "OEBPS/images/cover.jpg"))).toBe(true);
    // But no publication (the active output) was ever created for this asset.
    expect(store.publications.has(assetV1)).toBe(false);
  });

  it("fails a stale asset version with STALE_VERSION and never overwrites the newer active output", async () => {
    const store = new InMemoryJobStore();
    store.seedAsset(asset({ id: assetV1, version: 1 }));
    store.seedAsset(asset({ id: assetV2, version: 2, sourceStorageKey: `${editionId}/${assetV2}/source.epub` }));
    seedQueuedJob(store, assetV1, "job-v1");
    seedQueuedJob(store, assetV2, "job-v2");

    // The stale job for v1 is claimed first (it was queued first)...
    const v1Job = await claimNextJob(store, "worker-a", 60);
    expect(v1Job?.targetId).toBe(assetV1);

    // ...but the newer asset's job is claimed and completes before v1 does, becoming the
    // edition's active output.
    const v2Job = await store.claimTarget(assetV2, "worker-b", 60);
    expect(v2Job?.targetId).toBe(assetV2);
    await processJob(store, v2Job!);
    const activeOutputBefore = store.publications.get(assetV2);
    expect(activeOutputBefore).toBeDefined();

    // Only now does the slower, stale job for v1 finish.
    const outcome = await processJob(store, v1Job!);

    expect(outcome).toMatchObject({ outcome: "failed", failure: { code: "STALE_VERSION", retryable: false } });
    expect(store.jobs.get("job-v1")?.status).toBe("failed");
    expect(store.publications.has(assetV1)).toBe(false);
    expect(store.publications.get(assetV2)).toEqual(activeOutputBefore);
  });
});

describe("processJob double-fault handling (Ruling BB)", () => {
  // Reachable on the default lease/poll-loop settings, not just a misconfiguration: if
  // processing outlives the lease, another worker's poll can reclaim it before the original
  // worker calls store.fail(). That call is then itself rejected by the same lease-ownership
  // guard that makes complete()/fail() safe (Ruling AK) - this proves the *original* failure
  // (and its correlation id) still comes back to the caller rather than being swallowed by
  // the secondary rejection.
  it("still returns the original failure - not the lease rejection - when store.fail() itself is rejected", async () => {
    let now = 1_000_000;
    const store = new InMemoryJobStore({ now: () => now });
    // Invalid bytes: guarantees processJob fails before ever reaching store.complete()/
    // store.fail() the "normal" way.
    store.seedAsset(asset({ sourceBytes: epubMissingContainer() }));
    seedQueuedJob(store);

    const originalJob = await claimNextJob(store, "worker-a", 30);
    expect(originalJob).not.toBeNull();

    // The lease expires, and a second worker's poll loop reclaims the very same job before
    // worker-a gets around to recording its own failure.
    now += 60_000;
    const reclaimedByB = await store.claimNext("worker-b", 60);
    expect(reclaimedByB?.leaseOwner).toBe("worker-b");

    // worker-a, unaware its lease is gone, finishes processing (fails on the invalid EPUB)
    // and tries to record it under its own now-stale ProcessingJob reference.
    const outcome = await processJob(store, originalJob!);

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") {
      // The original failure code and message survive - never replaced by the lease
      // rejection that stopped store.fail() from recording it.
      expect(outcome.failure.code).toBe("INVALID_EPUB");
      expect(outcome.recordFailureError).toBeDefined();
    }
    // The job's real, authoritative state reflects worker-b's claim, not a corrupted mix -
    // worker-a's rejected fail() call mutated nothing.
    expect(store.jobs.get("job-1")?.leaseOwner).toBe("worker-b");
  });
});

describe("processJob retry determinism", () => {
  it("writes the same versioned derived keys when the same job is retried after a failure", async () => {
    const failingKey = deriveResourceStorageKey({ editionId, targetId: assetV1 }, "OEBPS/text/chapter2.xhtml");
    const store = new InMemoryJobStore({ failStorageOnce: new Set([failingKey]) });
    store.seedAsset(asset());
    seedQueuedJob(store);

    const attempt1Job = await claimNextJob(store, "worker-a", 60);
    const attempt1 = await processJob(store, attempt1Job!);
    expect(attempt1.outcome).toBe("failed");
    const keysAfterAttempt1 = [...store.derivedWriteLog];
    expect(keysAfterAttempt1).not.toHaveLength(0);
    expect(keysAfterAttempt1).not.toContain(failingKey);

    // Explicit retry: an operator reclaims the same job (still failed) by its target asset.
    const attempt2Job = await store.claimTarget(assetV1, "worker-a", 60);
    expect(attempt2Job?.attempt).toBe(2);
    const attempt2 = await processJob(store, attempt2Job!);

    expect(attempt2.outcome).toBe("completed");
    // Every key written during the failed attempt was written again, identically, on retry.
    for (const key of keysAfterAttempt1) {
      expect(store.derivedWriteLog.filter((k) => k === key)).toHaveLength(2);
    }
    expect(store.derivedWriteLog).toContain(failingKey);

    const pub = store.publications.get(assetV1);
    expect(pub?.manifestKey).toBe(deriveManifestStorageKey(attempt1Job!));
    expect(pub?.manifestKey).toBe(deriveManifestStorageKey(attempt2Job!));
  });
});
