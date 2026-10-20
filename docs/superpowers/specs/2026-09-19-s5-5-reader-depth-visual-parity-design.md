# S5.5 Reader Depth and Visual Parity Design

**Status:** Approved
**Date:** 2026-09-19
**Parent spec:** `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md`
**Builds on:** S4 reader completion (PR #19) and S5 SEO and operations
**Reads with:** `docs/adr/ADR-005-reader-engine.md`

## 1. Goal

Move P1.1 Reader Depth into the pre-launch sequence and make the reader match the approved reading
design. An entitled reader can highlight text, attach notes, create named bookmarks, search the full
book, copy or share a short attributed quote, reopen every saved item at its locator, and use a
premium responsive reading shell. The shell uses a persistent sidebar and a two-page spread on wide
desktop screens, while tablet and mobile retain the same capabilities in a one-page layout.

This work is S5.5. It runs after S5 and before S6. S6 validates and launches this reader rather than
the simpler S4 surface.

## 2. Outcomes

| Surface | Outcome |
| --- | --- |
| Entitled reader | Desktop visual parity, responsive one/two-page reading, selection toolbar, annotations, search, attributed copy/share, richer completion |
| Reader sidebar | Contents, bookmarks, and notes with counts and locator navigation |
| EPUB processing | Private searchable text chunks and stable reading positions derived from sanitized XHTML |
| Reader API | Session-authorized annotation CRUD and in-book search without exposing full chapter text |
| Library continuity | Highlights, notes, bookmarks, progress, and completion remain tied to an immutable publication version |
| Future AI affordance | “Ask Infinity — Coming soon” is visible but disabled and sends no content or request |

## 3. Scope

### 3.1 Functional scope

- Create, recolor, reopen, and delete highlights in yellow, green, or rose.
- Attach, edit, and remove a private note on a highlight.
- Create, rename, reopen, and delete a bookmark at the current locator.
- Search the entitled publication, group results by chapter, and navigate to the matching passage.
- Copy or share at most 300 Unicode grapheme clusters from the current text selection, always followed by
  the book title, author, and canonical book URL.
- Preserve annotation anchors across reload and ordinary typography, width, theme, and responsive
  spread changes.
- Replace the S4 completion card with actions for the library, saved notes/highlights, and related
  books when catalog data exists.
- Keep all personal reader data private and authorization-protected.

### 3.2 Visual scope

- At widths of 1280px and above, render a persistent 360–420px sidebar and a two-page reading spread
  with a quiet center divider.
- Below 1280px, render one page and move the sidebar into an accessible drawer.
- Put Contents, Bookmarks, and Notes in the same sidebar, with the current chapter and item counts.
- Add a top toolbar for search, page layout, reader settings, overflow actions, and the disabled
  future Ask Infinity affordance.
- Add a selection toolbar anchored beside the selection on desktop and shown as a bottom action
  sheet on touch-sized layouts.
- Add a footer with previous/next affordances and stable digital position numbers.
- Apply light, paper, and dark themes to both the reader chrome and publication.

### 3.3 Breakpoint contract

| Viewport | Navigation surface | Publication layout | Selection actions |
| --- | --- | --- | --- |
| 390px reference | Drawer | One page | Bottom action sheet |
| 768px reference | Drawer | One page | Anchored toolbar when space permits, otherwise bottom sheet |
| 1440px reference | Persistent sidebar | Two-page spread | Anchored toolbar clamped to viewport |

The implementation may use CSS container/media queries, but these three widths are acceptance
fixtures and must not depend on browser sniffing.

## 4. Out of Scope

- Ask Infinity implementation, RAG, embeddings, prompts, model calls, citations, or AI telemetry.
- Public or collaborative annotations, comments, reactions, and social feeds.
- Annotation export files, bulk export, import, or migration between different publication versions.
- Cross-device reader preference sync. S4's device-local preferences remain unchanged.
- Full-book copy, printing, downloading, or quote sharing above 300 characters.
- Annotation and full-book search in the public sample reader.
- Fixed-layout EPUB support, audiobook support, native applications, and DRM changes.
- A reviews domain. Completion can show related books, but it does not create reviews.

## 5. Delivery Strategy

S5.5 is one release with six independently reviewable gates:

1. Annotation and search schema plus RLS.
2. Search extraction, stable positions, and existing-publication backfill.
3. Engine-neutral selection, decoration, activation, and spread contracts.
4. Annotation, bookmark, search, copy, and share flows.
5. Responsive visual parity and richer completion.
6. Cross-browser, accessibility, security, visual, and EPUB-corpus verification.

Each gate must leave the repository passing its focused tests. Database and client contracts land
before the UI that consumes them. The existing S4 reader stays usable until the visual-parity gate
switches the shell.

## 6. Data Model

### 6.1 `reader_annotations`

A new migration creates one table:

| Column | Rule |
| --- | --- |
| `id` | UUID primary key |
| `profile_id` | Required FK to `profiles`, cascade on profile deletion |
| `publication_id` | Required FK to immutable `ebook_publications` |
| `kind` | `highlight` or `bookmark` |
| `locator_json` | Validated engine-neutral `ReaderLocator` |
| `selected_text` | Required for highlight, null for bookmark, maximum 1,000 characters |
| `color` | `yellow`, `green`, or `rose` for highlight; null for bookmark |
| `note_text` | Optional private note on a highlight, maximum 5,000 characters |
| `label` | Required bookmark name, 1–120 characters; null for highlight |
| `created_at`, `updated_at` | Server timestamps |

The model deliberately represents a note as private text on a highlight. A selected passage can be
highlight-only or highlight-plus-note, and the Notes tab is the subset whose `note_text` is not
null. This avoids two rows competing for the same locator and still supports every approved flow.

Indexes cover `(profile_id, publication_id, updated_at desc)` and
`(profile_id, publication_id, kind)`. Duplicate locators are allowed because a reader may
intentionally bookmark a highlighted passage.

RLS permits select/insert/update/delete only when:

- `profile_id` belongs to `auth.uid()`;
- the caller has an active entitlement for the publication's book;
- the publication is published, active for the book, and the book is published.

Revocation makes rows inaccessible without deleting them. If access is legitimately restored to
the same publication, the rows become available again. A later publication version does not
silently inherit old annotations; cross-version migration remains out of scope.

### 6.2 `ebook_search_chunks`

A second table contains private derived text:

| Column | Rule |
| --- | --- |
| `id` | UUID primary key |
| `publication_id` | FK to `ebook_publications`, cascade on publication deletion |
| `href` | Original in-publication resource href |
| `chapter_title` | Nullable title resolved from the publication TOC |
| `ordinal` | Stable whole-publication order |
| `plain_text` | Sanitized plain text for one bounded block |
| `locator_json` | Locator containing href, CSS selector, text quote, and short context |
| `search_document` | `tsvector` built with the Postgres `simple` configuration |

Rows are not readable through the Data API. Search is exposed only through an entitlement-aware
server path. A unique key on `(publication_id, ordinal)` makes re-indexing idempotent. A GIN index
on `search_document` supports token search; normalized unaccented text and `pg_trgm` provide
diacritic-insensitive fallback for Vietnamese query variants.

No analytics event or operational log may include `plain_text`, selected text, note text, or a full
locator.

### 6.3 Stable digital positions

EPUB has no typography-independent print page count. The processor therefore emits Readium-style
positions at approximately 1,024 Unicode characters, preserving resource and locator order. The
new nullable `ebook_publications.positions_json` column stores the ordered locator array. It is
nullable during rollout so an already-published book remains readable before backfill. The
authorized manifest route projects the array into its response as an Infinity Books extension, and
the adapter prefers it over S4's one-position-per-resource fallback.

The UI labels them as pages to match the approved design, but the product contract treats them as
stable digital positions:

- one-page layout: `Page 60 / 248`;
- two-page layout: `Pages 60–61 / 248`;
- no print-edition page equivalence is claimed.

Completion remains based on S4's navigation-boundary-derived whole-book progression, not position
arithmetic.

## 7. EPUB Processing and Backfill

Only sanitized XHTML is indexed. During processing:

1. Parse sanitized XHTML into bounded semantic blocks such as headings, paragraphs, list items,
   quotations, and table cells.
2. Normalize whitespace without changing the stored publication resource.
3. Generate a stable CSS selector within the immutable resource and capture text-before,
   highlighted text, and text-after context.
4. Associate the block with the deepest matching TOC entry.
5. Produce search chunks and 1,024-character positions in reading-order sequence.
6. Persist resources, publication, search chunks, and `positions_json` in the same completion transaction
   so a ready publication never has a partial index.

`ProcessedPublication` gains `searchChunks` and `positions`; both stay framework- and
database-neutral. `complete_processing_job` accepts them and replaces rows for only the job's new
publication.

Existing published versions are indexed with:

```text
npm run ebook -- index-search --publication <uuid>
```

The command downloads that publication's already-sanitized private XHTML resources, derives the
same chunks and positions, and transactionally replaces the search rows plus
`ebook_publications.positions_json`. It never reads or rewrites the source EPUB, publication
version, active pointer, manifest object, or stored resource bytes. It is idempotent and prints
counts and identifiers only, never book text.

## 8. Reader Engine Boundary

`lib/reader/types.ts` adds engine-neutral values:

```ts
export type ReaderSelection = {
  locator: ReaderLocator;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
};

export type ReaderAnnotationDecoration = {
  id: string;
  locator: ReaderLocator;
  color: "yellow" | "green" | "rose";
};

export type ReaderPositionInfo = {
  current: number;
  end: number;
  total: number;
};

export type ReaderAnnotationRenderResult = {
  unresolvedIds: string[];
};
```

`ReaderEngine` gains:

```ts
setSelectionListener(listener: (selection: ReaderSelection | null) => void): void;
setAnnotationActivationListener(listener: (annotationId: string) => void): void;
setAnnotations(annotations: ReaderAnnotationDecoration[]): Promise<ReaderAnnotationRenderResult>;
setResponsiveLayout(input: { pageCount: 1 | 2 }): Promise<void>;
getPositionInfo(): Promise<ReaderPositionInfo | null>;
```

The Readium adapter alone maps `BasicTextSelection`, `Locator`, `Decoration`, decorator groups, and
`columnCount`. It uses one decoration group for user highlights and registers activation only for
that group. Unknown or unresolvable locators are skipped and reported to the client as unresolved;
one bad annotation cannot prevent the book from mounting.

The S4 rule that no navigator listeners are registered is narrowed: S5.5 registers only
`textSelected`. Page turns and keyboard shortcuts still call adapter methods and reconcile from
their returned navigation state. Direct Readium keyboard-peripheral navigation, swipe navigation,
and unobserved position changes remain disabled.

## 9. Server Interfaces

All entitled endpoints read the per-publication reader-session cookie with `readerSessionIdFrom`
and call `authorizeReaderSession` before reading or mutating data. A missing, expired, revoked, or
superseded session returns the same non-disclosing 404 behavior as protected resources. A missing
application session returns 401.

### 9.1 Annotation routes

```text
GET    /api/reader/publications/{publicationId}/annotations
POST   /api/reader/publications/{publicationId}/annotations
PATCH  /api/reader/annotations/{annotationId}
DELETE /api/reader/annotations/{annotationId}
```

- GET returns annotation DTOs for the authorized profile and exact publication.
- POST accepts either a highlight or bookmark payload and derives `profile_id` from the authorized
  context, never the body.
- PATCH changes only color/note for a highlight or label for a bookmark; it cannot move a row to
  another profile or publication.
- DELETE returns success for an owned row and the same not-found response for a missing or foreign
  row.
- Payloads are rebuilt from validated fields before database writes.

### 9.2 Search route

```text
GET /api/reader/publications/{publicationId}/search?q={query}
```

- Query length after trimming is 2–100 characters.
- At most 50 results are returned.
- Results contain `chapterTitle`, a bounded excerpt, and a validated `ReaderLocator` only.
- Exact/accent-insensitive token matches rank before trigram fallback.
- The route never returns a complete chunk when the excerpt limit is smaller.

The sample reader calls none of these endpoints.

### 9.3 Reader page data

`getReadableBook(locale, bookId)` adds `authorName`, `canonicalBookUrl`, and a bounded list of
related published books to its server-only DTO. The reader page passes those presentation values to
the client; it does not expose storage keys or additional publication identifiers. Copy/share and
completion consume this server-derived data rather than reconstructing catalog URLs in the browser.

## 10. Client Data Flow

### 10.1 Opening the reader

1. Mint the S4 reader session.
2. Mount the engine and apply stored preferences.
3. Load TOC, navigation state, position information, and annotations.
4. Apply annotations through the engine before announcing the ready state.
5. Choose one or two pages from the viewport contract and reapply layout on breakpoint change.

Annotation loading failure does not hide the book. The sidebar shows a retry state, while the
publication remains readable.

### 10.2 Creating and editing an annotation

1. Readium emits an engine-neutral selection.
2. The client clamps the action surface to the viewport.
3. Highlight/note creates an optimistic decoration with a client ID.
4. POST replaces it with the server row on success.
5. Failure marks that item unsynced and offers Retry or Delete without interrupting reading.
6. Activating an existing decoration opens its editor for color, note, or delete.

Changing page, opening another blocking panel, pressing Escape, or explicitly dismissing the
toolbar clears the current selection. It does not delete an already-created annotation.

### 10.3 Bookmark flow

The client asks the engine for the current locator and chapter title. The default label is the
chapter title or localized “Bookmark”; the reader can edit it before save. Reopening a bookmark
calls `engine.goTo(locator)` and follows the same progress-save path as TOC navigation.

### 10.4 Search flow

Search input debounces for 250ms and cancels superseded requests. Results are grouped by chapter.
Selecting one calls `engine.goTo(locator)`, clears the selection toolbar, updates progress, and
closes the drawer on layouts below 1280px. Desktop keeps the sidebar open.

Search history is not persisted.

### 10.5 Copy and share

The selected quote is truncated to 300 Unicode grapheme clusters, using `Intl.Segmenter` with an
`Array.from` fallback. The payload is:

```text
“{quote}”
— {book title}, {author}
{canonical book URL}
```

Copy uses the Clipboard API. Share uses the Web Share API when available and otherwise copies the
same attributed payload. Neither action writes the quote to analytics, application logs, or the
database. The UI announces when truncation occurred.

## 11. User Interface

### 11.1 Desktop shell

The persistent sidebar contains:

- back to library;
- book title and author;
- whole-book progress and current chapter;
- Contents, Bookmarks, and Notes tabs;
- current TOC entry marked with `aria-current`;
- saved-item counts and empty/error states.

The main area contains a two-page publication spread, a quiet center divider, top controls, and the
position footer. Previous/next controls remain explicit. Arrow Left and Arrow Right call the same
engine methods when focus is not inside an input, textarea, dialog, menu, or content-editable
surface.

### 11.2 Tablet and mobile shell

The publication is one page. The sidebar becomes the existing accessible dialog/drawer pattern,
expanded to host all three tabs. The top bar retains back, title, progress, and a compact menu.
Every action remains available; responsive behavior may move an action but may not remove it.

### 11.3 Selection actions

Desktop renders the toolbar adjacent to the selection coordinates and clamps it within the reader
viewport. Touch-sized layouts use a bottom action sheet. Both offer three highlight colors, Note,
Copy, Share, and a disabled Ask Infinity control labelled “Coming soon”. The disabled control has no
handler and must emit no network request.

### 11.4 Completion

At whole-book progression 1, the completion panel offers:

- return to library;
- open the Notes tab;
- open the Highlights/Bookmarks sidebar state;
- related published books when the existing catalog relation query returns any.

The panel adds no review persistence or review prompt.

## 12. Internationalization

Every control, status, error, empty state, page label, color name, and “Coming soon” string exists in
both `vi` and `en` dictionaries. Book content, selected text, notes, and bookmark labels are never
translated by the application.

The canonical URL in copy/share uses the current book localization. Locale, publication language,
market, and currency remain independent.

## 13. Accessibility

- Sidebar, reader, toolbar, and footer use semantic landmarks.
- Contents, Bookmarks, and Notes implement an accessible tablist.
- Selection actions use roving keyboard focus; Escape dismisses them and returns focus to the
  reader control that owns the surface. Dismissing the application toolbar does not require a
  cross-frame command to clear the browser's native selection; navigation or the reader's next
  pointer action clears it normally.
- Every touch target is at least 44px.
- Highlight controls expose color names and note state, not color alone.
- Save success/failure uses a polite live region; recoverable failures do not interrupt reading.
- Drawer/dialog focus trapping and focus return continue to use the shared dialog primitive.
- `prefers-reduced-motion` disables drawer, toolbar, and panel transitions.
- Light, paper, and dark themes retain visible focus and contrast in reader chrome and content.

## 14. Security and Privacy

- The raw EPUB and processed resources remain private.
- Annotation and search requests repeat reader-session authorization; a page-level gate is not
  sufficient.
- Cross-user IDs return the same not-found response as missing IDs.
- Search chunks have no anonymous/authenticated Data API select policy.
- Sample routes never query the full search index.
- Note text, selected text, search query text, and quote text are excluded from analytics and logs.
- Copy/share is a deterrence policy, not DRM. The UI limit is 300 characters; server endpoints do
  not offer a path to retrieve arbitrary concatenated text.
- Locator JSON is size-limited and parsed with `parseReaderLocator` before storage or navigation.
- Ask Infinity is presentation only and cannot send selected or publication content.

## 15. Failure and Recovery

| Failure | Behavior |
| --- | --- |
| Annotation load fails | Book remains readable; sidebar shows Retry |
| Create/update/delete fails | Optimistic item is marked unsynced; Retry/Delete is available |
| Search fails | Search panel shows a scoped retry state; reader remains usable |
| Locator no longer resolves | Saved item remains listed as “Location unavailable”; it is not deleted |
| Reader session expires | S4 one-time re-mint applies, then the request retries once |
| Entitlement is revoked | Content, annotation, and search paths converge on lost-access behavior |
| Web Share unavailable | Copy the same attributed text and announce the fallback |
| Clipboard unavailable | Show a non-blocking error; do not expose an unbounded fallback textarea |
| Position list absent during rollout | Hide page-position text and retain percentage/progress; reading is not blocked |

## 16. Testing

### 16.1 Database

pgTAP covers:

- all table constraints and indexes;
- owner CRUD;
- user A cannot read or mutate user B's rows;
- a revoked or inactive entitlement cannot read or mutate annotations;
- a superseded publication cannot be searched or annotated;
- search chunks have no direct browser-readable policy;
- search ranking, 50-result cap, and accent-insensitive Vietnamese fallback;
- re-indexing replaces one publication's derived rows without touching another.

### 16.2 Unit and component tests

Vitest covers:

- selection and locator conversion;
- Readium decoration mapping and activation;
- one/two-page responsive decision;
- position-range formatting;
- annotation payload validation and DTO mapping;
- Unicode-safe 300-character quote truncation and attribution;
- search grouping and locator navigation;
- sidebar tabs and counts;
- optimistic save, retry, unresolved locator, and empty states;
- the disabled Ask Infinity affordance has no handler;
- sample mode issues no annotation or search request.

### 16.3 End-to-end and visual tests

Playwright covers:

- create a highlight, reload, change typography/theme/width, and observe it at the same text;
- recolor and delete a highlight;
- create, edit, and delete a note;
- create and rename a bookmark, leave the book, and reopen its exact locator;
- search Vietnamese with and without diacritics and navigate to the result;
- copy/share never exceeds 300 quote characters and always contains attribution and canonical URL;
- 1440px has persistent sidebar and two-page spread;
- 768px and 390px have one page and an accessible drawer;
- Ask Infinity emits no request;
- sample mode emits no annotation/search request;
- revocation blocks publication, annotations, and search on the next protected request.

Deterministic visual snapshots cover 390, 768, and 1440px for light, paper, and dark themes. The
five-private-EPUB corpus matrix gains selection, decoration, search locator, one/two-page spread,
and annotation restore columns across desktop Chrome, Safari, Firefox, and mobile.

## 17. Exit Criteria

- All functional and visual scope in sections 3 and 11 works at 390, 768, and 1440px.
- Highlights, notes, and bookmarks survive reload and ordinary layout/preference changes.
- Search covers the whole entitled publication and cannot expose an unentitled or non-sample
  resource.
- Copy/share enforces the 300-character quote limit and required attribution.
- Desktop renders two pages and a persistent sidebar; tablet/mobile render one page and a drawer.
- Page-position display is stable across typography changes and never drives completion.
- Ask Infinity is visibly future-facing, disabled, and network-inert.
- Accessibility tests, visual snapshots, annotation/search RLS tests, and corpus-matrix additions
  pass.
- `npm run db:reset`, `npm run db:test`, `npm run check`, and `npm run check:full` pass against the
  local Supabase stack.

## 18. Roadmap Change

- The launch baseline becomes 16 weeks.
- W13–14 is S5.5 Reader Depth and Visual Parity.
- S6 Hardening and Launch moves to W15–16 and validates the S5.5 reader.
- P1.1 Reader Depth moves from post-launch to pre-launch without becoming a security/correctness P0
  requirement.
- Ask Infinity remains P2.1. S5.5 ships only its disabled “Coming soon” affordance.
