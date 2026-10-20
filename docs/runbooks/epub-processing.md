# Runbook: local EPUB processing worker

The local job-processing CLI (`npm run ebook -- <command>`, `scripts/ebook.ts`) claims
`processing_jobs` rows created by the admin EPUB upload flow
(`lib/epub/upload.ts:finalizeEpubUpload`), downloads the source EPUB from the private
`ebook-source` bucket, runs it through the pure processor (`lib/epub/process.ts`), and
uploads the derived resources and manifest to the private `ebook-derived` bucket before
recording success (`ebook_publications`/`ebook_resources`/`book_samples`) or a typed failure
back onto the job.

It is a plain Node/tsx process, not a Next.js route or Server Action - it holds the
service-role credential directly and is meant to be run by an operator (or, later, a cron/
queue trigger) next to the app, never from a browser.

## Environment setup

The CLI reads two environment variables directly from `process.env`:

- `NEXT_PUBLIC_SUPABASE_URL` - same value `next dev` uses.
- `SUPABASE_SERVICE_ROLE_KEY` - **never** set this as `NEXT_PUBLIC_*`; it must stay a
  server-only secret. The CLI never prints it, and `lib/epub/job-store.ts` deliberately does
  not import `lib/supabase/admin.ts` (see "Why not `lib/supabase/admin.ts`?" below).

Both must already be in your shell environment, or in `.env.local` at the repo root (the CLI
calls `process.loadEnvFile(".env.local")` on startup, the same file `next dev` reads - copy
`.env.example` and fill in the values from `supabase status` if you have not already). A
missing or invalid value fails fast with a clear message before any network call is made.

```bash
cp .env.example .env.local   # once, if you have not already
supabase start                # or: use the stack next dev already has running
npm run ebook -- validate path/to/book.epub
```

### Why not `lib/supabase/admin.ts`?

`lib/supabase/admin.ts` (and `lib/supabase/server.ts`, and `lib/epub/upload.ts`, which import
it) all start with `import "server-only"`. That package's real implementation
(`node_modules/server-only/index.js`) throws unconditionally unless resolved through the
`react-server` package-export condition - which only a bundler like webpack/Next.js sets, and
which a bare `tsx scripts/ebook.ts` invocation never does. `vitest.config.ts` aliases
`server-only` to a no-op stub for tests only, which is why this only surfaces when actually
running the CLI, not when running `npm test`. `lib/epub/job-store.ts` builds its own
`@supabase/supabase-js` client instead (`createJobStoreClient()`), and everything downstream
of it (`lib/epub/worker.ts`, `scripts/ebook.ts`) must keep doing the same - never add an
import back to `lib/supabase/admin.ts`/`lib/supabase/server.ts`/`lib/epub/upload.ts` from
that chain.

## Commands

```bash
npm run ebook -- validate <file.epub>       # pure local check, no database/storage calls
npm run ebook -- process --asset <uuid>     # claim and run the job for one specific asset
npm run ebook -- process-next               # claim and run whichever job is next in queue
npm run ebook -- retry --job <uuid>         # reclaim a failed job and run it again
npm run ebook -- index-search --publication <uuid> # rebuild private search rows from stored sanitized XHTML
```

Every command that touches a job accepts `--worker <id>` (defaults to
`<hostname>-<pid>`) and `--lease <seconds>` (defaults to `EBOOK_LEASE_SECONDS` if set, else
300). Use `--worker` to give a long-running worker a stable identity in logs, or to
distinguish two operators running the CLI at once. See "Sizing the lease" below before
relying on the 300 s default for anything but small test EPUBs.

On success, every job command prints one line of JSON to stdout, e.g.:

```json
{"jobId":"...","correlationId":"...","assetId":"...","attempt":1,"resourceCount":5}
```

On failure, the process exits non-zero and prints one line of JSON to **stderr** with the
job's correlation id and the stable failure code from `lib/epub/errors.ts` - never the EPUB's
content and never the service-role credential:

```json
{"jobId":"...","correlationId":"...","code":"UNSAFE_EXTERNAL_URL","retryable":false,"message":"..."}
```

The `correlationId` is the same value the admin upload flow generated from `x-request-id`
(`lib/observability/request-id.ts`) when the asset was finalized
(`admin_finalize_ebook_asset`'s `p_correlation_id`) and is stored on the `processing_jobs`
row. Grep the CLI's JSON output and the app's request logs for the same correlation id to
line up a single EPUB's web request, database row, and CLI run.

### `validate`

Runs `processEpub()` locally against a file on disk. Touches no database or storage - use it
before uploading to catch `INVALID_EPUB`/`UNSAFE_SCRIPT`/`UNSAFE_EXTERNAL_URL`/
`UNSUPPORTED_MEDIA`/`ASSET_TOO_LARGE` failures without spending an upload/processing cycle.

### `process --asset <uuid>`

Claims the specific job whose target is `<uuid>` (the `ebook_assets.id` you got back from the
admin upload UI or from `finalizeEpubUpload`'s job id lookup) and runs it synchronously. Only
succeeds if that job is currently `queued`, or `processing` with an expired lease. Prints an
error and exits 1 if there is nothing eligible to claim (e.g. another worker already holds an
active lease on it).

### `process-next`

Claims whichever job is next in the queue (oldest `queued`, or oldest `processing` with an
expired lease) and runs it. If the queue is empty, prints `{"claimed":false,...}` and exits
0 - "nothing to do" is a normal outcome for a polling worker, not a failure. Run this on a
loop (cron, systemd timer, or just a shell loop for local development) to drain the queue
continuously - but size the lease first (see "Sizing the lease" below); a bare
`while true; do npm run ebook -- process-next; sleep 5; done` is exactly the second worker
that can reclaim another invocation's still-in-progress lease on the 300 s default:

```bash
EBOOK_LEASE_SECONDS=1800 npm run ebook -- process-next  # or: --lease 1800
```

### `retry --job <uuid>`

Looks up the job's target asset id, then claims it the same way `process --asset` does - the
only difference is that `claim_processing_job` additionally allows reclaiming a `failed` job
when an explicit target id is given (never on a bare poll). This is a deliberately manual
step: a failure never auto-requeues itself. Fix whatever the recorded `error_code` points at
(re-upload a corrected EPUB for a content problem, or just wait out a transient storage
blip), then retry.

### `index-search --publication <uuid>`

Rebuilds private search chunks and digital positions for one existing publication from its stored
manifest and already-sanitized private XHTML resources. It is safe to repeat: it replaces only
that publication's search rows and `positions_json` in one database transaction. It never reads
the source EPUB, uploads or rewrites a derived object, changes a manifest, publication version or
status, or moves an active-publication pointer.

Run it only after confirming the shell targets the intended **local** stack; never run a cloud
backfill during development:

```bash
supabase status --workdir .superpowers/scratch/sbworkdir
# Confirm the API URL is http://127.0.0.1:57321 before exporting credentials.
eval "$(supabase status --workdir .superpowers/scratch/sbworkdir -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
npm run ebook -- index-search --publication <uuid>
```

Success prints one JSON line containing only `publicationId`, `chunkCount`, and `positionCount`.
Failures exit non-zero with the supplied identifier and a stable `INDEX_SEARCH_*` code; neither
path prints XHTML or search text. An invalid UUID is rejected before a database client or storage
call is made.

The annotation API uses `positions_json` as the authoritative reading-order membership index.
After the reader-depth schema is deployed, an older publication with a null positions list remains
readable and keeps its existing progress behavior, but creating an annotation fails with the
generic temporary-unavailable response until this command backfills that publication. Backfill
active publications before enabling the reader-depth annotation UI; do not infer spine membership
from resource paths or search text as a workaround.

## Job and asset states

| `processing_jobs.status` | `ebook_assets.status` | Meaning |
| --- | --- | --- |
| `queued` | `queued` | Waiting for a worker. |
| `processing` | `processing` | A worker holds the lease (`lease_owner`, `lease_expires_at`). |
| `completed` | `ready_for_preview` | Processing succeeded; a new `ebook_publications` row exists, ready for an admin to preview/publish (a later task). |
| `failed` | `failed` | Processing failed; `error_code`/`error_message` record why. Retryable per `lib/epub/errors.ts`'s `processingFailure()`, but never auto-retried - see `retry` above. |

`STALE_VERSION` is a distinct failure worth calling out: if a newer asset version is uploaded
for the same edition while an older version's job is still in flight, completing the older
job is rejected outright rather than silently overwriting or racing the newer publication.
The older job ends up `failed`/`STALE_VERSION`; nothing about the newer asset's publication is
touched. Do not retry a `STALE_VERSION` job - it will always lose to whatever is now the
newest version for that edition. If it genuinely needs reprocessing, re-upload it as a new
version instead.

`SOURCE_CHECKSUM_MISMATCH` is also non-retryable. It means the bytes downloaded from
`ebook-source` no longer match the checksum recorded when the browser finalized the upload. The
worker rejects the source before parsing or writing any derived resource. Do not retry that asset;
investigate the object and upload a new version from a trusted local copy.

This check only counts an asset once it has actually reached `queued` or later - an
abandoned `uploading` reservation (see "Abandoned uploads accumulate" below) never counts as
a "newer version" and can never wrongly fail an in-flight job for the real current version.
This is a deliberate filter, not an oversight: without it, every orphaned `uploading` row the
next section describes - and there is no reaper for them - would permanently and incorrectly
stale-fail whatever legitimate job was already running for that edition.

## PDF-export EPUBs and search chunking

Some EPUBs are page-for-page exports of a PDF: every page is a fixed viewport with a
background image, and every run of text is its own absolutely positioned `<div>`, started
afresh at each font change - so a single word is split across elements, mid-word:

```html
<div class="t" style="left:48.26px;top:78.57px;font-family:'epubf1'">Trong tr</div>
<div class="t" style="left:93.74px;top:78.57px;font-family:'epubf1'">ạ</div>
<div class="t" style="left:99.41px;top:78.57px;...">ng</div>
```

`lib/epub/search-index.ts` merges runs of consecutive short leaf `<div>`s back into chunks of
up to 1024 code points, joining them with a space only where the source actually had
whitespace. `<div>` is the only tag it will merge: `p`, `li`, `td`, `h1`-`h6` and the rest
each assert a distinct unit and stay individually addressable however short they are, and a
`<div>` of 200 code points or more is already its own searchable unit.

Without that merge the book above produced 37,499 chunks from 265,962 characters - a median
chunk of **one character**, no chunk containing a whole word, and a 14.2 MB
`complete_processing_job` payload that exceeded the statement timeout. With it: 1,072 chunks,
median 128 characters, 0.87 MB.

If a book still completes with a chunk count far above roughly one per 500 characters of
text, check its markup before publishing - full-text search over that publication will be
poor even though processing succeeded.

## Transient storage failures

Every Storage call the worker makes (`downloadSource`, each derived-resource upload, the
manifest upload) is retried up to 4 times with exponential backoff - 500 ms, 1 s, 2 s - by
`lib/epub/storage-retry.ts`. Only failures that can plausibly differ on a second try are
retried: a transport failure with no HTTP response at all (a dropped socket, surfacing as
`fetch failed`), or HTTP 408/429/5xx. Everything else - 400, 403, 404, 409, 413 - fails the
job on the first attempt, because retrying it would only issue the same rejected write 830
more times in a single book.

This matters because a real book issues one serial PUT per derived resource (830 of them for
a 23 MiB EPUB), so without a retry a single dropped connection anywhere in the run discards
the entire job and the operator restarts from resource #0.

A `STORAGE_FAILURE` message now carries the whole cause chain, not just the outermost
message - `fetch failed <- TypeError: fetch failed <- ECONNRESET: read ECONNRESET`. Read the
last link first: it is the actual errno, and `processing_jobs.error_message` is the only
record of it you get after the run. A `STORAGE_FAILURE` that survives 4 attempts is not a
blip; check Storage reachability and the project's status before simply retrying the job.

## Recovering an expired lease

A worker that crashes (or is killed) mid-job leaves its `processing_jobs` row `processing`
with a `lease_owner`/`lease_expires_at` that nothing will ever clear. This is expected, not a
bug: once `lease_expires_at` passes, `claim_processing_job` treats the row as eligible again
for any worker, including a bare `process-next` poll - no manual intervention required. If you
need it back sooner than the lease's natural expiry, either wait, or lower `--lease` for the
next run of that specific job (`process --asset <uuid> --lease 30`, say) once the row's
current lease has actually expired - you cannot pre-empt an active lease before it expires;
that guarantee (Ruling AK) is exactly what stops two workers from processing the same job
concurrently.

## Sizing the lease

There is no lease heartbeat or renewal: a worker claims a job with a fixed lease duration
(`--lease`/`EBOOK_LEASE_SECONDS`, default 300 s) and that lease's expiry never moves, no
matter how the actual processing run is going. Derived resources upload **serially** over the
network (`lib/epub/worker.ts`), so a large EPUB with many resources can plausibly take longer
than the 300 s default - and the moment it does, any other worker's `process-next` poll (the
very loop this runbook recommends running continuously) is entitled to reclaim the same job
and start processing it again concurrently.

**This is bounded, not corrupting**, if it happens: both workers process the same source
bytes, so every derived object they write is byte-identical; each object upload is a single
atomic PUT; and the only authoritative write - `complete_processing_job` - is lease-guarded
and further protected by `ebook_publications.ebook_asset_id`'s `unique` constraint, so exactly
one publication can ever be created no matter how many workers raced to get there. The
original worker's own attempt to record its outcome afterward is rejected by the same
lease-ownership guard (Ruling AK) - `lib/epub/worker.ts`'s `processJob()` specifically
preserves that worker's original failure code and correlation id in this case rather than
losing them behind the secondary rejection, so `retry --job <uuid>`/log correlation still
work even after a reclaim race.

The cost is duplicated work and concurrent identical writes, not data loss. Mitigate it by
sizing the lease generously above your worst-case processing time (`EBOOK_LEASE_SECONDS`, so
every invocation of a poll loop shares one setting) rather than relying on the 300 s default
for anything beyond small test EPUBs. A real fix - a lease heartbeat that lets a still-running
worker extend its own lease - is out of scope for this task.

## Known gaps (accepted, not bugs)

### Local storage-limit interaction (50 MiB global vs. 100 MiB bucket)

`supabase/config.toml`'s `[storage]` section sets a **global** 50 MiB `file_size_limit` for
the whole local stack, while the `ebook-source` bucket itself is created with a 100 MiB limit
(`20260911160000_ebook_storage.sql`). Production is unaffected - the hosted Supabase project
carries its own settings, independent of this repo's local `config.toml`.

Locally, though, a EPUB between roughly 50 MiB and 100 MiB passes every check *this app*
performs - the client-side size check in the upload form, `lib/epub/upload.ts`'s
`MAX_EPUB_SIZE_BYTES` (100 MiB) validation, and `admin_reserve_ebook_asset`'s reservation
insert (which happens *before* any bytes are uploaded) - and only then fails the actual
storage `PUT`, because Storage's own global limit rejects it first. The operator-visible
symptom is: the admin upload form's reservation step succeeds, the file appears to start
uploading, and then the browser reports an upload failure with no `processing_jobs` row ever
created (since `admin_finalize_ebook_asset`, which creates the job, is never reached).

Recognize this specifically when: the file is between 50-100 MiB, you are on the **local**
stack, and the failure happens during the PUT itself rather than at any of the app's own
validation steps. It is not a code bug - it is a local config-only ceiling. Either test with a
smaller fixture locally, or bump the local `[storage].file_size_limit` if you specifically
need to exercise the 50-100 MiB range locally (never commit that change to
`supabase/config.toml`, per this task's environment constraints).

Each retry after a failure like this compounds: `admin_reserve_ebook_asset` already committed
its reservation row before the PUT failed, so it is not visible as "in progress" anywhere,
and the *next* reservation for the same edition simply computes the next version and
proceeds - it is never blocked by the failed one. Every failed retry leaves one more orphaned
`uploading` row behind and burns one more slot in the version sequence for that edition. See
the next section - there is no reaper for this today.

### Abandoned uploads accumulate (no reaper)

There is deliberately no background sweep for stale rows anywhere in this pipeline:

- An `ebook_assets` row that never gets past `uploading` (the browser abandoned the upload,
  or hit the storage-limit interaction above) sits there forever. It is inert, not dangerous:
  `admin_finalize_ebook_asset` only ever moves a row out of `uploading` by its exact primary
  key, never "the latest uploading row for this edition," so an abandoned reservation can
  never accidentally become the asset a later upload finalizes. The next reservation for the
  same edition just computes the next version and proceeds.
- A `processing_jobs` row that ends up `failed` (including `STALE_VERSION`) sits there
  forever unless an operator explicitly runs `retry --job <uuid>`. Nothing polls for and
  retries failed jobs automatically.
- **Orphaned objects in `ebook-derived`.** A job that fails partway through uploading its
  derived resources (a storage error mid-stream, or the reclaim race described in "Sizing the
  lease" above) leaves whatever it already wrote behind - there is no cleanup of partial
  output on failure. This is intentional, not a bug: derived keys are deterministic
  (`{editionId}/{assetId}/...`), so a retry overwrites the same objects rather than creating
  new orphans, and no DB row ever references a partial set (`ebook_resources` rows are only
  ever inserted, all at once, inside the same `complete_processing_job` call that also flips
  `processing_jobs` to `completed`). A job whose asset is *never* retried - e.g. a
  `STALE_VERSION` failure, which should never be retried - leaves its partial `ebook-derived`
  objects behind permanently.

Both `ebook_assets`/`processing_jobs` rows and `ebook-derived` objects are accepted,
non-blocking gaps for this task. If they start to matter operationally (disk usage from
orphaned `ebook-source`/`ebook-derived` objects, or a backlog of `uploading`/`failed` rows
worth auditing), that is a reaper task for later, not something to build speculatively here.
