# S4 Reader Completion Design

**Status:** Draft, pending review
**Date:** 2026-09-16
**Issues:** #9
**Parent spec:** `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md` (section S4)
**Builds on:** S1 catalog admin (PR #15), S2 public discovery (PR #17), S3 get and buy (PR #18)
**Reads with:** `docs/adr/ADR-005-reader-engine.md`

## 1. Goal

The reader meets the PRD §3.5 P0 requirements: a reader controls typography and theme, navigates by
table of contents, sees where they are in the book, keeps their place, learns when they have lost
access, and reaches a completion state. A visitor with no entitlement can read the public sample of
any book that has one.

Today the reader opens a book, turns pages, and saves its place. It has no settings, no table of
contents, no chapter title, no completion state, and no way to tell "you lost access" from "this
failed to load". `/{locale}/read-sample/[slug]` is linked from every book page with a sample and
returns 404, because the page does not exist.

## 2. What S4 Delivers

| Surface | Who | What it does |
| --- | --- | --- |
| `/{locale}/read/[bookId]` | Entitled reader | Settings panel, TOC drawer, chapter title, whole-book progress, lost-access state, completion card |
| `/{locale}/read-sample/[slug]` | Anyone | The public sample, with the same reading controls and the book's Get or Buy action at the end |
| `save_reading_progress` | Entitled reader | Also stores whole-book progression and moves the library item to `reading` or `completed` |
| `docs/runbooks/reader-corpus-matrix.md` | Owner | The manual browser and EPUB-corpus matrix that ADR-005 is waiting on |

## 3. Out of Scope

- Highlights, notes, bookmarks, and in-book search. These are P1.
- Analytics events (`open_reader`, `progress_25`…, `change_reader_setting`). S5 builds them.
- Cross-device preference sync. Preferences are per device, in `localStorage`, and never reach the
  server.
- Swipe and keyboard page-turn gestures. See section 4.3: the adapter registers no navigator
  listeners, and a gesture surface would break that property.
- Running the corpus matrix itself. S4 writes the runbook; the owner runs it, and S6 records the
  result against ADR-005.
- Changing the reader's delivery, session, or authorization model. Those are implemented and tested.

## 4. Key Decisions

### 4.1 Corrections to the parent spec

The parent spec was written before the reader API contract settled. Four of its statements do not
match the implementation, and S4 follows the implementation.

| Parent spec | Implementation | S4 |
| --- | --- | --- |
| "a 401 or 403 from a manifest, resource, or session request" | There is no 403 anywhere. Every refusal collapses to one indistinguishable 404 by design. | Lost access is 401 or 404. See 4.6. |
| "theme (light, paper, dark)" | `ReaderPreferences.theme` is `light \| sepia \| dark`. | The stored key stays `sepia`; "Paper" is its label. See 4.2. |
| "font (publisher, Lora, sans)" | `FONT_STACKS.serif` is a Georgia stack. | The key stays `serif`; the stack leads with Lora, already loaded as `--font-serif`. |
| "`totalProgression ≥ 0.99` moves the library item to `completed`" | `totalProgression` never leaves the browser. The column `reading_progress.progression` holds per-resource progression. | A new column carries whole-book progression. See 4.4. |

### 4.2 `ReaderPreferences` gains a width, and nothing else changes shape

```ts
export type ReaderPreferences = {
  fontFamily: "publisher" | "serif" | "sans";
  fontScale: number;
  lineHeight: number;
  width: "narrow" | "medium" | "wide"; // new
  theme: "light" | "sepia" | "dark";
};
```

The settings panel's vocabulary maps onto this rather than replacing it:

| Control | Values shown | Stored as |
| --- | --- | --- |
| Font size | 15–26 px | `fontScale = px / READER_BASE_FONT_PX` (16) |
| Font | Publisher, Lora, Sans | `publisher`, `serif`, `sans` |
| Line height | 1.5, 1.75, 2.0 | `lineHeight` |
| Width | Narrow, Medium, Wide | `width` |
| Theme | Light, Paper, Dark | `light`, `sepia`, `dark` |

Renaming the two enums would change the meaning of `ReaderPreferences`, `THEMES`, `FONT_STACKS`,
`toEpubPreferences`, and their tests for a label. The labels live in the dictionary, which is where a
label belongs.

`width` is deliberately **not** passed to `toEpubPreferences`. It sets the reading column's
`max-width` in the component: 34rem, 50rem (today's fixed value), 64rem. Column width is a property
of the container the engine renders into, not of the engine, so this keeps it out of the adapter
entirely.

The consequence is that changing the width resizes Readium's host element, and Readium re-paginates
on resize. That is a position-affecting layout change exactly like a font-size change, so it is
covered by the same exit criterion (section 9): the locator survives a reload that follows it.

### 4.3 `ReaderEngine` gains one member

```ts
// lib/reader/types.ts
export type ReaderTocEntry = { title: string; href: string; children: ReaderTocEntry[] };

// lib/reader/engine.ts
getTableOfContents(): Promise<ReaderTocEntry[]>;
```

ADR-005 requires every boundary member to be a shared abstraction rather than a Readium shape. A
table of contents is something any EPUB engine already has: Readium exposes
`publication.tableOfContents`, and epub.js — the ADR's deferred fallback — exposes
`book.navigation.toc`. Both are title/href/children trees. No engine type crosses the boundary.

The alternative, a second manifest fetch by the component, was rejected: the adapter already fetches
and owns the manifest, and a second fetch would make the component parse a delivery format twice.

`ReaderTocEntry.href` is the *rewritten* href the manifest carries
(`/api/reader/publications/{id}/resources/…` or `/api/samples/{id}/resources/…`), which is the same
space `ReaderLocator.href` lives in. That is what makes the chapter-title match in 4.5 a plain
comparison rather than a translation.

Navigating by TOC calls `engine.goTo(locator)`, which is adapter-initiated. The adapter registers no
navigator listeners on purpose, and `readium-engine.test.ts`'s "registers no navigator listeners"
test is the tripwire for that. A TOC jump preserves the property; a swipe or keyboard gesture
surface would not, which is why 3 excludes them.

### 4.4 Whole-book progression becomes a stored column

`reading_progress.progression` is progression *within the current resource*. The library's percentage
and `deriveLibraryState` both read it, so a reader two pages into a long chapter one can be shown
90% and, at the chapter's end, "Finished". The reader's own header is correct because it reads
`totalProgression` off the locator in memory — a value that is never sent anywhere.

A new migration:

- adds `reading_progress.total_progression numeric check (total_progression between 0 and 1)`,
  nullable, because rows written before this migration have no such value;
- replaces `save_reading_progress` with a version taking `p_total_progression numeric`.

`progression` keeps its current meaning. Overloading it would leave the column disagreeing with
`locator_json.progression` in the same row.

**No request contract changes.** `totalProgression` is already a field of `ReaderLocator`, so it is
already in every progress request body, already validated and clamped by `parseReaderLocator`, and
already stored inside `locator_json`. `saveProgress` reads it off the parsed locator and passes it as
`p_total_progression`. `POST /api/reader/progress` is untouched, and so is the client's request
shape — the value was being sent all along and thrown away at the RPC boundary.

The reconciliation rule does not change. `total_progression` is written by the same `on conflict`
statement, so a refused save does not write it either, and the effective row returned to the caller
carries it.

On a **winning** write only, the same function updates the library item:

```sql
update public.library_items
set state = case
      when state = 'completed' then 'completed'      -- never downgrade
      when p_total_progression >= 0.99 then 'completed'
      else 'reading'
    end
where profile_id = v_profile_id and book_id = v_book_id;
```

Browser roles have no `update` grant on `library_items` and no policy permits one, so this write is
only reachable through this `security definer` function. A completed book stays completed if the
reader pages backwards; the parent spec asks for a completion state, not a completion oracle.

`library_items.state` stops being dead. `lib/data/library.ts` reads `total_progression` for the
percentage and for `deriveLibraryState`, falling back to `progression` when it is null, so a reader
whose progress predates the migration is not reset to zero. The derived threshold becomes `>= 0.99`,
matching the RPC, instead of `progressPercent >= 100`.

A null `p_total_progression` is accepted and writes null — `getLocator()` can legitimately report
`totalProgression: null`. A value outside `[0, 1]` raises `EB009`, the function's single refusal
code, like every other invalid input.

### 4.5 Chapter title

The top bar shows the current chapter title beside the book title. It is derived, not stored:

- strip the fragment from `locator.href` and from each TOC href (`splitTocFragment`'s rule);
- walk the flattened TOC and take the **last** entry whose path equals the locator's path, so a
  nested entry wins over its ancestor;
- no match — common for a cover or a front-matter page absent from the nav — shows no chapter title
  rather than a wrong one.

This is a pure function in `lib/reader/toc.ts`, unit-tested against nested trees, fragment-bearing
entries, and a locator with no TOC match.

### 4.6 Lost access

`lib/reader/session.ts` collapses every refusal into one `ReaderAccessDeniedError` so that a request
for a real resource the caller lacks entitlement to is indistinguishable from a request for one that
does not exist. The handlers map that to a single 404. 401 means only "not signed in", decided before
any database access. 502 means an infrastructure fault (`ReaderUnavailableError`). There is no 403,
and adding one would rebuild the existence oracle that model exists to prevent.

So the reader's mapping is:

| Status from manifest, resource, or session | Meaning | What the reader shows |
| --- | --- | --- |
| 401 | The session is gone | Lost access, with a sign-in link back to this book |
| 404 | Entitlement revoked, publication superseded, or no such book | Lost access, with a link to the library |
| 502, network failure, anything else | An outage | Today's retryable "this book could not be opened" |

Before showing lost access, the client re-mints **once**: it re-posts `/api/reader/sessions` and
retries. A session that merely expired mid-book recovers silently, which is the parent spec's
requirement. The re-mint is attempted once per mount; a second failure shows the state. In sample
mode there is no session to re-mint, so a refusal goes straight to the state.

This needs `ReaderManifestError.status` — which the adapter already carries — to reach the component
instead of being swallowed into one `phase: "error"`. The session POST's status is surfaced the same
way.

Nothing about the *server* changes here. A revoked entitlement is already refused on the next
manifest, resource, or progress request by `authorize_reader_session` and `save_reading_progress`.
S4 only makes the client say the right thing about it.

### 4.7 Preferences are per device

Stored in `localStorage` under `infinity-books.reader.preferences`, beside the existing
`infinity-books.reader.device-id`. Read through a validating parser: an unparseable, partial, or
out-of-range value falls back to the default for that field rather than throwing, because a reader
whose stored preferences are corrupt must still get a book. Every access is wrapped, as the device-id
helper already is — private mode and blocked storage must not break reading.

Preferences are applied immediately after `mount()` resolves and before `phase` becomes `ready`, so
the restored locator is resolved against the final layout. Applying them afterwards would paint the
opening page at the default typography and then jump, which reads as a bug.

The same preferences apply in sample mode. They are a device setting, not a per-book one.

### 4.8 One reader client, two modes

`ReaderClient` gains `mode: "entitled" | "sample"`.

| | `entitled` | `sample` |
| --- | --- | --- |
| `POST /api/reader/sessions` | Yes, before mount | Never |
| `POST /api/reader/progress` | Yes, debounced and on exit | Never |
| Manifest | `/api/reader/publications/{id}/manifest` | `/api/samples/{id}/manifest` |
| Back link | The library | The book page |
| End of content | Completion card at `≥ 0.99` | The book's Get or Buy control |
| Settings, TOC, page turns | Yes | Yes |

Duplicating the client would duplicate the engine lifecycle and PR #16's iframe-sizing contract
(`relative` host plus the `[&>.readium-navigator-iframe]:*` rules), which is exactly the kind of
thing that gets fixed in one copy. A unit test asserts that sample mode issues no session and no
progress request, so the mode is a tested boundary rather than a convention.

### 4.9 The sample reader route

`/{locale}/read-sample/[slug]` is public. It must **not** be added to `readerPages` in
`lib/auth/route-access.ts` — anything under `/{locale}` that is not listed there is already public,
and listing it would put a sign-in wall in front of the one reading surface that has none. A
regression test in `route-access.test.ts` pins that.

`/api/samples/*` is keyed by publication id, but the public catalog DTOs deliberately carry none. A
new server-only `getSampleReaderBook(locale, slug)` in `lib/data/catalog.ts` resolves it, returning
`{ bookId, title, publicationId, action }` or `null`. It returns null — and the page renders
`notFound()` — when the localization does not exist for that locale, the book is not published, there
is no active publication, the active publication is not `published`, or its `book_samples` row has an
empty allowlist. That is the same condition `catalog_book_cards.has_sample` reports, so the book
page's sample link and this page agree.

The publication id reaches the client only inside the sample manifest URL, which is how the entitled
reader already works. No publication id is added to any catalog DTO.

`action` is `resolveBookAction`'s result, rendered by the existing `BookActionControl` at the end of
the sample: `read` for a reader who already owns it, `get_free`, `buy`, `coming_soon`, or
`unavailable`. Resolving it needs the viewer's entitlement, so the page reads the optional session
the way the book page already does — a signed-out visitor is not redirected, and their control links
to sign-in with `next` set back to the book page.

The page is `noindex`. The sample's *content* is public, but this surface is a reading application,
and the parent spec's robots rules list `read-sample` among the disallowed paths.

### 4.10 What the allowlist still guarantees

The sample reader changes no part of the sample trust boundary. `resolveSampleResource` requires the
href to be named in `book_samples.allowed_hrefs` **and** its `ebook_resources` row to carry
`access_class = 'sample'` **and** the publication to be `published`. The sample manifest never names
a non-sample href in any field, and `filterTocToServable` drops non-servable TOC nodes rather than
retaining them as ancestors, so no paid chapter title is disclosed through the new TOC drawer.

ADR-005's warning applies unchanged: the route's CSP header is inert on the reader path, and
`lib/epub/sanitize.ts` at ingest is the only boundary that removes hostile content. S4 relaxes
nothing there.

## 5. UI

Board 1k. The reader owns the viewport and draws its own chrome; no site header.

**Top bar.** Back link, book title, chapter title, and a `{percent}% read` readout, plus two icon
buttons: table of contents and settings. Both are at least 44px. At 390px the chapter title truncates
before the book title does.

**Settings panel and TOC drawer.** The repo has no overlay primitive beyond `select`. S4 adds
`components/ui/dialog.tsx` in the existing base-ui and shadcn style, and both surfaces are built on
it, so focus trapping, Escape, scroll locking, and `aria-modal` are implemented once rather than
hand-rolled twice. They use the existing `--shadow-drawer` and `--ease-quiet` tokens.

- `components/reader/reader-settings-panel.tsx`: five labelled groups, each a radio group except
  font size, which is a stepper with its current px value shown. Every change calls
  `setPreferences` and writes `localStorage` immediately; there is no Save button.
- `components/reader/reader-toc-drawer.tsx`: the nested TOC as a list, the current chapter marked
  `aria-current="true"`, each entry calling `engine.goTo` and closing the drawer. An empty TOC shows
  an empty state rather than an empty drawer.

**Completion card.** At `totalProgression >= 0.99` in entitled mode, a quiet card over the foot of
the reader: the book is finished, with a link back to the library. It is dismissible, and dismissing
it does not change `library_items.state` — the database already recorded the completion.

**Lost access.** Replaces the reading surface, not the chrome, so the way out stays visible.

**Sample end.** After the last sample page, a card naming the book with the `BookActionControl`.

Every control is reachable by keyboard, and the panels return focus to the button that opened them.

## 6. Data and Migration

One migration, `20260916*_reader_completion.sql`:

- `alter table public.reading_progress add column total_progression numeric check (total_progression between 0 and 1)`;
- `drop function public.save_reading_progress(uuid, jsonb, numeric, text, bigint)`, then
  `create function public.save_reading_progress(p_publication_id uuid, p_locator jsonb, p_progression numeric, p_total_progression numeric, p_device_id text, p_client_sequence bigint)`.

The argument list changes, so `create or replace` would leave a second overload behind rather than
replacing anything. The old five-argument function is dropped explicitly and the grants re-issued on
the new one: `revoke execute … from public, anon`, `grant execute … to authenticated`, exactly as
before. `lib/reader/progress.ts` is the only caller of the old signature, and it changes in the same
pull request.

`lib/supabase/database.types.ts` is regenerated in the same commit.

## 7. Security

- No new route reads anything with a service-role client that it did not already.
- The sample page is public by construction and adds no user gate, matching `/api/samples/*`.
- `getSampleReaderBook` returns null rather than an error for every refusal reason, so the page
  cannot be used to tell a draft book from a missing one.
- Preferences are a device setting with no server component; nothing about them is authorization.
- The lost-access state names no reason beyond "signed out" and "no longer have access", so it
  discloses no more than the 401/404 split already does.
- `library_items.state` remains writable only inside `save_reading_progress`.

## 8. Testing

**pgTAP** (`supabase/tests/020_reader_completion.sql`):

- a winning save stores `total_progression`;
- `>= 0.99` sets `library_items.state = 'completed'`; a lower value sets `'reading'`;
- a completed item is never downgraded by a later, lower save;
- a **refused** save (stale sequence, or an older cross-device timestamp) changes neither
  `total_progression` nor `state`;
- null `p_total_progression` is accepted; a value above 1 or below 0 raises `EB009`;
- an unentitled caller still raises `EB009` and writes no library row;
- `authenticated` cannot update `library_items` directly.

`supabase/tests/010_reading_progress.sql` is updated for the new signature, and its reconciliation
table still passes unchanged — that is the point of running it again.

**Vitest:**

- `lib/reader/preferences.ts`: defaults, round-trip, corrupt and partial values, out-of-range font
  size, storage that throws;
- `lib/reader/toc.ts`: chapter title from a nested tree, fragment-bearing hrefs, a locator with no
  match, deepest-match-wins;
- `lib/reader/readium-engine.test.ts`: `getTableOfContents` maps the publication's TOC and returns
  `[]` when there is none; `setPreferences` ignores `width`;
- `lib/reader/progress.ts`: `totalProgression` is forwarded and validated;
- `lib/data/library.ts`: percentage and state from `total_progression`, with the fallback for null;
- `lib/data/catalog.ts`: `getSampleReaderBook` returns null for each refusal reason;
- `components/reader/reader-client.test.tsx`: the existing iframe-sizing test still passes; sample
  mode issues no session and no progress request; a 401 and a 404 each re-mint once and then show
  lost access; a 502 shows the retryable error; the completion card appears at 0.99;
- the settings panel and TOC drawer: keyboard operation, focus return, `aria-current`;
- `lib/auth/route-access.test.ts`: `/vi/read-sample/x` is public;
- `app/api/reader/publications/[publicationId]/manifest/route.test.ts`, which does not exist today
  and is the one handler in the reader path with no test.

**Playwright (`e2e/reader-completion.spec.ts`):**

- open a book, change the font size and the width, reload, and land on the same locator
  (`reading_progress.locator_json` is the ground truth, as in the golden path);
- the TOC drawer opens, lists chapters, jumps to chapter 2, and the top bar names it;
- settings and TOC operate at 390, 768, and 1440px;
- page to the end: the library shows the book as finished and `library_items.state` is `completed`;
- revoke the entitlement, act in the open reader, and get the lost-access state;
- the sample reader opens anonymously, its network log contains no `/api/reader/*` request, and a
  fetch of a non-sample href returns 404.

`e2e/reader-access.spec.ts`'s existing assertions are unchanged.

## 9. Exit Criteria

- Settings, TOC, and resume work at 390, 768, and 1440px.
- The locator restores after a reload that follows a typography **or width** change.
- The sample reader cannot fetch any href outside its allowlist.
- Revoking an entitlement shows the lost-access state on the next protected request, and an expired
  session alone does not.
- Paging to the end of a book sets `library_items.state = 'completed'` and shows the completion card;
  the library agrees.
- The library's percentage reflects whole-book progression.
- `npm run db:reset`, `npm run db:test`, and `npm run check:full` pass on a clean local stack.

## 10. Documentation

- New `docs/runbooks/reader-corpus-matrix.md`: how to run the five private EPUBs across desktop
  Chrome, Safari, Firefox, and mobile, with a result table covering render fidelity, embedded fonts,
  images, long-chapter performance, internal links, TOC navigation, typography and width changes
  against real content, reload restore, sample boundaries, and initialization time. These are exactly
  the rows ADR-005 §"What this decision does not rest on" lists as unmeasured. The owner runs it; S6
  records the result and moves ADR-005 to Accepted or triggers its epub.js fallback.
- Update `docs/runbooks/golden-path-validation.md` to point at the matrix runbook rather than
  restating it.
- Update `docs/adr/ADR-005-reader-engine.md`: `getTableOfContents` joins the boundary, with the
  two-engine justification, and the "no navigator listeners" property is restated as a constraint on
  future navigation surfaces.
- Update `docs/runbooks/storefront.md` with the sample reader URL and its 404 conditions.
