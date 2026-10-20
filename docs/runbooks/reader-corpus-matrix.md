# Runbook: reader corpus matrix

## Why this exists

ADR-005 (`docs/adr/ADR-005-reader-engine.md`) is **Provisional**. Automated generated-fixture
coverage now exercises Chromium, Firefox, and WebKit, but it does not establish fidelity for the
five private EPUBs or for physical Safari/mobile browsers. Every row in the matrix below is
currently unmeasured, and issue #1's exit criteria stay formally open until they are not. This
runbook is the one place that matrix gets filled in — do not keep a second copy of it anywhere else;
`docs/runbooks/golden-path-validation.md` points here instead of restating the rows.

Two real defects surfaced the last time this reader was actually run in a browser (see ADR-005's
"Whole-book progression" note), both in exactly the columns this matrix exists to measure — TOC
navigation and a real book's layout — and neither was reachable from a unit test, because every
adapter test mocks the navigator. Treat that as the reason this is owner-run rather than automated,
not as a formality to clear quickly.

The generated fixture also leaves one engine-specific limitation open: on the local HTTP harness,
WebKit blob frames omit cookies from linked EPUB stylesheet requests while Readium's CSP upgrades
insecure assets. WebKit functional journeys pass, but publisher CSS, images, and embedded-font
fidelity are not inferred from that result. Treat those columns as unverified until the owner-run
HTTPS/private-corpus checks supply evidence.

## What you need

- The five private EPUBs in `fixtures/epub/private/`. They are never committed — `*.epub` is
  git-ignored repository-wide — and `fixtures/epub/README.md` describes the feature coverage each
  one is meant to exercise.
- A local Supabase stack (`docs/runbooks/testing-environments.md`).
- An admin account (the `/internal/{locale}/sign-in` password fallback works for this).
- `docs/runbooks/epub-processing.md` for the processing CLI and failure taxonomy.

## Setup, per fixture

1. Record whether the EPUB declares any `image/svg+xml` manifest item **before** you upload it —
   see "A processor-rejection note" below. Do this first; it changes how you read a failure.
2. `npm run ebook -- validate fixtures/epub/private/<file>.epub` to catch a content problem before
   spending an upload-and-process cycle.
3. In `/admin`, create the book (or a new version if the book already exists) and upload the EPUB.
4. `npm run ebook -- process --asset <asset-id>`.
5. Preview the publication, then **Publish**.
6. Grant yourself a complimentary entitlement so the book appears in your library.

Full detail on each of these steps, including the failure taxonomy and lease sizing for a large
book, is in `docs/runbooks/epub-processing.md`.

## A processor-rejection note

An EPUB containing **any** `image/svg+xml` manifest item is rejected **whole** by
`lib/epub/process.ts`'s media-type allowlist — not degraded per resource, the entire upload fails.
SVG cover wrappers are common in real-world EPUBs, so this is a live risk to this matrix: a book
that fails this way has failed for a **processor** reason, not an engine reason. Record it as such.
It does not count against Readium, and it must not, by itself, trigger ADR-005's epub.js fallback —
see ADR-005's "Known supported-profile exclusions" for why the exclusion is correct and what
reopens it (widespread SVG cover wrappers reopen the *processing profile*, not the engine choice).
Inline `<style>` blocks are stripped for the same reason and are worth flagging on the same pass: a
book relying on them renders unstyled, which is a processor property too.

## The matrix

One row per (EPUB × browser). Five EPUBs times five browsers is 25 rows; leave a row blank rather
than guessing if a browser or physical device genuinely cannot be reached.

| EPUB | Browser | Has SVG? | Render fidelity | Embedded fonts | Images | Long-chapter performance | Internal links | TOC navigation | Selection | Decoration | Search-locator navigation | One/two-page spread | Annotation restore | Typography change (real content) | Width change (real content) | Reload restore | Sample boundary | Time to first page |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Browsers: desktop Chrome, Safari, Firefox, mobile Chrome, mobile Safari.

## How to judge each column

One line each, so two people filming the same book fill in the same verdict:

- **Has SVG?** Yes/No, from Step 1 of setup. Not a pass/fail column — context for every other one.
- **Render fidelity.** Does it look like the source book — text present, no visibly broken layout,
  no missing chapter? Pass/fail plus a one-line note on what looked wrong.
- **Embedded fonts.** Open the browser's font inspector (or just eyeball it against the EPUB's
  declared typefaces) on a page that uses one. Pass if the embedded face renders; fail if it falls
  back to a system font.
- **Images.** Every image in a chapter you visit loads and is not stretched, cropped, or replaced
  by a broken-image icon.
- **Long-chapter performance.** Page or scroll through the corpus's longest chapter. Pass if there
  is no visible stall or dropped frame; note the chapter length if you fail it, since "long" is
  relative to the fixture.
- **Internal links.** Follow one in-book cross-reference and one footnote if the book has one. Pass
  if it lands on the referenced content; note whether it stayed inside the reader frame (it should
  — see ADR-005 on link handling) or navigated away.
- **TOC navigation.** Open the contents drawer and jump to a chapter that is not adjacent to your
  current position. Pass if it lands there; also confirm next/previous disable themselves correctly
  at the boundary you land next to.
- **Selection.** Select text near the start, middle, and end of a paragraph. Pass if the selection
  toolbar opens beside the intended passage and its quoted text exactly matches the visible text.
- **Decoration.** Save yellow, green, and rose highlights. Pass if each decoration appears on the
  correct range without moving or obscuring the publisher's content.
- **Search-locator navigation.** Search for a phrase with a repeated occurrence, open a later
  result, and confirm the visible surrounding passage is the selected result rather than merely the
  right chapter or a similar numeric progression.
- **One/two-page spread.** At 1440px confirm two real publication columns and a center divider; at
  768px and 390px confirm one column and a drawer. Resize across 1280px and verify the visible
  passage survives both transitions.
- **Annotation restore.** Reload after saving a highlight, note, and named bookmark. Pass if all
  three return and each opens the same visible passage; record unresolved locations as failures,
  not as deleted annotations.
- **Typography change (real content).** Change font family, size, and theme in turn; after each,
  confirm you are still on the same content (not just the same numeric position) and that the page
  still renders correctly under the new setting. This is a locator-restore check as much as a
  cosmetic one.
- **Width change (real content).** Same check, but change the reading-column width instead.
  Resizing the column resizes the engine's host element, and Readium re-paginates against it — this
  is position-affecting in exactly the way a font-size change is, and it is not covered by any
  automated test because `ReaderPreferences.width` is deliberately outside the `ReaderEngine`
  boundary (see ADR-005). Confirm position survives the resize the same way it must survive a
  typography change.
- **Reload restore.** Read a few pages in, reload the tab, and confirm you land on the same page,
  not the top of the chapter or the top of the book.
- **Sample boundary.** For a book with a sample, confirm the sample reader stops at the allowlisted
  boundary and offers Get/Buy/Read rather than silently rendering further content.
- **Time to first page.** Rough seconds from opening the book (from the library or the sample link)
  to a fully rendered first page. A number, not a pass/fail — flag anything that feels like a stall
  rather than a load.

Console errors are not a column of their own: note any in the free-text margin of whichever column
they showed up under, since a console error is evidence for a specific failure, not a separate one.

## What to do with the result

- **All rows pass.** S6 moves ADR-005 from Provisional to Accepted; issue #1's exit criteria close.
- **A blocking WebKit or Firefox defect, or repeated render failures across the corpus.** ADR-005's
  "What would reopen this decision" applies, and the epub.js fallback is considered — but only after
  ruling out a processor-reason failure (see the SVG note above), which does not count against the
  engine.
- **Either way**, link the filled-in table from `docs/launch/go-no-go.md` so the launch decision does
  not have to go hunting for it. If that file does not exist yet when you run this, create the link
  when it does rather than skipping it.

Do not paste EPUB content, chapter text, or screenshots of paid content into this file, an issue, or
a commit. Record outcomes, codes, and timings only — the same rule `golden-path-validation.md`
follows.
