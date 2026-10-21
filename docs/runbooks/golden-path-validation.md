# Runbook: validating the ebook golden path

This is the manual counterpart to `e2e/ebook-golden-path.spec.ts`. The automated spec proves the
whole path works against **one generated fixture** in Chromium. This runbook is how an operator
proves it against the **five private Infinity Books EPUBs** across the real browser matrix, which
is what issue #1 and issue #2 actually require and what no automated run in this repository can
supply.

Nothing here uses the automated fixture, and nothing in CI uses the private corpus. That
separation is deliberate: the corpus is copyrighted material that must never reach the repository
or a CI log.

## Why this cannot be automated here

`fixtures/epub/private/` is empty in every checkout and git-ignored (`*.epub` is ignored
repository-wide). ADR-005 is **provisional** precisely because the corpus matrix has never been
run: the reader engine has never displayed a real publication in any browser. Until the table at
the end of this runbook is filled in, that ADR is re-confirmed rather than re-decided.

## Prerequisites

1. A local Supabase stack and a `.env.local` pointing at it (see `README.md`).
2. The five EPUBs in `fixtures/epub/private/`, with `fixtures/epub/manifest.local.json` describing
   them — see `fixtures/epub/README.md` for the required feature coverage.
3. An admin account. If you do not have one, create a password user and grant it the admin role;
   the `/internal/{locale}/sign-in` page is the internal password fallback.

## Step 0 — record SVG presence before you start

**Do this first, per fixture.** The processor rejects an EPUB **whole** if it declares any
`image/svg+xml` manifest item; SVG cover wrappers are common in real books. A book that fails this
way has failed for a *processor* reason, not an engine reason, and misattributing it would corrupt
the ADR-005 evidence.

```bash
unzip -p fixtures/epub/private/book-01.epub '*.opf' | grep -c 'image/svg+xml' || true
```

A non-zero count means this book cannot be processed under the default profile. Record it in the
"Has SVG?" column and treat any resulting failure as expected, not as an engine defect. The same
applies to inline `<style>` blocks, which are stripped — a book relying on them renders unstyled.

## Step 1 — validate each EPUB before uploading

`validate` runs the pure processor locally and touches no database or storage, so it catches
content problems without spending an upload and processing cycle.

```bash
npm run ebook -- validate fixtures/epub/private/book-01.epub
```

Success prints a JSON summary (title, resource count, reading-order length). Failure prints a
stable code from `lib/epub/errors.ts` — `INVALID_EPUB`, `UNSAFE_SCRIPT`, `UNSAFE_EXTERNAL_URL`,
`UNSUPPORTED_MEDIA`, `ASSET_TOO_LARGE`. `UNSUPPORTED_MEDIA` on a book you flagged in Step 0 is the
SVG rejection.

## Step 2 — create the book and upload

1. Sign in at `/internal/en/sign-in`.
2. `/admin/books/new` — fill canonical key, title, slug, market, currency, and price. Choose the
   existing author by its name-and-canonical-slug option, or leave **Create a new author** selected
   and fill **Author name**. Duplicate display names are valid; the existing-author selector uses
   the stable author ID to distinguish them. A newly created author needs localized copy before
   the book can publish.
3. On the book page, choose the EPUB and select **Upload EPUB**. The browser uploads directly to
   private storage through a signed URL; the server never handles the bytes.
4. The status line reports `Queued for processing. Job <id>.` and links to **View status**.

If the upload fails between roughly 50 MiB and 100 MiB, that is the known local-only storage limit
interaction documented in `docs/runbooks/epub-processing.md` — the local stack's global 50 MiB
ceiling, not the bucket's 100 MiB one.

## Step 3 — process the job

```bash
npm run ebook -- process --asset <asset-uuid>          # the id in the /admin/publications/<id> URL
EBOOK_LEASE_SECONDS=1800 npm run ebook -- process-next # for a large book, size the lease first
```

Success prints one line of JSON. Failure prints the job's `correlationId` and a stable code to
stderr and exits non-zero — never EPUB content, never the service-role key.

### Diagnosing a failure

- Read `error_code` on the publication status page, or the CLI's JSON.
- Correlate with the web request that queued it: the `correlationId` is the same value in both.
- Fix the cause, then `npm run ebook -- retry --job <job-uuid>`. A failure never auto-requeues.
- Do **not** retry a `STALE_VERSION` failure — it will always lose to whatever is now the newest
  version for that edition. Re-upload as a new version instead.

Full failure taxonomy and lease mechanics: `docs/runbooks/epub-processing.md`.

## Step 4 — preview and publish

On `/admin/publications/<asset-id>`:

1. Status reads **Ready for preview**.
2. Step through the resource buttons and confirm the preview frame renders real content. This
   streams the private derived resource through the admin-gated route, so a blank frame means a
   delivery problem, not a styling one.
3. Check the table of contents. An empty one is ambiguous by design — it means either the book has
   no TOC or its navigation could not be parsed (Ruling AY). Open the source EPUB to tell which.
4. **Publish**. Confirm the dialog. Status becomes **Published (currently active)**.

Publishing a version makes it the book's active EPUB but does **not** make the book public. On
`/admin/books/<book-id>`:

5. Fill the Vietnamese (or English) description and save that copy.
6. Upload a cover image with alt text.
7. In **Publish**, confirm the checklist is empty, then **Publish book** and confirm the dialog.

`publish_book` refuses a book with no complete localization, author, cover, active offer, or
published EPUB version, and it publishes the primary author with the book. Unpublishing hides the
book from the catalog and blocks new purchases — see Step 6. Readers who already own an edition keep
it in their library and can still read it.

## Step 5 — grant access and read

1. Grant the reader a complimentary entitlement (admin grant; a reason is mandatory and recorded
   in the immutable audit log).
2. Sign in as the reader and open `/{locale}/library`. The book appears with its progress
   percentage.
3. **Continue reading** opens `/{locale}/read/{bookId}`.
4. Revoke the complimentary entitlement with a reason. Confirm the entitlement becomes `revoked`,
   the library card disappears, and the same reader can no longer open a reader session.
5. Grant it again before continuing the browser matrix. Confirm the same entitlement is reactivated
   and the library card returns.

For each fixture and browser, walk the columns in `docs/runbooks/reader-corpus-matrix.md` — render
fidelity, embedded fonts, images, long-chapter performance, internal links, TOC navigation,
typography and width changes against real content, reload restore, sample boundary, and time to
first page — and record the result there, not here. That runbook is the one place these rows live;
also confirm while you are on this step that next/previous **disable themselves** at the first and
last page, which is what ADR-005's gap (a) closure bought — a control that stays enabled at a
boundary means the engine is reporting its boundary state wrongly.

## Step 6 — verify public visibility anonymously

Do this in a **private window**, signed out. It is the check every automated path used to route
around, and the reason three defects survived review.

1. The published book is publicly readable, and its author is too.
2. A book you have **not** published is not.

There is no public catalog page in this MVP, so verify at the data boundary with the publishable
(anonymous) key rather than through a rendered page:

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/books?select=id,status,authors(display_name,status)&status=eq.published" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
```

The published book must appear **with a non-null author**. A null author means `authors.status`
was never set to `published`, which would make the book unattributable everywhere it is listed.
An unpublished book must not appear at all.

Covers are out of scope: both storage buckets are private and this MVP has no cover delivery
route, so there is nothing to fetch.

## Step 7 — verify the protections hold

1. **Source EPUB is unreachable anonymously.** Signed out, request the `ebook-source` object path
   directly; the bucket is private and must refuse.
2. **Paid resources are unreachable without an entitlement.** Signed out, request
   `/api/reader/publications/{publicationId}/resources/{href}` for a non-sample resource. Expect
   `401` — decided before any lookup, so it says nothing about whether the publication exists.
3. **Samples are an explicit allowlist.** Request a sample href at `/api/samples/{id}/resources/…`.
   A resource that is not in `book_samples.allowed_hrefs` **and** not marked `access_class = sample`
   must be refused with `404`, never `403` — a distinct status for "exists but forbidden" would be
   an existence oracle.
4. **Revocation is immediate.** Revoke the entitlement while the reader has the book open. Their
   very next resource request must fail; the check is re-run per request, not at session creation.

## Step 8 — verify progress restore

1. Read several pages, then use **Back to library**. Leaving flushes the position with a normal
   awaited request, so it is saved before the navigation happens.
2. Reopen the book. It must resume at the **exact** position, not the top of the chapter.
3. Change typography, reload, and confirm the position still restores — locator stability across a
   typography change is an explicit ADR-005 gate criterion.
4. Open the same book on a **second device**, read further, then return to the first and reload.
   The later position wins. Ordering across devices is by server clock; within one device it is by
   that device's own sequence.
5. Simulate a save failure (offline the tab briefly, turn a page, come back online). A
   non-blocking retry control appears, the reader is never interrupted, and the position is not
   lost.

## Step 9 — record the evidence

Fill in one row per fixture per browser in `docs/runbooks/reader-corpus-matrix.md` — that runbook
owns the table, the per-column judging rules, and the acceptance gate, so this step does not repeat
any of them. **Every cell is currently unmeasured.**

Do not paste EPUB content, chapter text, or screenshots of paid content into the matrix, an issue,
or a commit. Record outcomes, codes, and timings only.
