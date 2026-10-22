# Runbook: reader depth rollout and recovery

Use this runbook for the S5.5 searchable positions and private annotations release. All commands
below are for a local Supabase stack unless a production rollout has been explicitly authorized.
Never point Playwright, fixture helpers, or a database reset at the cloud project.

## Rollout order

Deploy in this order:

For the S6 rollout, first pause old EPUB workers and let their in-flight jobs settle. The search
processing migration retires the old `complete_processing_job` signature; an old worker cannot
complete a job after that migration. Keep workers paused until the compatible worker is installed,
then resume processing. This is a rollout prerequisite, not a production action performed by S5.5.

1. **Schema:** apply the additive annotation, search-index, position, RLS, and RPC migrations.
2. **Worker:** deploy the EPUB processor that writes sanitized search chunks and stable positions in
   the same completion transaction as the publication.
3. **Application:** deploy the session-authorized annotation/search routes and reader UI.
4. **Operator backfill:** index already-published publications after the first three layers are live.

Do not run the backfill before the compatible worker and application are deployed. The application
continues to open an old publication whose `positions_json` is null; it hides digital page labels,
keeps percentage/progress behavior, and uses the engine's fallback mount positions.

## Local backfill

Use a local stack and a publication UUID whose processed resources already exist in private
storage:

```bash
npm run ebook -- index-search --publication <publication-uuid>
```

The command reads already-sanitized XHTML, replaces only that publication's derived search rows and
positions transactionally, and prints identifiers/counts rather than book text. It is idempotent.
If it fails, fix the reported processing or storage condition and rerun the same command. Do not
modify the publication version, active-publication pointer, source EPUB, or stored resource bytes.

## Reader recovery behavior

- A failed annotation create, update, or delete remains visible as unsynced. Use its **Retry** or
  **Delete** action; do not discard it silently.
- An annotation whose locator no longer resolves remains listed as **Location unavailable**. Keep
  the row for later diagnosis or a corrected processor/backfill; unresolved does not mean deleted.
- An expired reader session is re-minted once and the protected request retries once. Repeated 401
  or 404 responses converge on the signed-out or lost-access state rather than looping.
- Revoking entitlement immediately denies manifest/resource, annotation, and search requests.
  Restoring the same publication's entitlement makes its existing private annotations visible
  again. A later publication version does not inherit them.
- If Web Share is unavailable, **Share** copies the same attributed, 300-grapheme-bounded quote.
  If Clipboard is also unavailable, show the non-blocking error; never render an unbounded fallback
  textarea. Quote text, notes, selections, queries, and full locators must not enter logs/analytics.

## Rollback

Roll back the application and worker only to versions that tolerate the additive database shape.
Leave annotation rows, search rows, positions, functions, and policies in place. Do not run a
destructive down-migration and do not delete reader data to make an older application start. Pause
operator backfills during rollback; after the compatible application returns, resume the same
idempotent `index-search` command for publications that were not completed.

## Local verification

Follow `docs/runbooks/testing-environments.md`, export the local stack variables before building,
and serialize database/build/browser work:

```bash
supabase db reset --workdir <owned-local-workdir>
supabase test db --workdir <owned-local-workdir>
npm run check:full
E2E_BROWSER_MATRIX=all npm run test:e2e -- \
  e2e/ebook-golden-path.spec.ts e2e/reader-depth.spec.ts
bash scripts/run-reader-visual-container.sh
git diff --check
```

Visual updates are review artifacts, not a way to silence failures. Regenerate only intentionally
changed cases, inspect them, then rerun the entire Chromium visual file without update mode. The
private five-EPUB and physical Safari/mobile checks remain separate owner-run evidence in
`docs/runbooks/reader-corpus-matrix.md`.

## Shared quote cards (S16)

Share in the reader creates a public page at `/{locale}/q/{code}` with the quote, the book, its
action, and an Open Graph image. The quote is the same 300-grapheme attributed text as Copy; only
the URL differs. Before the first share the toolbar says that sharing creates a public page the
reader can remove from their library, and confirms when a page was created. If the server refuses
or does not answer within 3 seconds (offline, 200-card cap, revoked access) the reader still gets
the Copy text with the book URL and sees no error. If the share sheet fails for a reason other than
the reader cancelling it, the text goes to the clipboard.

- Readers manage their cards at `/{locale}/library/quotes` (copy link, remove). The library links
  there only when the reader has at least one active card.
- Admins take a card down at `/admin/quotes` (filter by book from the book editor). Removal writes
  an `audit_logs` row with the card id; the code is never reused.
- Cards are `noindex, follow`, not in the sitemap or `llms.txt`, and 404 when removed or when the
  book is unpublished; so does the Open Graph image. Next serves that image at a hashed
  `opengraph-image-<hash>` path, so read it from the page's `og:image` tag. Views are the
  `view_quote` analytics rows for the card.

### Passage cards (S20)

Share first opens a small dialog: an optional question (280 characters at most) and the kind of
text (verbatim, translation, or paraphrase; verbatim by default). The card shows both. The share
also records the passage the selection falls in (`shared_quotes.chunk_ordinal`, resolved with
`reader_chunk_for_locator`); a selection that maps to no passage is shared without one.

- The card shows "Continue reading from here" only while that passage still exists and the sample
  allows it (the same rule as `sample_chunk_locator`, which also needs the shared publication to
  still be the edition's live one). The link opens `/{locale}/read-sample/{slug}?edition=…&anchor=…`.
- When passage alignment pairs the passage with another live edition, the card lists each language
  under "Read in". A language whose sample does not allow its aligned passage is named without a link.
- A share with a passage writes `passage_shared` (identifier columns only). A click on "Continue
  reading from here" sends `passage_opened`, which the analytics route accepts without a session.
  Neither event carries the quote or the question.
