# Runbook: reading journeys, passages, and the S20 pilot

Use this runbook for the S20 minimal reading pilot: reading journeys, the public edition record,
the whole-book free sample, passage deep links, automatic bilingual alignment, passage cards, the
homepage passage, and `/admin/growth`. Commands below are for a local Supabase stack. Never point
Playwright, fixture helpers, `ebook align`, or a database reset at the cloud project.

The design is `docs/superpowers/specs/2026-10-22-s20-minimal-reading-ux-design.md`.

## Reading journeys

A journey is a free, guided path through one edition of a book: up to 60 numbered sessions, each a
reading range with a short guide and up to three questions. Journeys have no SKU, entitlement, or
file. Any signed-in reader may open every session of a published journey.

### Create and publish

1. Open `/admin/journeys` and choose **New journey**. Pick the book, then one of its editions, and
   enter a slug (`a-z`, `0-9`, `-`, 3 to 64 characters, unique). A slug collision or an edition of
   another book is reported on the field.
2. On the journey editor, add per-locale text (title, summary) for `vi`, `en`, and `ja` as needed.
3. Add sessions. Start and end are chosen from the table of contents of the edition's active
   publication. The next free position is prefilled. Each session has per-locale title, guide
   (plain text, line breaks kept), and questions (one per line, at most 3 of 500 characters).
   A stored href that is no longer in the table of contents stays selectable, so a re-save never
   moves a session silently.
4. Choose **Publish journey**. Publishing needs at least one session and a localization in the edition's
   language when that language is an interface locale (`vi`, `en`, `ja`); otherwise it needs an
   English localization. The panel shows the refusal and clears it once the journey is ready.
   **Move to draft** and **Archive** hide the journey again. Publishing revalidates the storefront,
   so the book page's journey cards update.

### What readers see

- `/{locale}/journeys/{slug}` is public and cookie-less: title, book link, summary, the session
  list, and a hint to sign in to track progress. Its text falls back from the requested locale to
  the edition's language, then to English. A journey whose book or edition is not public is a 404.
- The book page shows a card for each published journey of the book.
- `/{locale}/journeys/{slug}/sessions/{position}` requires sign-in. It shows "Session N / total",
  the guide, the questions, a link that opens the reader at the session start, **Mark this session
  done**, and on the last position a free reflection (at most 2000 characters).
- The reader link carries `?anchor=` when the session start maps to a passage; otherwise it is the
  plain reader link and the reader opens at the saved position.
- `/{locale}/library` shows a **Reading journeys** section with done/total for each journey the
  reader has started. It appears even for a reader who owns no book.

### Database

- `mark_journey_session(journey_id, position)` and `complete_journey(journey_id, reflection)` are
  the only writes. Both are authenticated `security definer` functions that take the profile from
  `auth.uid()`, require a published journey, and are idempotent. Every refusal raises `EB047`.
- `complete_journey` needs at least one completed session; completing again replaces the reflection.
- They write `session_completed` and `journey_completed` analytics events, deduplicated per reader.
- Deleting a session leaves old progress rows for that position. Reports join live sessions.

## Edition record

On the edition page, **Provenance & editorial review** also holds:

- **Text kind** (`editions.text_kind`): literal, adapted, commentary, or unset.
- **Review scope** (`editions.review_scope`): full, sample, or none (default).
- **Public version note** (`editions.public_version_note`, at most 2000 characters): shown on the
  book page under "Version notes".

The book page shows a collapsed "About this edition" block with only the filled fields: sources,
rights and territory notes, text kind, review scope, review date, and the public version note. The
block is hidden when there is nothing to show. `editions.review_note` stays internal: it can hold a
block reason, and it is never returned to the storefront. Changing text kind, review scope, or the
public note does not withdraw an approval.

In the reader sidebar, **Report an error at this passage** opens the existing translation report
form with the current href and progression filled in.

## Whole-book sample

On the edition page, when an EPUB is live, the EPUB section shows **Open the whole book as a
sample** with **Save sample**. The checkbox is always enabled.

- `admin_set_sample_full(publication_id, true)` sets `book_samples.allowed_hrefs` to `["*"]`. The
  database refuses a paid edition with `22023`, shown as "Only a free edition can be opened in full
  as a sample." Free means the offer readers are shown costs 0, or the edition has no active offer.
- `admin_set_sample_full(publication_id, false)` is always allowed. It restores the worker's default
  list from the publication's `access_class = 'sample'` resources.
- Under `["*"]` the sample resolvers skip only the `access_class` check. A resource must still
  belong to the same live publication, and a publication that is not published is still refused.
  Every sample, listed or wildcard, is also refused unless the publication is its edition's active
  one and `edition_is_sellable` accepts that edition, so a blocked edition serves no sample.
- A signed-out visitor at `/{locale}/read-sample/{slug}` sees a banner linking to sign-in. The
  end-of-sample card with the Get control still appears on the last page.
- If the default offer later becomes paid, an open whole-book sample stays open until an admin
  clears the checkbox.

## Passage anchors

Passages are the search chunks the EPUB worker already writes (`ebook_search_chunks`). No new
anchor table or backfill exists; `npm run ebook -- index-search` covers old publications.

- `?anchor=<ordinal>` opens the reader (`/{locale}/read/editions/{id}`) or the sample
  (`/{locale}/read-sample/{slug}?edition=…`) at that passage.
- `reader_chunk_locator` (authenticated, the reader must hold the edition) and
  `sample_chunk_locator` (anon too; the edition must be sellable, the publication live, and the
  passage inside the sample: `"*"`, or a listed href whose resource is sample-class) return the
  passage locator. `reader_chunk_for_locator` maps an href and progression back to an ordinal.
- Every refusal returns null and the page silently opens at the saved position. Lookup errors are
  logged with the request ID as "Passage anchor lookup failed.".

## Bilingual alignment

Alignment is fully automatic. There is no manual alignment, no import, and no admin editing of
pairs. If two editions do not pair, the **Compare** button stays hidden.

- Resources pair by spine position. Inside a resource, equal chunk counts pair 1:1 (confidence 1).
  Counts within 10% pair by cumulative length (confidence 0.6). Anything else is skipped.
- It runs best-effort after every publish and rollback, scheduled with `after()` so the response
  does not wait. A failure is logged with the request ID and the transition still succeeds.
- Run it by hand on a local stack:

  ```bash
  npm run ebook -- align <bookId>
  ```

  It prints `{ bookId, runs }` with pair counts and coverage per direction. It first prunes rows
  whose publications are no longer live.
- The admin edition page shows "Passage alignment: N% of passages line up with another edition."
  and a **Recompute alignment** button. Coverage counts only pairs whose target is live.
- `reader_aligned_passage` requires the reader to hold both editions. The reader shows **Compare**
  only when coverage is above 0. The panel shows the aligned passage and a link to the other
  edition at its `?anchor=`. Opening it sends `compare_opened`.

**Stop condition (from the spec).** If the project's translations do not keep paragraph structure
and coverage stays under 70% on the pilot work, drop the compare feature and keep everything else.
Read the percentage on the pilot edition's admin page after publishing both editions.

## Passage cards

See [reader depth](reader-depth.md#passage-cards-s20). In short: Share opens a dialog with an
optional question (at most 280 characters) and a text kind label (verbatim, translation,
paraphrase). `/{locale}/q/{code}` shows **Continue reading from here** when the passage still exists
and the sample allows it, and a **Read in** row when alignment pairs it with another sellable live
edition. Events: `passage_shared` (server), `passage_opened` (anonymous allowed), and
`compare_opened` from the reader.

## Homepage passage

The home hero uses the S20 positioning. The primary button opens the featured book's sample when it
has one; a second button opens the featured book's first published journey when one exists. Under
the featured band, `catalog_home_passage(book_id)` may supply a pair of aligned passages. It returns
a pair only when confidence is 1, both texts are 120 to 400 characters, both editions are sellable
and live, and both passages are inside their samples. Otherwise the block is not shown.

## `/admin/growth`

Choose 30 days (default) or `?days=90`. Every ratio is shown as `n / d`, with a percent only when
`d > 0`. No thresholds are encoded; read the numbers against the pilot plan.

- **Funnel per book:** sample opens (events, including anonymous visitors) and readers who opened
  the reader are plain counts. Readers with a completed session and readers who completed a journey
  are distinct signed-in profiles, shown as ratios.
- **Day-7 return:** the cohort is each reader's first-ever `session_completed` UTC day inside the
  window. A reader returned when they have an `open_reader` event on day +6 to +8 inclusive. Cohorts
  younger than 8 days are still open.
- **Shared passages:** passages shared in the window, how many of those cards got a `view_quote`,
  and how many got a `passage_opened` in the window.

The three functions (`admin_growth_funnel`, `admin_growth_retention`, `admin_growth_share`) raise
`42501` for a non-admin and `22023` for a window outside 1 to 365 days.

## Migrations

The S20 migrations are `20261022100000` through `20261022160000`. They were edited in place during
this branch, before any environment applied them. Once any environment applies them, every further
change needs a new migration. Deploy the migrations before the application: the journey pages need
the tables, and the book page hides journey cards when the read fails.

## Local testing

Follow [testing environments](testing-environments.md). Use a local stack only. When ports 543xx
belong to another project, start a scratch stack with its own `--workdir` and ports, and do not use
the `npm run db:*` scripts, because they target the default ports:

```bash
supabase db reset --workdir <owned-local-workdir>
supabase test db --workdir <owned-local-workdir>
npm run check:full
```

Export the scratch stack's Supabase and Mailpit variables, plus `E2E_DATABASE_URL`, before
Playwright. Do not build against `.env.local` when it points at the cloud project.

S20 database tests: `press_journeys`, `press_edition_record`, `press_sample_full`,
`press_chunk_locators`, `press_passage_alignments`, `press_shared_passage`, `press_growth_report`.
S20 Playwright specs: `admin-journeys`, `reading-journey`, `sample-full`, `reader-compare`,
`shareable-quotes` (passage card case), `public-home`, and `localized-routing`.
