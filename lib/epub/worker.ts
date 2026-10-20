// Orchestrates one processing_jobs row's full lifecycle on top of any JobStore
// implementation (lib/epub/job-store.ts): download the source EPUB, run it through the pure
// processor (lib/epub/process.ts), upload every derived resource plus the publication
// manifest, and record success or a typed failure. Framework-neutral by construction (spec
// 4.3) - swap in a different JobStore (e.g. a future hosted Cloud Run executor's) and this
// file does not change.
import { createHash } from "node:crypto";

import { ProcessingError, processingFailure, type ProcessingFailure } from "@/lib/epub/errors";
import { buildManifest, type JobStore, type ProcessingJob } from "@/lib/epub/job-store";
import { processEpub, type ProcessingPolicy } from "@/lib/epub/process";
import type { ProcessedPublication } from "@/lib/epub/types";

export type ProcessJobOutcome =
  | { outcome: "completed"; publication: ProcessedPublication }
  // `recordFailureError` is set only in the fix-round-1 (Ruling BB) double-fault case: the
  // lease was reclaimed by another worker between the original failure and this worker's own
  // `store.fail()` call, so the failure could not be recorded. `failure` is always the
  // *original* failure - never the secondary lease rejection - so a caller can still surface
  // the real code and correlation id even when recording it failed.
  | { outcome: "failed"; failure: ProcessingFailure; recordFailureError?: unknown };

// The brief names this pair `claimNextJob(workerId)` / `processJob(jobId, workerId)`. This
// implementation threads a `JobStore` explicitly (so worker.test.ts can pass an
// `InMemoryJobStore` with no real I/O) and `processJob` takes the already-claimed
// `ProcessingJob` record - which carries its own lease owner - rather than a bare job id, so
// complete()/fail() never need a redundant re-lookup or a separate workerId parameter of
// their own. `scripts/ebook.ts` is what actually exposes `process --asset`/`process-next`/
// `retry --job` in terms of a job id and a worker id.
export async function claimNextJob(store: JobStore, workerId: string, leaseSeconds: number): Promise<ProcessingJob | null> {
  return store.claimNext(workerId, leaseSeconds);
}

function toFailure(error: unknown): ProcessingFailure {
  if (error instanceof ProcessingError) return error.failure;
  const message = error instanceof Error ? error.message : String(error);
  return processingFailure("PROCESSING_FAILURE", message);
}

// Runs one already-claimed job to completion or to a recorded failure. Every failure mode -
// an invalid EPUB, a storage error uploading a derived resource, or a stale asset version
// detected only once `complete()` is attempted - flows through the same catch block and the
// same `store.fail()` call, so there is exactly one place that ever writes a failure.
export async function processJob(store: JobStore, job: ProcessingJob, policy?: ProcessingPolicy): Promise<ProcessJobOutcome> {
  try {
    const bytes = await store.downloadSource(job);
    const actualChecksum = createHash("sha256").update(bytes).digest("hex");
    if (actualChecksum !== job.sourceChecksum.toLowerCase()) {
      throw new ProcessingError(
        processingFailure(
          "SOURCE_CHECKSUM_MISMATCH",
          `Source checksum does not match the finalized upload for asset ${job.targetId}`,
        ),
      );
    }
    const publication = await processEpub(bytes, policy);

    for (const resource of publication.resources) {
      await store.putDerived(job, resource);
    }
    await store.putManifest(job, buildManifest(publication));
    await store.complete(job, publication);

    return { outcome: "completed", publication };
  } catch (error) {
    const failure = toFailure(error);
    try {
      await store.fail(job, failure);
    } catch (recordFailureError) {
      // Ruling BB: on the default lease/poll-loop settings this is reachable - not just a
      // misconfiguration - if processing outlives the lease and another worker's poll
      // reclaims it before this call. `store.fail()`'s own lease-ownership guard (Ruling AK)
      // is what rejects it here. Losing the original `failure` (and the caller's ability to
      // report `job.correlationId` against it) would defeat Ruling Y on exactly the path an
      // operator most needs to trace, so this returns the *original* failure regardless -
      // never letting the secondary rejection replace or swallow it.
      return { outcome: "failed", failure, recordFailureError };
    }
    return { outcome: "failed", failure };
  }
}
