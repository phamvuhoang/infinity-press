// IO boundary around the pure `processEpub()` pipeline (Task 4). This module owns
// everything process.ts deliberately does not: claiming a queued `processing_jobs` row
// under a lease, downloading source bytes, uploading derived resources/manifest, and
// persisting the resulting `ebook_publications`/`ebook_resources`/`book_samples` rows or a
// recorded failure. worker.ts consumes only the `JobStore` interface below, so a future
// hosted Cloud Run executor can supply a different implementation unchanged.
//
// This file - and everything that imports it (worker.ts, scripts/ebook.ts) - must never
// import "server-only" or anything that transitively does (lib/supabase/admin.ts,
// lib/supabase/server.ts, lib/epub/upload.ts, lib/config/server-env.ts). The CLI runs as a
// plain Node/tsx process outside any Next.js request, and the "server-only" package
// (node_modules/server-only/index.js) throws unconditionally when resolved outside the
// "react-server" bundler condition - which a bare Node runtime never sets. vitest.config.ts
// aliases "server-only" to its empty.js stub for tests only; that alias does not exist for a
// real `npm run ebook` invocation, so this module deliberately builds its own Supabase
// client instead of reusing lib/supabase/admin.ts's createAdminClient().
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

import { isSecureOrLoopbackUrl } from "@/lib/config/url";
import { EBOOK_DERIVED_BUCKET, EBOOK_SOURCE_BUCKET } from "@/lib/epub/constants";
import { ProcessingError, processingFailure, type ProcessingFailure } from "@/lib/epub/errors";
import {
  DEFAULT_STORAGE_RETRY,
  describeStorageError,
  withStorageRetry,
  type StorageRetryPolicy,
} from "@/lib/epub/storage-retry";
import type {
  ProcessedPublication,
  ProcessedResource,
  PublicationMetadata,
  ReadingOrderItem,
  TocEntry,
} from "@/lib/epub/types";
// Type-only: database.types.ts has no imports of its own (confirmed - it is pure generated
// types), so pulling only the `Database` type in does not risk dragging in "server-only".
// Fix round 1, Ruling BC: parameterizing the client with this type turns RPC name typos,
// wrong argument names/shapes, and wrong Returns shapes (the hand-written `ClaimJobRow`
// below) into compile errors instead of only-caught-by-a-manual-run drift.
import type { Database } from "@/lib/supabase/database.types";

export { EBOOK_DERIVED_BUCKET, EBOOK_SOURCE_BUCKET };

// One claimed `processing_jobs` row, joined with the immutable `ebook_assets` fields the
// worker needs to resolve storage keys - never re-derived from a second lookup once
// claimed. `leaseOwner` is threaded through complete()/fail() instead of a separate
// parameter so those methods keep the brief's exact `complete(job, publication)` /
// `fail(job, failure)` shape while the Supabase implementation still has the worker id it
// needs for the RPCs' lease-ownership check (Ruling AK).
export type ProcessingJob = {
  id: string;
  targetId: string; // ebook_assets.id
  editionId: string;
  version: number;
  sourceStorageKey: string;
  sourceChecksum: string;
  attempt: number;
  correlationId: string;
  leaseOwner: string;
};

// The object this module writes to `ebook_publications.manifest_key`. Deliberately holds no
// storage keys and no credentials - Task 8's manifest route resolves authenticated resource
// URLs itself, keyed by `href`, from `ebook_resources`; this object never needs to carry a
// storage-addressable path anywhere a browser (even indirectly) could see it.
export type PublicationManifest = {
  metadata: PublicationMetadata;
  readingOrder: ReadingOrderItem[];
  toc: TocEntry[];
};

export function buildManifest(publication: ProcessedPublication): PublicationManifest {
  return { metadata: publication.metadata, readingOrder: publication.readingOrder, toc: publication.toc };
}

// Ruling AU: bucket-relative, no bucket segment, scoped under the immutable asset (which
// already carries a fixed edition + version) - `{editionId}/{assetId}/...`, mirroring
// `ebook_assets.source_storage_key`'s `{editionId}/{assetId}/source.epub`
// (20260911160000_ebook_storage.sql). A function of (editionId, targetId, href) alone -
// never `attempt` - so retrying the same job writes the exact same key every time.
function assertSafeHref(href: string): void {
  const segments = href.split("/");
  const unsafe = href.startsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (unsafe) {
    throw new ProcessingError(processingFailure("INVALID_EPUB", `Resource href is not a safe storage path segment: ${href}`));
  }
}

export function deriveResourceStorageKey(job: Pick<ProcessingJob, "editionId" | "targetId">, href: string): string {
  assertSafeHref(href);
  return `${job.editionId}/${job.targetId}/${href}`;
}

export function deriveManifestStorageKey(job: Pick<ProcessingJob, "editionId" | "targetId">): string {
  return `${job.editionId}/${job.targetId}/manifest.json`;
}

// IO boundary the pure processor (Task 4) is deliberately free of. `claimNext`/`claimTarget`
// return null rather than throwing when there is nothing eligible to claim - "no work" is a
// normal outcome for a polling CLI, not a failure.
export interface JobStore {
  claimNext(workerId: string, leaseSeconds: number): Promise<ProcessingJob | null>;
  // Beyond the brief's minimum contract: claims one specific job by its target asset id.
  // Used by `process --asset <uuid>` and by `retry --job <uuid>` (after resolving the job's
  // target id). claimNext() never picks up a `failed` job on its own - only this explicit,
  // operator-directed call can reclaim one - so a generic poll never silently retries
  // something an operator hasn't looked at.
  claimTarget(targetId: string, workerId: string, leaseSeconds: number): Promise<ProcessingJob | null>;
  downloadSource(job: ProcessingJob): Promise<Uint8Array>;
  putDerived(job: ProcessingJob, resource: ProcessedResource): Promise<void>;
  // Beyond the brief's minimum contract: uploads the manifest object (buildManifest()'s
  // output) to its deterministic key and returns that key. Kept out of complete() itself
  // because the manifest bytes must exist in storage before complete() records
  // manifest_key - but complete() re-derives the same key with deriveManifestStorageKey()
  // rather than accepting it as a parameter, so the two can never disagree.
  putManifest(job: ProcessingJob, manifest: PublicationManifest): Promise<string>;
  complete(job: ProcessingJob, publication: ProcessedPublication): Promise<void>;
  fail(job: ProcessingJob, failure: ProcessingFailure): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// In-memory fake, used by job-store.test.ts and worker.test.ts. Mirrors the Supabase
// implementation's semantics exactly (same lease rules, same stale-version detection, same
// "detect-and-raise, never mutate" contract for complete()) so a test written against this
// fake documents a real property of `claim_processing_job`/`complete_processing_job`/
// `fail_processing_job`, not an incidental behavior of the fake alone.
// ---------------------------------------------------------------------------------------

export type FakeAsset = {
  id: string;
  editionId: string;
  version: number;
  sourceStorageKey: string;
  sourceChecksum: string;
  sourceBytes: Uint8Array;
  status: string;
};

export type FakeJobStatus = "queued" | "processing" | "failed" | "completed";

export type FakeJob = {
  id: string;
  targetId: string;
  status: FakeJobStatus;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null; // epoch ms
  errorCode: string | null;
  errorMessage: string | null;
  correlationId: string;
  createdAt?: number;
};

export type FakePublication = {
  id: string;
  assetId: string;
  editionId: string;
  version: number;
  manifestKey: string;
  toc: TocEntry[];
  resources: {
    href: string;
    mediaType: string;
    storageKey: string;
    byteSize: number;
    sha256: string;
    accessClass: string;
  }[];
  sampleHrefs: string[];
  searchChunks: ProcessedPublication["searchChunks"];
  positions: ProcessedPublication["positions"];
};

export type InMemoryJobStoreOptions = {
  now?: () => number;
  // Simulates a storage failure for a specific derived key on the *next* write only, then
  // heals - matching a transient infrastructure blip rather than a permanently broken
  // bucket, and letting a retry-determinism test succeed on the second attempt.
  failStorageOnce?: Set<string>;
};

export class InMemoryJobStore implements JobStore {
  readonly assets = new Map<string, FakeAsset>();
  readonly jobs = new Map<string, FakeJob>();
  readonly derivedObjects = new Map<string, Uint8Array>();
  readonly derivedWriteLog: string[] = [];
  // Keyed by assetId, matching `ebook_publications.ebook_asset_id`'s uniqueness - one
  // asset ever produces at most one publication.
  readonly publications = new Map<string, FakePublication>();

  private readonly now: () => number;
  private readonly failStorageOnce: Set<string>;
  private nextCreatedAt = 0;

  constructor(options: InMemoryJobStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.failStorageOnce = options.failStorageOnce ?? new Set();
  }

  seedAsset(asset: FakeAsset): void {
    this.assets.set(asset.id, asset);
  }

  seedJob(job: FakeJob): void {
    this.jobs.set(job.id, { ...job, createdAt: job.createdAt ?? this.nextCreatedAt++ });
  }

  private eligibleJob(predicate: (job: FakeJob) => boolean): FakeJob | undefined {
    return [...this.jobs.values()]
      .filter(predicate)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
  }

  private claim(job: FakeJob, workerId: string, leaseSeconds: number): ProcessingJob {
    const asset = this.assets.get(job.targetId);
    if (!asset) throw new Error(`InMemoryJobStore: no seeded asset for target ${job.targetId}`);

    job.status = "processing";
    job.leaseOwner = workerId;
    job.leaseExpiresAt = this.now() + leaseSeconds * 1000;
    job.attempt += 1;
    job.errorCode = null;
    job.errorMessage = null;
    asset.status = "processing";

    return {
      id: job.id,
      targetId: job.targetId,
      editionId: asset.editionId,
      version: asset.version,
      sourceStorageKey: asset.sourceStorageKey,
      sourceChecksum: asset.sourceChecksum,
      attempt: job.attempt,
      correlationId: job.correlationId,
      leaseOwner: workerId,
    };
  }

  async claimNext(workerId: string, leaseSeconds: number): Promise<ProcessingJob | null> {
    const now = this.now();
    const job = this.eligibleJob((j) => j.status === "queued" || (j.status === "processing" && (j.leaseExpiresAt ?? 0) < now));
    return job ? this.claim(job, workerId, leaseSeconds) : null;
  }

  async claimTarget(targetId: string, workerId: string, leaseSeconds: number): Promise<ProcessingJob | null> {
    const now = this.now();
    const job = this.eligibleJob(
      (j) =>
        j.targetId === targetId &&
        (j.status === "queued" || j.status === "failed" || (j.status === "processing" && (j.leaseExpiresAt ?? 0) < now)),
    );
    return job ? this.claim(job, workerId, leaseSeconds) : null;
  }

  async downloadSource(job: ProcessingJob): Promise<Uint8Array> {
    const asset = this.assets.get(job.targetId);
    if (!asset) {
      throw new ProcessingError(processingFailure("STORAGE_FAILURE", `no source object at ${job.sourceStorageKey}`));
    }
    return asset.sourceBytes;
  }

  private writeDerived(key: string): void {
    if (this.failStorageOnce.delete(key)) {
      throw new ProcessingError(processingFailure("STORAGE_FAILURE", `simulated storage failure writing ${key}`));
    }
    this.derivedWriteLog.push(key);
  }

  async putDerived(job: ProcessingJob, resource: ProcessedResource): Promise<void> {
    const key = deriveResourceStorageKey(job, resource.href);
    this.writeDerived(key);
    this.derivedObjects.set(key, resource.bytes);
  }

  async putManifest(job: ProcessingJob, manifest: PublicationManifest): Promise<string> {
    const key = deriveManifestStorageKey(job);
    this.writeDerived(key);
    this.derivedObjects.set(key, new TextEncoder().encode(JSON.stringify(manifest)));
    return key;
  }

  // Mirrors the RPCs' lease-ownership guard (Ruling AK): complete()/fail() must reject a
  // caller that does not currently hold the job's lease, whether because another worker
  // already reclaimed it after expiry or because the caller never held it at all.
  private requireHeldLease(job: ProcessingJob): FakeJob {
    const fakeJob = this.jobs.get(job.id);
    if (!fakeJob) throw new Error(`InMemoryJobStore: job ${job.id} does not exist`);
    const stillHeld = fakeJob.status === "processing" && fakeJob.leaseOwner === job.leaseOwner && (fakeJob.leaseExpiresAt ?? 0) > this.now();
    if (!stillHeld) {
      throw new Error(`InMemoryJobStore: worker ${job.leaseOwner} does not hold the lease for job ${job.id}`);
    }
    return fakeJob;
  }

  async complete(job: ProcessingJob, publication: ProcessedPublication): Promise<void> {
    const fakeJob = this.requireHeldLease(job);
    const asset = this.assets.get(job.targetId);
    if (!asset) throw new Error(`InMemoryJobStore: no seeded asset for target ${job.targetId}`);

    const maxVersion = Math.max(
      ...[...this.assets.values()].filter((a) => a.editionId === asset.editionId).map((a) => a.version),
    );
    if (maxVersion > job.version) {
      // Mirrors complete_processing_job: detect-and-raise only, no mutation. The worker's
      // catch block is what actually calls fail() to record STALE_VERSION and clear the
      // lease - this keeps a stale completion from ever touching the newer active output.
      throw new ProcessingError(
        processingFailure(
          "STALE_VERSION",
          `asset ${job.targetId} (version ${job.version}) is stale; edition ${asset.editionId} has version ${maxVersion}`,
        ),
      );
    }

    // Build and validate every row before changing any fake database state. This mirrors the
    // SQL RPC transaction: a malformed final chunk cannot leave a ready publication with a
    // partial private index behind.
    const resourceHrefs = new Set(publication.resources.map((resource) => resource.href));
    for (const chunk of publication.searchChunks) {
      if (!resourceHrefs.has(chunk.href)) throw new Error(`InMemoryJobStore: search chunk href ${chunk.href} is not a publication resource`);
    }
    for (const position of publication.positions) {
      if (!resourceHrefs.has(position.href)) throw new Error(`InMemoryJobStore: position href ${position.href} is not a publication resource`);
    }

    this.publications.set(asset.id, {
      id: `pub-${asset.id}`,
      assetId: asset.id,
      editionId: asset.editionId,
      version: job.version,
      manifestKey: deriveManifestStorageKey(job),
      toc: publication.toc,
      resources: publication.resources.map((resource) => ({
        href: resource.href,
        mediaType: resource.mediaType,
        storageKey: deriveResourceStorageKey(job, resource.href),
        byteSize: resource.byteSize,
        sha256: resource.sha256,
        accessClass: resource.accessClass,
      })),
      sampleHrefs: publication.sampleHrefs,
      searchChunks: publication.searchChunks,
      positions: publication.positions,
    });

    fakeJob.status = "completed";
    fakeJob.leaseOwner = null;
    fakeJob.leaseExpiresAt = null;
    asset.status = "ready_for_preview";
  }

  async fail(job: ProcessingJob, failure: ProcessingFailure): Promise<void> {
    const fakeJob = this.requireHeldLease(job);
    const asset = this.assets.get(job.targetId);

    fakeJob.status = "failed";
    fakeJob.errorCode = failure.code;
    fakeJob.errorMessage = failure.message;
    fakeJob.leaseOwner = null;
    fakeJob.leaseExpiresAt = null;
    if (asset) asset.status = "failed";
  }
}

// ---------------------------------------------------------------------------------------
// Supabase-backed implementation. Calls the three service-role-only RPCs from
// supabase/migrations/20260911170000_processing_job_rpcs.sql and uses the Storage API with
// keys derived only from the immutable asset/version - never a caller-supplied path.
// ---------------------------------------------------------------------------------------

type ClaimJobRow = {
  job_id: string;
  target_id: string;
  edition_id: string;
  version: number;
  source_storage_key: string;
  source_checksum: string;
  attempt: number;
  correlation_id: string;
};

function rowToJob(row: ClaimJobRow, workerId: string): ProcessingJob {
  return {
    id: row.job_id,
    targetId: row.target_id,
    editionId: row.edition_id,
    version: row.version,
    sourceStorageKey: row.source_storage_key,
    sourceChecksum: row.source_checksum,
    attempt: row.attempt,
    correlationId: row.correlation_id,
    leaseOwner: workerId,
  };
}

// SQLSTATE `complete_processing_job` raises when the job's target asset is no longer the
// newest version for its edition. Not a Postgres-reserved code - chosen so the TS layer can
// distinguish "stale" from every other RPC failure without parsing the message text
// (Ruling AS: a privilege/lease failure must never be mistaken for this, and vice versa).
export const STALE_VERSION_SQLSTATE = "EB001";

export class SupabaseJobStore implements JobStore {
  // `retry` is injectable only so tests can drop the real backoff waits; production always
  // takes the default. See lib/epub/storage-retry.ts for why the uploads need one at all.
  constructor(
    private readonly client: SupabaseClient<Database>,
    private readonly retry: StorageRetryPolicy = DEFAULT_STORAGE_RETRY,
  ) {}

  async claimNext(workerId: string, leaseSeconds: number): Promise<ProcessingJob | null> {
    return this.claim(workerId, leaseSeconds, null);
  }

  async claimTarget(targetId: string, workerId: string, leaseSeconds: number): Promise<ProcessingJob | null> {
    return this.claim(workerId, leaseSeconds, targetId);
  }

  private async claim(workerId: string, leaseSeconds: number, targetId: string | null): Promise<ProcessingJob | null> {
    // The generated `p_target_id?: string` argument type (optional, but never `null`) means
    // "any eligible job" is expressed by omitting the key entirely - PostgREST then falls
    // through to the SQL function's own `default null` - rather than by passing `null`.
    const { data, error } = await this.client.rpc("claim_processing_job", {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
      ...(targetId ? { p_target_id: targetId } : {}),
    });
    if (error) throw new Error(`claim_processing_job failed: ${error.message}`);
    const row = (data as ClaimJobRow[] | null)?.[0];
    return row ? rowToJob(row, workerId) : null;
  }

  async downloadSource(job: ProcessingJob): Promise<Uint8Array> {
    const { data, error } = await this.client.storage.from(EBOOK_SOURCE_BUCKET).download(job.sourceStorageKey);
    if (error || !data) {
      throw new ProcessingError(
        processingFailure("STORAGE_FAILURE", `failed to download source ${job.sourceStorageKey}: ${error ? describeStorageError(error) : "no data returned"}`),
      );
    }
    return new Uint8Array(await data.arrayBuffer());
  }

  async putDerived(job: ProcessingJob, resource: ProcessedResource): Promise<void> {
    const key = deriveResourceStorageKey(job, resource.href);
    // The same `upsert: true` that makes a whole-job retry safe makes a per-request retry
    // safe: a resource re-PUT after a dropped socket overwrites its own deterministic key.
    const { error } = await withStorageRetry(
      () =>
        this.client.storage.from(EBOOK_DERIVED_BUCKET).upload(key, resource.bytes, {
          contentType: resource.mediaType,
          // Idempotent on purpose: retrying the same job re-uploads the same key rather than
          // erroring "already exists" (Step 1's retry-determinism requirement).
          upsert: true,
        }),
      this.retry,
    );
    if (error) {
      throw new ProcessingError(
        processingFailure("STORAGE_FAILURE", `failed to upload derived resource ${resource.href}: ${describeStorageError(error)}`),
      );
    }
  }

  async putManifest(job: ProcessingJob, manifest: PublicationManifest): Promise<string> {
    const key = deriveManifestStorageKey(job);
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    const { error } = await withStorageRetry(
      () =>
        this.client.storage.from(EBOOK_DERIVED_BUCKET).upload(key, bytes, {
          contentType: "application/webpub+json",
          upsert: true,
        }),
      this.retry,
    );
    if (error) {
      throw new ProcessingError(processingFailure("STORAGE_FAILURE", `failed to upload manifest: ${describeStorageError(error)}`));
    }
    return key;
  }

  async complete(job: ProcessingJob, publication: ProcessedPublication): Promise<void> {
    const resources = publication.resources.map((resource) => ({
      href: resource.href,
      media_type: resource.mediaType,
      storage_key: deriveResourceStorageKey(job, resource.href),
      byte_size: resource.byteSize,
      sha256: resource.sha256,
      access_class: resource.accessClass,
    }));
    const searchChunks = publication.searchChunks.map((chunk) => ({
      href: chunk.href,
      chapter_title: chunk.chapterTitle,
      ordinal: chunk.ordinal,
      plain_text: chunk.plainText,
      locator_json: chunk.locator,
    }));

    const { error } = await this.client.rpc("complete_processing_job", {
      p_job_id: job.id,
      p_worker_id: job.leaseOwner,
      p_manifest_key: deriveManifestStorageKey(job),
      p_toc: publication.toc,
      p_resources: resources,
      p_sample_hrefs: publication.sampleHrefs,
      p_search_chunks: searchChunks,
      p_positions: publication.positions,
    });

    if (error) {
      if (error.code === STALE_VERSION_SQLSTATE) {
        throw new ProcessingError(processingFailure("STALE_VERSION", error.message));
      }
      throw new Error(`complete_processing_job failed: ${error.message}`);
    }
  }

  async fail(job: ProcessingJob, failure: ProcessingFailure): Promise<void> {
    const { error } = await this.client.rpc("fail_processing_job", {
      p_job_id: job.id,
      p_worker_id: job.leaseOwner,
      p_error_code: failure.code,
      p_error_message: failure.message,
    });
    if (error) throw new Error(`fail_processing_job failed: ${error.message}`);
  }
}

export type JobStoreEnv = { supabaseUrl: string; serviceRoleKey: string };

function readJobStoreEnv(values: Record<string, string | undefined>): JobStoreEnv {
  const supabaseUrl = values.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = values.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey || !isSecureOrLoopbackUrl(supabaseUrl)) {
    throw new Error(
      "job-store: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set, with an HTTPS or loopback-HTTP URL (see .env.example).",
    );
  }
  return { supabaseUrl, serviceRoleKey };
}

// The CLI's own client construction - deliberately not lib/supabase/admin.ts (see the
// module header). Never exposed through NEXT_PUBLIC_*; this key only ever lives in
// process.env for the CLI's own process.
export function createJobStoreClient(env: Record<string, string | undefined> = process.env): SupabaseClient<Database> {
  const { supabaseUrl, serviceRoleKey } = readJobStoreEnv(env);
  return createSupabaseClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
