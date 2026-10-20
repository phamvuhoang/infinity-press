# One-Book Ebook Golden Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove one real ebook can be created, processed, previewed, published, granted to a verified reader, opened securely, and resumed without a payment provider or hosted worker.

**Architecture:** An authorized Next.js admin uploads a versioned source EPUB to private Supabase Storage and creates a database job. A deterministic local TypeScript CLI claims and processes the job; the admin previews and publishes the resulting version. Email-authenticated readers obtain free, complimentary, or simulated entitlements and read authorized derived resources through a short-lived session.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Supabase Postgres/Auth/Storage/RLS, Readium Web TypeScript toolkit, Node.js CLI, fflate, fast-xml-parser, sanitize-html, Zod, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-09-11-mvp-foundation-and-spikes-design.md`

**Prerequisite plan:** `docs/superpowers/plans/2026-09-11-mvp-platform-baseline.md`

## Global Constraints

- Complete the platform-baseline gate before starting this plan.
- Use at least five private Infinity Books EPUB files; never commit copyrighted EPUBs or extracted paid content.
- EPUB is the only full-book MVP format; do not add PDF support.
- Readium Web is preferred but remains behind a `ReaderEngine` interface until the spike passes.
- Source and derived paid resources stay private and versioned.
- Never rely on a client-side sample boundary or entitlement check.
- The local CLI uses a server-only credential and must be reusable behind a future hosted executor.
- Free acquisition has `payment_status = not_required`; complimentary access does not create a payment or order.
- The simulator is local/staging-only and uses the same idempotent event-to-entitlement service intended for a future provider.
- Every admin mutation authenticates, authorizes, validates input, and records audit where required.
- Preserve the user's untracked `docs/ref/` files and private EPUB corpus.

---

### Task 1: Define private fixture metadata and reader/processor contracts

**Files:**
- Modify: `.gitignore`
- Create: `fixtures/epub/README.md`
- Create: `fixtures/epub/manifest.example.json`
- Create: `lib/reader/types.ts`
- Create: `lib/reader/engine.ts`
- Create: `lib/reader/engine.test.ts`
- Create: `lib/epub/types.ts`
- Create: `lib/epub/errors.ts`
- Create: `lib/epub/errors.test.ts`

**Interfaces:**
- Consumes: Five local `.epub` files supplied by the owner.
- Produces: `ReaderEngine`, `ReaderLocator`, `ProcessedPublication`, `ProcessingFailure`, and the fixture acceptance matrix.

- [ ] **Step 1: Ignore private EPUB files while keeping fixture documentation**

Append to `.gitignore`:

```gitignore
fixtures/epub/private/
fixtures/epub/manifest.local.json
```

Create `manifest.example.json`:

```json
{
  "fixtures": [
    {
      "id": "book-01",
      "path": "private/book-01.epub",
      "language": "vi",
      "features": ["embedded-fonts", "images", "long-chapters"]
    }
  ]
}
```

Document that the local manifest must contain at least five fixtures and collectively exercise embedded fonts, images, long chapters, internal links, lists/tables, and varied CSS.

- [ ] **Step 2: Write contract and error tests**

Create tests that construct a locator and classify stable errors:

```ts
import { describe, expect, it } from "vitest";
import { processingFailure } from "@/lib/epub/errors";

describe("processingFailure", () => {
  it("marks invalid EPUB input as non-retryable", () => {
    expect(processingFailure("INVALID_EPUB", "Missing container.xml")).toEqual({
      code: "INVALID_EPUB",
      message: "Missing container.xml",
      retryable: false,
    });
  });
});
```

- [ ] **Step 3: Run focused tests and verify they fail**

Run: `npm test -- lib/reader/engine.test.ts lib/epub/errors.test.ts`

Expected: FAIL because the contract modules do not exist.

- [ ] **Step 4: Implement exact shared contracts**

Create `lib/reader/types.ts`:

```ts
export type ReaderLocator = {
  href: string;
  progression: number;
  totalProgression: number | null;
  locations: Record<string, string | number>;
  text?: { before?: string; highlight?: string; after?: string };
};

export type ReaderPreferences = {
  fontFamily: "publisher" | "serif" | "sans";
  fontScale: number;
  lineHeight: number;
  theme: "light" | "sepia" | "dark";
};
```

Create `lib/reader/engine.ts`:

```ts
import type { ReaderLocator, ReaderPreferences } from "@/lib/reader/types";

export interface ReaderEngine {
  mount(input: { container: HTMLElement; manifestUrl: string; initialLocator: ReaderLocator | null }): Promise<void>;
  goTo(locator: ReaderLocator): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setPreferences(preferences: ReaderPreferences): Promise<void>;
  getLocator(): Promise<ReaderLocator>;
  destroy(): Promise<void>;
}
```

Define `ProcessedPublication` with metadata, reading order, resources, TOC, sample hrefs, and SHA-256 hashes. Define failure codes `INVALID_EPUB`, `UNSAFE_SCRIPT`, `UNSAFE_EXTERNAL_URL`, `UNSUPPORTED_MEDIA`, `ASSET_TOO_LARGE`, `STORAGE_FAILURE`, `STALE_VERSION`, and `PROCESSING_FAILURE`.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- lib/reader/engine.test.ts lib/epub/errors.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit fixture policy and contracts**

```bash
git add .gitignore fixtures/epub lib/reader lib/epub
git commit -m "feat: define ebook processing and reader contracts"
```

### Task 2: Build the one-book admin catalog workflow

**Files:**
- Create: `lib/catalog/schemas.ts`
- Create: `lib/catalog/schemas.test.ts`
- Create: `lib/data/books.ts`
- Create: `app/admin/books/actions.ts`
- Modify: `app/admin/books/new/page.tsx`
- Create: `app/admin/books/[bookId]/page.tsx`
- Create: `components/admin/book-form.tsx`
- Create: `components/ui/textarea.tsx`
- Create: `components/ui/select.tsx`
- Create: `supabase/migrations/20260911120000_admin_create_ebook.sql`
- Create: `supabase/tests/004_admin_create_ebook.sql`

**Interfaces:**
- Consumes: Generated database types, `requireAdmin()`, and catalog tables.
- Produces: `createBook(input): Promise<{ bookId: string }>` and `getAdminBook(bookId): Promise<AdminBookDTO>`.

- [ ] **Step 1: Write schema tests for one-book creation**

Create `lib/catalog/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createBookSchema } from "@/lib/catalog/schemas";

describe("createBookSchema", () => {
  it("keeps language, locale, market, and currency independent", () => {
    const result = createBookSchema.parse({
      canonicalKey: "the-golden-book",
      authorName: "Phuong Bui",
      locale: "vi",
      language: "en",
      title: "The Golden Book",
      slug: "cuon-sach-vang",
      market: "VN",
      currency: "VND",
      priceMinor: 0,
    });
    expect(result.language).toBe("en");
    expect(result.locale).toBe("vi");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- lib/catalog/schemas.test.ts`

Expected: FAIL because the schema module does not exist.

- [ ] **Step 3: Implement validated catalog input**

Create a Zod object with the exact fields used by the test. Enforce lowercase kebab-case canonical keys/slugs, two-letter uppercase market, three-letter uppercase currency, and `priceMinor >= 0`.

- [ ] **Step 4: Implement the repository transaction**

`createBook()` uses the trusted server client to insert author, book, localization, edition, ebook SKU, and offer as one database transaction through an RPC named `admin_create_ebook` in `20260911120000_admin_create_ebook.sql`. The RPC accepts the validated scalar fields, checks `public.is_admin()`, inserts the graph in dependency order, and returns the book UUID. The pgTAP test calls it twice with the same localized slug and proves the second call leaves all six table counts unchanged.

- [ ] **Step 5: Implement the Server Action and form**

The Server Action must call `requireAdmin()`, parse `FormData`, call `createBook`, revalidate `/admin/books`, and redirect to `/admin/books/{bookId}`. Return only validation errors through `useActionState`; never return raw Supabase errors.

- [ ] **Step 6: Run focused and static checks**

Run:

```bash
npm test -- lib/catalog/schemas.test.ts
supabase db reset
supabase test db
npm run lint
npm run typecheck
npm run build
```

Expected: all commands pass and duplicate input leaves no partial book graph.

- [ ] **Step 7: Commit the catalog workflow**

```bash
git add app/admin/books components/admin components/ui lib/catalog lib/data/books.ts supabase/migrations supabase/tests
git commit -m "feat: add one-book admin catalog workflow"
```

### Task 3: Add private EPUB upload and durable database job creation

**Files:**
- Create: `supabase/migrations/20260911110000_ebook_storage.sql`
- Create: `supabase/tests/003_ebook_storage.sql`
- Create: `lib/epub/upload.ts`
- Create: `lib/epub/upload.test.ts`
- Create: `app/admin/books/[bookId]/epub/actions.ts`
- Create: `components/admin/epub-upload-form.tsx`
- Modify: `app/admin/books/[bookId]/page.tsx`

**Interfaces:**
- Consumes: Admin authorization, private Storage, edition IDs, and publishing tables.
- Produces: `createEpubUpload(input): Promise<{ assetId; signedUpload }>` and `finalizeEpubUpload(assetId, checksum): Promise<{ jobId }>`.

- [ ] **Step 1: Write upload-policy and validation tests**

Test rejection of non-EPUB extension, MIME other than `application/epub+zip`, zero bytes, and size above 100 MiB. Test accepted output uses `ebook-source/{editionId}/{assetId}/source.epub`.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- lib/epub/upload.test.ts`

Expected: FAIL because the upload module does not exist.

- [ ] **Step 3: Add private buckets and policies**

The migration inserts private buckets `ebook-source` and `ebook-derived`. Browser policies grant no direct source/derived reads. Upload targets are created by the trusted server only. Add pgTAP assertions that both buckets have `public = false`.

- [ ] **Step 4: Implement upload reservation**

`createEpubUpload()` must:

1. Call `requireAdmin()`.
2. Validate edition, filename, MIME, and size.
3. Create the immutable asset version in `uploading` state through `admin_reserve_ebook_asset`.
4. Request a signed upload token for the exact source object key.
5. Return the asset ID and signed-upload data, never the service-role key.

- [ ] **Step 5: Implement client upload UI**

The Client Component requests the reservation from its Server Action, uploads directly to the signed target, and calls `finalizeEpubUpload`. The corresponding `admin_finalize_ebook_asset` RPC verifies `uploading` state, records the checksum, changes the asset to `queued`, and creates one queued job transactionally. Display progress, file validation, and retry-safe errors.

- [ ] **Step 6: Run unit, database, and static checks**

Run:

```bash
npm test -- lib/epub/upload.test.ts
supabase db reset
supabase test db
npm run lint
npm run typecheck
npm run build
```

Expected: all commands pass; both buckets remain private.

- [ ] **Step 7: Commit private upload support**

```bash
git add supabase/migrations/20260911110000_ebook_storage.sql supabase/tests/003_ebook_storage.sql app/admin/books components/admin lib/epub
git commit -m "feat: add private EPUB upload workflow"
```

### Task 4: Implement deterministic EPUB validation and processing primitives

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/fixtures/create-test-epub.ts`
- Create: `lib/epub/archive.ts`
- Create: `lib/epub/archive.test.ts`
- Create: `lib/epub/parse.ts`
- Create: `lib/epub/parse.test.ts`
- Create: `lib/epub/sanitize.ts`
- Create: `lib/epub/sanitize.test.ts`
- Create: `lib/epub/process.ts`
- Create: `lib/epub/process.test.ts`

**Interfaces:**
- Consumes: EPUB bytes and the contracts from Task 1.
- Produces: `processEpub(bytes, policy): Promise<ProcessedPublication>` with no database or storage dependency.

- [ ] **Step 1: Install deterministic processing dependencies**

Run:

```bash
npm install fflate fast-xml-parser sanitize-html
npm install -D @types/sanitize-html tsx
```

- [ ] **Step 2: Generate safe and malicious test EPUB fixtures**

Implement `scripts/fixtures/create-test-epub.ts` using `fflate.zipSync()` so tests can generate:

- A valid EPUB with `mimetype` first and uncompressed.
- A missing `META-INF/container.xml` case.
- XHTML containing `<script>`, inline `onclick`, and an external `https://` image.
- An archive entry with `../` path traversal.

Tests must generate fixtures at runtime under the test temporary directory; do not commit binary EPUBs.

- [ ] **Step 3: Write failing archive, parsing, and sanitization tests**

Required assertions:

```ts
await expect(processEpub(traversalBytes, policy)).rejects.toMatchObject({ code: "INVALID_EPUB" });
const sanitized = await processEpub(scriptBytes, policy);
expect(sanitized.resources.some((resource) => resource.text?.includes("<script"))).toBe(false);
await expect(processEpub(externalUrlBytes, policy)).rejects.toMatchObject({ code: "UNSAFE_EXTERNAL_URL" });
```

- [ ] **Step 4: Run tests and verify the red state**

Run: `npm test -- lib/epub/archive.test.ts lib/epub/parse.test.ts lib/epub/sanitize.test.ts lib/epub/process.test.ts`

Expected: FAIL because the processing modules do not exist.

- [ ] **Step 5: Implement archive safety**

Reject absolute paths, `..` segments, duplicate normalized paths, more than 2,000 entries, total uncompressed size above 100 MiB, and compression ratios above 100:1. Require `mimetype`, container XML, one root package document, and a readable spine.

- [ ] **Step 6: Implement parsing and sanitization**

Use `fast-xml-parser` with entities disabled. Allow XHTML structural/typographic elements and safe attributes. Remove scripts, event handlers, forms, embeds, and executable URLs. Reject remote HTTP(S), protocol-relative, `javascript:`, and non-allowlisted data URLs. Permit only relative in-publication references and explicitly allowlisted media types.

- [ ] **Step 7: Implement deterministic publication output**

Sort resource records by normalized href, hash each output with SHA-256, and return metadata, reading order, resources, TOC, and sample candidates. Given the same input bytes and policy, the JSON result and resource hashes must be identical.

- [ ] **Step 8: Run focused and static checks**

Run:

```bash
npm test -- lib/epub
npm run lint
npm run typecheck
```

Expected: all processing tests pass.

- [ ] **Step 9: Commit the processor core**

```bash
git add package.json package-lock.json scripts/fixtures lib/epub
git commit -m "feat: add deterministic EPUB processor core"
```

### Task 5: Build the local job-processing CLI

**Files:**
- Modify: `package.json`
- Create: `scripts/ebook.ts`
- Create: `lib/epub/job-store.ts`
- Create: `lib/epub/job-store.test.ts`
- Create: `lib/epub/worker.ts`
- Create: `lib/epub/worker.test.ts`
- Create: `docs/runbooks/epub-processing.md`
- Create: `supabase/migrations/20260911130000_processing_job_rpcs.sql`
- Create: `supabase/tests/005_processing_jobs.sql`

**Interfaces:**
- Consumes: `processEpub()`, privileged Supabase client, storage buckets, and queued jobs.
- Produces: `claimNextJob(workerId)`, `processJob(jobId, workerId)`, and `npm run ebook -- <command>`.

- [ ] **Step 1: Write worker state-transition tests**

Use an in-memory fake `JobStore` and assert:

- Two workers cannot claim the same active lease.
- An expired lease can be reclaimed.
- A stale asset version becomes `STALE_VERSION` without touching active output.
- Retrying the same job writes the same versioned keys.
- Storage failure records `STORAGE_FAILURE` and leaves the active publication unchanged.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- lib/epub/job-store.test.ts lib/epub/worker.test.ts`

Expected: FAIL because the job modules do not exist.

- [ ] **Step 3: Implement the job-store interface**

```ts
export interface JobStore {
  claimNext(workerId: string, leaseSeconds: number): Promise<ProcessingJob | null>;
  downloadSource(job: ProcessingJob): Promise<Uint8Array>;
  putDerived(job: ProcessingJob, resource: ProcessedResource): Promise<void>;
  complete(job: ProcessingJob, publication: ProcessedPublication): Promise<void>;
  fail(job: ProcessingJob, failure: ProcessingFailure): Promise<void>;
}
```

The Supabase implementation calls `claim_processing_job`, `complete_processing_job`, and `fail_processing_job` from `20260911130000_processing_job_rpcs.sql`. Each function locks the job row with `for update skip locked`, verifies the lease owner on completion/failure, and uses Storage APIs only with exact object keys derived from the immutable asset/version.

- [ ] **Step 4: Implement CLI commands**

Add:

```json
{ "ebook": "tsx scripts/ebook.ts" }
```

Support `validate <file>`, `process --asset <uuid>`, `process-next`, and `retry --job <uuid>`. Exit 0 only on successful completion; print stable error code and correlation ID to stderr without printing EPUB text or credentials.

- [ ] **Step 5: Write the operator runbook**

Document environment setup, safe service-role handling, all commands, expected job states, retryable/non-retryable failures, and how to recover an expired lease.

- [ ] **Step 6: Run worker and static tests**

Run:

```bash
npm test -- lib/epub/job-store.test.ts lib/epub/worker.test.ts
npm run lint
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 7: Commit the local worker**

```bash
git add package.json package-lock.json scripts/ebook.ts lib/epub docs/runbooks/epub-processing.md
git commit -m "feat: add local EPUB processing worker"
```

### Task 6: Add admin preview, publish, failure, and rollback operations

**Files:**
- Create: `lib/publishing/state.ts`
- Create: `lib/publishing/state.test.ts`
- Create: `lib/data/publications.ts`
- Create: `app/admin/publications/[publicationId]/page.tsx`
- Create: `app/admin/publications/[publicationId]/actions.ts`
- Create: `components/admin/publication-status.tsx`
- Create: `components/admin/publication-preview.tsx`
- Create: `app/api/admin/publications/[publicationId]/resources/[...href]/route.ts`
- Create: `supabase/migrations/20260911140000_publication_transition_rpcs.sql`
- Create: `supabase/tests/006_publication_transitions.sql`

**Interfaces:**
- Consumes: Ready publication records and private derived resources.
- Produces: authorized preview, `publishPublication(id)`, `rejectPublication(id, reason)`, and `rollbackPublication(bookId, publicationId)`.

- [ ] **Step 1: Write publication transition tests**

Assert that only `ready_for_preview -> published` is accepted, failed/processing publications cannot publish, publishing supersedes the previous active version, and rollback accepts only a previously published version for the same book.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- lib/publishing/state.test.ts`

Expected: FAIL because the state module does not exist.

- [ ] **Step 3: Implement pure state decisions and transactional RPCs**

Implement `decidePublicationTransition(current, command)` as a pure exhaustive switch. In `20260911140000_publication_transition_rpcs.sql`, add `publish_publication`, `reject_publication`, and `rollback_publication`; each checks `public.is_admin()`, locks the book/publication rows, verifies the version belongs to the book, updates the active pointer, marks the old version superseded, and appends an audit record in one transaction.

- [ ] **Step 4: Implement protected preview resources**

The admin preview Route Handler calls `requireAdmin()`, confirms the requested resource belongs to the candidate publication, then streams the private object with its stored media type and a restrictive CSP. It never accepts a caller-supplied storage key.

- [ ] **Step 5: Build status, error, preview, publish, and rollback UI**

Show queued/processing/ready/failed state, stable error code, safe message, attempt count, correlation ID, and `Waiting for local processor` when queued. Every mutation requires an explicit confirmation and refreshes affected admin/public routes.

- [ ] **Step 6: Verify transitions and build**

Run:

```bash
npm test -- lib/publishing/state.test.ts
supabase db reset
supabase test db
npm run lint
npm run typecheck
npm run build
```

Expected: all commands pass.

- [ ] **Step 7: Commit publication operations**

```bash
git add app/admin/publications app/api/admin components/admin lib/publishing lib/data/publications.ts supabase/migrations supabase/tests
git commit -m "feat: add publication preview and release controls"
```

### Task 7: Implement free, complimentary, and simulated entitlement services

**Files:**
- Create: `lib/commerce/types.ts`
- Create: `lib/commerce/payment-provider.ts`
- Create: `lib/commerce/simulator.ts`
- Create: `lib/commerce/simulator.test.ts`
- Create: `lib/access/grant.ts`
- Create: `lib/access/grant.test.ts`
- Create: `app/[locale]/(public)/books/[slug]/actions.ts`
- Create: `app/admin/users/[profileId]/entitlements/actions.ts`
- Create: `app/admin/test-payments/actions.ts`
- Create: `supabase/migrations/20260911150000_entitlement_rpcs.sql`
- Create: `supabase/tests/007_entitlements.sql`

**Interfaces:**
- Consumes: Verified profile, active offer, book/SKU, admin role, and server environment.
- Produces: `acquireFreeOffer()`, `grantComplimentaryEntitlement()`, `applyVerifiedPaymentEvent()`, and `PaymentProvider`.

- [ ] **Step 1: Write idempotency and source-separation tests**

Test that:

- Two free-acquisition requests return the same entitlement.
- Complimentary access creates an audit event and no payment row.
- A duplicated simulated success event creates one payment transition and one entitlement.
- Failure/cancellation events never grant access.
- Constructing `SimulatorProvider` in production throws the exact configuration error.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- lib/access/grant.test.ts lib/commerce/simulator.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Define provider-neutral event contracts**

```ts
export type VerifiedPaymentEvent = {
  provider: string;
  eventId: string;
  externalPaymentId: string;
  orderId: string;
  status: "succeeded" | "failed" | "cancelled";
  amountMinor: number;
  currency: string;
  occurredAt: string;
};

export interface PaymentProvider {
  verifyEvent(request: Request): Promise<VerifiedPaymentEvent>;
}
```

- [ ] **Step 4: Implement transactional access RPCs**

In `20260911150000_entitlement_rpcs.sql`, add `acquire_free_ebook`, `grant_complimentary_entitlement`, and `apply_payment_event`. Each locks the relevant identity/order/offer rows, verifies current state and amount, uses uniqueness constraints for replay safety, grants one active entitlement, creates one library item, and records audit when an admin is the actor. `grant_complimentary_entitlement` inserts no order/payment; `acquire_free_ebook` requires `price_minor = 0`; `apply_payment_event` first inserts the unique provider event and returns the existing outcome on conflict.

- [ ] **Step 5: Implement authorized Server Actions**

- Free acquisition requires an authenticated verified email and an active zero-price offer.
- Complimentary grant requires admin role, target profile, book, and a non-empty reason.
- Simulator actions require admin role and `APP_ENV` local or staging.

- [ ] **Step 6: Run unit, database, and static checks**

Run:

```bash
npm test -- lib/access/grant.test.ts lib/commerce/simulator.test.ts
supabase db reset
supabase test db
npm run lint
npm run typecheck
npm run build
```

Expected: all tests pass and simulator construction fails under a production fixture.

- [ ] **Step 7: Commit access acquisition flows**

```bash
git add app/[locale]/\(public\)/books app/admin/users app/admin/test-payments lib/access lib/commerce supabase/migrations supabase/tests
git commit -m "feat: add ebook entitlement acquisition flows"
```

### Task 8: Build the library and short-lived protected reader sessions

**Files:**
- Create: `lib/data/library.ts`
- Create: `lib/reader/session.ts`
- Create: `lib/reader/session.test.ts`
- Modify: `app/[locale]/(account)/library/page.tsx`
- Modify: `app/[locale]/(reader)/read/[bookId]/page.tsx`
- Create: `app/api/reader/sessions/route.ts`
- Create: `app/api/reader/publications/[publicationId]/manifest/route.ts`
- Create: `app/api/reader/publications/[publicationId]/resources/[...href]/route.ts`
- Create: `app/api/samples/[publicationId]/manifest/route.ts`
- Create: `app/api/samples/[publicationId]/resources/[...href]/route.ts`

**Interfaces:**
- Consumes: Active entitlement, active publication, private resources, and reader-session TTL.
- Produces: `createReaderSession(profileId, publicationId)` and authenticated/sample manifest/resource endpoints.

- [ ] **Step 1: Write reader-session policy tests**

Test that an active entitlement creates a session, revoked/no entitlement is denied, expiry is capped by configuration, the session is scoped to one profile/publication/version, and sample lookup rejects every href outside the explicit allowlist.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- lib/reader/session.test.ts`

Expected: FAIL because the session service does not exist.

- [ ] **Step 3: Implement session creation and lookup**

Create an opaque UUID session stored with `profile_id`, `publication_id`, `publication_version`, `expires_at`, and `revoked_at`. The browser receives the session ID but never a storage key. Every manifest/resource request rechecks authenticated ownership, expiry, revocation, entitlement, publication version, and normalized href.

- [ ] **Step 4: Build manifests with application resource URLs**

Return Readium Web Publication Manifest JSON whose reading-order/resource links point to the authenticated Route Handlers, not Supabase object URLs. Use `Cache-Control: private, no-store` for entitled manifests/resources. Sample handlers return only allowlisted resources and never infer sample membership from a client parameter.

- [ ] **Step 5: Build the library page**

Return a DTO containing book ID, localized title/slug, cover, library state, progress percentage, and Continue reading URL. Do not pass entitlement source details or storage keys to the Client Component.

- [ ] **Step 6: Run session, database, and build verification**

Run:

```bash
npm test -- lib/reader/session.test.ts
supabase db reset
supabase test db
npm run lint
npm run typecheck
npm run build
```

Expected: all commands pass and unauthorized resource fixture requests return 401/403/404 without leaking object existence.

- [ ] **Step 7: Commit protected reader delivery**

```bash
git add app/[locale] app/api/reader app/api/samples lib/data/library.ts lib/reader supabase/migrations supabase/tests
git commit -m "feat: add library and protected reader sessions"
```

### Task 9: Run the Readium Web spike behind the engine boundary

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `components/reader/reader-client.tsx`
- Create: `lib/reader/readium-engine.ts`
- Create: `lib/reader/readium-engine.test.ts`
- Modify: `app/[locale]/(reader)/read/[bookId]/page.tsx`
- Create: `docs/spikes/readium-web-results.md`
- Create: `docs/adr/ADR-005-reader-engine.md`

**Interfaces:**
- Consumes: `ReaderEngine`, protected manifest URL, initial locator, and five private EPUB fixtures.
- Produces: a selected reader engine and evidence-backed ADR-005.

- [ ] **Step 1: Recheck official Readium package versions**

Run:

```bash
npm view @readium/shared version
npm view @readium/navigator version
npm view @readium/navigator-html-injectables version
```

Expected on 2026-09-11: `2.5.0`, `2.10.0`, and `2.8.0`. If newer stable versions exist, record them in the spike results and use one mutually compatible released set.

- [ ] **Step 2: Install the released Readium packages**

Run:

```bash
npm install @readium/shared@2.5.0 @readium/navigator@2.10.0 @readium/navigator-html-injectables@2.8.0
```

If Step 1 found a newer compatible released set, substitute those three recorded versions together rather than mixing unverified versions.

- [ ] **Step 3: Write adapter lifecycle tests**

Mock the Readium navigator boundary and assert that `mount` loads the protected manifest and initial locator, `setPreferences` forwards typography/theme values, `getLocator` returns the shared locator shape, and `destroy` removes listeners/navigator resources.

- [ ] **Step 4: Implement the Readium adapter and Client Component**

Keep all Readium imports inside `lib/reader/readium-engine.ts` and the client-only component path. The Server Component creates the authorized reader session and passes only manifest URL and initial locator. Dynamically load the reader Client Component so public/catalog bundles do not include Readium.

- [ ] **Step 5: Run the five-EPUB manual matrix**

For every private fixture, record desktop Chrome, mobile Chrome, Safari/WebKit, and Firefox results for render fidelity, embedded fonts, images, long chapters, links, TOC, next/previous, typography changes, reload restore, sample boundary, console errors, initialization time, and bundle impact.

- [ ] **Step 6: Apply the explicit decision gate**

Accept Readium only if all five supported EPUBs render, stable locator restore works after typography changes, protected/sample boundaries hold, and no critical browser failure remains.

If any criterion fails:

1. Record the exact failure and minimal reproduction in `docs/spikes/readium-web-results.md`.
2. Do not modify `ReaderEngine` to expose Readium-specific types.
3. Install `epubjs` plus its current TypeScript types.
4. Implement `lib/reader/epubjs-engine.ts` against the same interface.
5. Repeat the same matrix.
6. Select the engine that passes; if neither passes, stop this plan and mark issue #1 blocked with evidence.

- [ ] **Step 7: Write ADR-005**

Record context, tested versions, fixture matrix summary, selected engine, rejected alternative, bundle/loading strategy, locator mapping, known supported-profile exclusions, and conditions that would reopen the decision.

- [ ] **Step 8: Run automated and static checks**

Run:

```bash
npm test -- lib/reader/readium-engine.test.ts
npm run lint
npm run typecheck
npm run build
```

Expected: all commands pass for the selected adapter.

- [ ] **Step 9: Commit the selected reader integration**

```bash
git add package.json package-lock.json app/[locale]/\(reader\) components/reader lib/reader docs/spikes docs/adr/ADR-005-reader-engine.md
git commit -m "feat: integrate the validated ebook reader engine"
```

### Task 10: Persist progress and prove the complete golden path

**Files:**
- Create: `lib/reader/progress.ts`
- Create: `lib/reader/progress.test.ts`
- Create: `app/api/reader/progress/route.ts`
- Modify: `components/reader/reader-client.tsx`
- Create: `e2e/ebook-golden-path.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Create: `docs/runbooks/golden-path-validation.md`

**Interfaces:**
- Consumes: Selected reader engine, stable locator, authenticated profile, publication, and protected session.
- Produces: `saveProgress(input)` with monotonic reconciliation and a complete executable golden-path check.

- [ ] **Step 1: Write progress reconciliation tests**

Test exact locator round-trip, later update wins for the same device, stale timestamps do not overwrite newer progress, and a lower progression can still win when it has a later trusted server timestamp because a reader may intentionally move backward.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- lib/reader/progress.test.ts`

Expected: FAIL because the progress module does not exist.

- [ ] **Step 3: Implement validated progress persistence**

Accept `publicationId`, locator, and client sequence. Derive profile from the session, reject a publication outside the active entitlement, stamp server time, and upsert only when the new client sequence is greater for the same device or the stored device differs and the server timestamp is later. Return a minimal locator DTO.

Carry-forward from the platform-baseline Task 6 review: browser roles have no INSERT on `reading_progress` and only a column-level UPDATE on existing rows, so the upsert cannot run through the user-session client. Perform it in a `security definer` RPC that derives the profile from `auth.uid()`, or through the service-role client after the server has resolved the profile.

- [ ] **Step 4: Integrate debounced and lifecycle-safe saving**

The reader client saves after navigation settles, on a bounded debounce, and on explicit exit/back-to-library. Flush with a normal awaited request when possible; do not assume an unload beacon succeeded. A save failure keeps the last unsaved locator in memory and shows a non-blocking retry state.

- [ ] **Step 5: Create golden-path fixtures and E2E flow**

The test setup creates an admin and reader through supported Supabase test setup, inserts one processed publication fixture containing only public-domain/generated text, and exercises:

```text
admin sign-in -> create book -> publication ready -> preview -> publish
-> reader magic-link test session -> complimentary grant
-> library -> reader -> navigate -> save -> reload -> same locator
```

Do not use the private five-book corpus in CI.

- [ ] **Step 6: Add Playwright browser projects and CI**

Keep Chromium for every PR. Add Firefox and WebKit for main-branch/nightly golden-path runs. Add the Playwright job only after deterministic Supabase fixtures and the production build start reliably in CI.

- [ ] **Step 7: Document operator validation**

The runbook lists how to prepare the five private EPUBs, upload, run the CLI, inspect failures, preview/publish, grant access, validate sample denial, restore progress, and capture evidence for issue #1/#2 exit criteria.

- [ ] **Step 8: Run complete verification**

Run:

```bash
npm run lint
npm run typecheck
npm run test:unit
supabase db reset
supabase test db
npm run build
npm run test:e2e -- e2e/public-home.spec.ts e2e/ebook-golden-path.spec.ts
```

Expected: every command passes; the golden-path test restores the saved locator and unauthorized sample/paid resource probes are denied.

- [ ] **Step 9: Commit progress and golden-path verification**

```bash
git add app/api/reader components/reader lib/reader e2e playwright.config.ts .github/workflows/ci.yml README.md docs/runbooks/golden-path-validation.md
git commit -m "feat: complete the one-book ebook golden path"
```

## Golden Path Completion Gate

- [ ] Five private Infinity Books EPUBs have recorded results across the required browser/device matrix.
- [ ] ADR-005 selects Readium or epub.js with versioned evidence.
- [ ] Source EPUB and non-sample paid resources cannot be fetched anonymously.
- [ ] Sample resources are enforced by an explicit server-side allowlist.
- [ ] Free, complimentary, and simulated acquisition each create exactly one valid entitlement.
- [ ] Production cannot construct or invoke the simulator.
- [ ] An authorized admin can create, upload, inspect, preview, publish, rollback, and grant/revoke access.
- [ ] A verified reader can open the library, read, and restore an exact locator.
- [ ] `npm run check`, database/RLS tests, build, and golden-path E2E all pass.
- [ ] No physical-commerce, real-provider, PDF, or GCP scope was introduced.

## Plan Suite Coverage Map

| Approved design requirement | Implemented by |
| --- | --- |
| CI, environments, fail-closed simulator | Platform Tasks 1-2 |
| Locale-prefixed routes and independent market/currency | Platform Task 3 |
| Email magic-link customer flow | Platform Task 4 |
| Normalized MVP catalog, publishing, access, and admin schema | Platform Tasks 5-6 |
| RLS, secure DAL, DTOs, roles, and audit foundation | Platform Tasks 6-8 |
| Private EPUB corpus policy and reader boundary | Golden Path Task 1 |
| Minimum one-book admin create/edit flow | Golden Path Task 2 |
| Private upload and local deterministic processing | Golden Path Tasks 3-5 |
| Preview, publish, failure diagnosis, and rollback | Golden Path Task 6 |
| Free, complimentary, and simulated entitlement paths | Golden Path Task 7 |
| Library, reader sessions, paid/sample resource protection | Golden Path Task 8 |
| Readium feasibility matrix and ADR-005 fallback decision | Golden Path Task 9 |
| Progress restore and end-to-end proof | Golden Path Task 10 |

No approved design requirement is intentionally omitted. Full catalog/admin generalization remains in the catalog-admin epic after this one-book slice; real payments, physical commerce, GCP execution, PDF, and P1/P2 capabilities remain explicitly deferred.
