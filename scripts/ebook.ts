#!/usr/bin/env -S npx tsx
// Local EPUB processing worker CLI (spec 4.3 / Task 5). Runs as a plain Node/tsx process
// holding the service-role credential, outside any Next.js request - a future hosted Cloud
// Run executor is expected to wrap the exact same lib/epub/worker.ts + lib/epub/job-store.ts
// with different IO, not to fork this file.
//
// Commands:
//   ebook validate <file.epub>              Run the pure processor locally; touches no
//                                            database or storage. Useful before uploading.
//   ebook process --asset <uuid>            Claim and run the specific job whose target is
//                                            <uuid> (must currently be queued, or processing
//                                            with an expired lease).
//   ebook process-next                      Claim and run whatever job is next in the queue.
//   ebook retry --job <uuid>                Reclaim a job that is currently `failed` (looked
//                                            up by job id) and run it again. Does not bypass
//                                            the lease mechanism - if another worker holds an
//                                            unexpired lease on it, this reports no work.
//
// Every command prints a small JSON summary to stdout on success. Every failure prints the
// job's correlation id and the stable ProcessingFailureCode to stderr and exits non-zero -
// never EPUB text, never the service-role credential.
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { parseArgs } from "node:util";

import { processingFailure, type ProcessingFailure } from "@/lib/epub/errors";
import { createJobStoreClient, SupabaseJobStore, type ProcessingJob } from "@/lib/epub/job-store";
import { processEpub } from "@/lib/epub/process";
import { SearchBackfillError, indexPublicationSearch } from "@/lib/epub/search-backfill";
import { claimNextJob, processJob } from "@/lib/epub/worker";

// Loads .env.local the same way `next dev` does, for a bare `npm run ebook` invocation. Not
// an error if the file is absent (e.g. a hosted CI runner injecting env vars directly) -
// only NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY being unset is fatal, and
// job-store.ts's createJobStoreClient() already reports that clearly.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local - fall back to whatever the shell/CI already exported.
}

// Overridable via EBOOK_LEASE_SECONDS (or per-run via --lease) rather than only a fixed
// constant. Fix round 1, Ruling BB: 300s is not generous - derived-resource uploads run
// serially over the network (worker.ts), and a 100 MiB EPUB (the bucket ceiling) with many
// resources can plausibly exceed it. See docs/runbooks/epub-processing.md's "Known gaps"
// section for the operational mitigation (a real fix needs a lease heartbeat, out of scope
// here).
const DEFAULT_LEASE_SECONDS = (() => {
  const fromEnv = process.env.EBOOK_LEASE_SECONDS ? Number.parseInt(process.env.EBOOK_LEASE_SECONDS, 10) : NaN;
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 300;
})();

function defaultWorkerId(): string {
  return `${hostname()}-${process.pid}`;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Set as soon as a job is successfully claimed, so main()'s top-level catch can still
// attribute an otherwise-generic uncaught error to a correlation id (Ruling Y) instead of
// reporting nothing at all. runClaimedJob() always reports through reportFailure()/
// reportSuccess() on its own successful paths - this is only consulted for something that
// escapes those (e.g. a network error between claiming and the first store call).
let currentJob: Pick<ProcessingJob, "id" | "correlationId"> | null = null;

// Prints exactly what an operator needs to correlate this CLI run with the web request that
// queued it (Ruling Y) and the stable failure taxonomy (lib/epub/errors.ts) - never the EPUB
// content or the service-role key. `recordFailureError` is set only in the fix-round-1
// double-fault case (Ruling BB): the failure itself is always the real one, but recording it
// via store.fail() was itself rejected (typically because another worker's poll reclaimed
// the lease first) - surfaced as a `recordFailureError` note rather than silently dropped.
function reportFailure(
  job: Pick<ProcessingJob, "id" | "correlationId">,
  failure: ProcessingFailure,
  recordFailureError?: unknown,
): never {
  process.stderr.write(
    `${JSON.stringify({
      jobId: job.id,
      correlationId: job.correlationId,
      code: failure.code,
      retryable: failure.retryable,
      message: failure.message,
      ...(recordFailureError !== undefined
        ? {
            recordFailureError:
              recordFailureError instanceof Error ? recordFailureError.message : String(recordFailureError),
          }
        : {}),
    })}\n`,
  );
  process.exit(1);
}

function reportSuccess(summary: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function runValidate(filePath: string): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    fail(`validate: could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const publication = await processEpub(bytes);
    reportSuccess({
      valid: true,
      title: publication.metadata.title,
      resourceCount: publication.resources.length,
      readingOrderLength: publication.readingOrder.length,
      sampleHrefs: publication.sampleHrefs,
    });
  } catch (error) {
    const failure = error instanceof Error && "code" in error ? (error as unknown as ProcessingFailure) : processingFailure("PROCESSING_FAILURE", String(error));
    process.stderr.write(`${JSON.stringify({ valid: false, code: failure.code, message: failure.message })}\n`);
    process.exit(1);
  }
}

// Shared tail end for process/process-next/retry: run the already-claimed job and report.
async function runClaimedJob(store: SupabaseJobStore, job: ProcessingJob): Promise<void> {
  currentJob = job;
  const outcome = await processJob(store, job);
  if (outcome.outcome === "failed") {
    reportFailure(job, outcome.failure, outcome.recordFailureError);
  }
  reportSuccess({
    jobId: job.id,
    correlationId: job.correlationId,
    assetId: job.targetId,
    attempt: job.attempt,
    resourceCount: outcome.publication.resources.length,
  });
}

async function runProcessNext(workerId: string, leaseSeconds: number): Promise<void> {
  const store = new SupabaseJobStore(createJobStoreClient());
  const job = await claimNextJob(store, workerId, leaseSeconds);
  if (!job) {
    reportSuccess({ claimed: false, message: "no job available" });
    return;
  }
  await runClaimedJob(store, job);
}

async function runProcessAsset(assetId: string, workerId: string, leaseSeconds: number): Promise<void> {
  const store = new SupabaseJobStore(createJobStoreClient());
  const job = await store.claimTarget(assetId, workerId, leaseSeconds);
  if (!job) {
    fail(`process: no claimable job for asset ${assetId} (already processing under an active lease, or no such job)`);
  }
  await runClaimedJob(store, job);
}

async function runRetry(jobId: string, workerId: string, leaseSeconds: number): Promise<void> {
  const client = createJobStoreClient();
  // The lease-acquisition path (claim_processing_job) is the only thing allowed to move a
  // job out of `failed` - this just resolves the target id an operator-known job id maps to,
  // so `retry --job <uuid>` can go through the exact same claimTarget() as `process --asset`.
  const { data, error } = await client.from("processing_jobs").select("target_id").eq("id", jobId).maybeSingle();
  if (error) fail(`retry: failed to look up job ${jobId}: ${error.message}`);
  if (!data) fail(`retry: no such job ${jobId}`);

  const store = new SupabaseJobStore(client);
  const job = await store.claimTarget(data.target_id, workerId, leaseSeconds);
  if (!job) {
    fail(`retry: job ${jobId} is not in a reclaimable state (must be failed, queued, or processing with an expired lease)`);
  }
  // Defensive, not expected to ever fire: claimTarget() resolves by target_id, and
  // target_id carries no unique constraint of its own - it is only 1:1 with a job in
  // practice because admin_finalize_ebook_asset's `where status = 'uploading'` guard creates
  // at most one processing_jobs row per asset. If that invariant were ever broken, better to
  // fail loudly here than to silently run the wrong job under the requested job id.
  if (job.id !== jobId) {
    fail(`retry: claimed job ${job.id} for target ${data.target_id}, not the requested job ${jobId} - refusing to proceed`);
  }
  await runClaimedJob(store, job);
}

async function runIndexSearch(publicationId: string): Promise<void> {
  try {
    reportSuccess(await indexPublicationSearch(publicationId));
  } catch (error) {
    const code = error instanceof SearchBackfillError ? error.code : "INDEX_SEARCH_UNEXPECTED";
    process.stderr.write(`${JSON.stringify({ publicationId, code })}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      asset: { type: "string" },
      job: { type: "string" },
      publication: { type: "string" },
      worker: { type: "string" },
      lease: { type: "string" },
    },
  });

  const [command, ...rest] = positionals;
  const workerId = values.worker ?? defaultWorkerId();
  const parsedLease = values.lease ? Number.parseInt(values.lease, 10) : DEFAULT_LEASE_SECONDS;
  if (!Number.isFinite(parsedLease) || parsedLease <= 0) fail(`--lease must be a positive integer, got ${values.lease}`);
  const leaseSeconds = parsedLease;

  switch (command) {
    case "validate": {
      const filePath = rest[0];
      if (!filePath) fail("validate: usage: ebook validate <file.epub>");
      await runValidate(filePath);
      return;
    }
    case "process": {
      if (!values.asset) fail("process: usage: ebook process --asset <uuid>");
      await runProcessAsset(values.asset, workerId, leaseSeconds);
      return;
    }
    case "process-next": {
      await runProcessNext(workerId, leaseSeconds);
      return;
    }
    case "retry": {
      if (!values.job) fail("retry: usage: ebook retry --job <uuid>");
      await runRetry(values.job, workerId, leaseSeconds);
      return;
    }
    case "index-search": {
      if (!values.publication) {
        process.stderr.write(`${JSON.stringify({ code: "INDEX_SEARCH_MISSING_PUBLICATION" })}\n`);
        process.exit(1);
      }
      await runIndexSearch(values.publication);
      return;
    }
    default: {
      fail(
        "usage: ebook <validate <file.epub> | process --asset <uuid> | process-next | retry --job <uuid> | index-search --publication <uuid>> [--worker <id>] [--lease <seconds>]",
      );
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      ...(currentJob ? { jobId: currentJob.id, correlationId: currentJob.correlationId } : {}),
      code: "PROCESSING_FAILURE",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
