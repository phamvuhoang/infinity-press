# ADR-005: Reader engine

- **Status: Provisional.** Accepted for continued implementation; **not** finally confirmed. The
  evidence behind it is automated only. See "What this decision does not rest on" below.
- Date: 2026-09-12
- Supersedes: nothing. Superseded by: nothing.
- Evidence log: [`docs/spikes/readium-web-results.md`](../spikes/readium-web-results.md)

> On the number: this is the first ADR committed to this repository — there is no ADR-001..004. The
> identifier is inherited from the design spec, which names ADR-005 for the reader-engine decision
> in three places. Renumbering would desynchronise the spec and the tracking issues, so the gap is
> deliberate.

## Context

The MVP needs an in-browser EPUB reading experience. The design spec names Readium Web as the
preferred engine subject to a feasibility spike, with `epubjs` as the fallback, and requires the
integration to sit behind a `ReaderEngine` boundary covering publication loading, TOC and chapter
navigation, stable locator serialization and restoration, progress calculation, typography and
theme controls, and sample-resource enforcement.

The boundary already existed before this spike: `ReaderEngine` in `lib/reader/engine.ts` and
`ReaderLocator` / `ReaderPreferences` in `lib/reader/types.ts`. A hard constraint on this work was
that no engine-specific type may appear in either file — the point of the boundary is that a second
engine can be dropped in behind it.

Content is delivered through authenticated Route Handlers: the manifest at
`/api/reader/publications/{publicationId}/manifest` and resources beneath it, authorized per
request against a short-lived reader session carried in an httpOnly cookie scoped to `/api`. No
storage key or Supabase object URL ever reaches the client. Any engine has to work against that
delivery model rather than against a packaged `.epub` file.

## Decision

**Use Readium Web** (`@readium/*`, the "ts-toolkit" line), adapted behind `ReaderEngine` in
`lib/reader/readium-engine.ts`.

### Tested versions

| Package | Version |
| --- | --- |
| `@readium/shared` | 2.5.0 |
| `@readium/navigator` | 2.10.0 |
| `@readium/navigator-html-injectables` | 2.8.0 |
| `@readium/decorator` | 1.2.0 (transitive, exact pin) |
| `@readium/helpers` | 1.1.0 (transitive, exact pin) |

`@readium/navigator@2.10.0` pins its siblings at exact, non-caret versions, so this trio is the set
the navigator itself requires rather than a combination chosen by us.

### Why Readium survived the automated half

Four integration risks that commonly sink a Readium Web adoption were checked in the installed
packages and none of them applies here:

- Readium CSS is inlined as `Blob`s in the published build — no CDN, no static-asset route, no CSP
  exception.
- `Injector`'s `allowedDomains` governs *injectables*, not manifest fetches, so it never blocked the
  manifest's `/api/...` hrefs. **An empty list is not an inactive filter** — it makes
  `isValidUrl` reject every `http(s)` URL, and Readium's own injectables pass only because they are
  `blob:`. The same empty list is also fed into the substituted CSP's domain list, where it *did*
  matter. The original bullet recorded "no CSP exception needed" from the mechanism that created the
  CSP problem; corrected during the final fix wave.
- `Link.toURL()` round-trips root-relative hrefs unchanged — true, and it was **the bug, not the
  reassurance**. With no `self` link there is no `baseURL`, so the `<base href>` Readium injects into
  each frame stays root-relative; a `blob:` URL has an opaque path, so that base cannot be resolved
  and every relative reference in the publication (stylesheets, images, fonts) silently fails to
  resolve. The adapter now supplies a `self` link at the origin root. See
  `lib/reader/readium-engine.ts`'s `withOriginBaseURL`, which records the full mechanism and why the
  origin root is the only href form that works.
- `positionsFromManifest()` degrades to `[]` without a request when no position-list link exists.

### What is actually enforced on the reader path

Recorded because three route comments and two bullets above previously described a defence-in-depth
layer that does not exist, and that is precisely the reasoning a future change would use to relax the
one control that is real.

- **The resource route's `Content-Security-Policy` header is inert on the reader path.** Readium does
  not navigate an iframe at the route; it *fetches* each resource and re-hosts it as a `blob:`
  document, and `FrameBlobBuilder` substitutes **its own `<meta>` CSP**. The route header still
  governs direct navigation to the URL, and both it and the samples one are now pinned by tests, but
  it is not what the reading frame enforces.
- **Inline script executes inside the frame.** The substituted policy is
  `script-src <origin> blob: 'unsafe-inline'` — `'unsafe-inline'` is load-bearing for Readium's own
  bootstrap, not vestigial. So "no script execution" is the reverse of what holds there.
- **`frame-ancestors` is not carried over**, and would be ignored in a `<meta>` policy regardless.
- **`connect-src 'none'`** does hold: the resource cannot originate network requests of its own.
- Since the adapter supplies a `self` link at the origin root, the substituted policy names **our
  origin and nothing else** (plus `blob:`/`data:`). No third-party origin is reachable from the frame.

**The ingest-time sanitiser is therefore the only boundary that removes hostile content**
(`lib/epub/sanitize.ts`, applied in `process.ts`). That is accepted as the design rather than
tolerated as an accident: it is an allowlist, it fails closed on references, and the media-type
allowlist prevents a script or SVG resource being stored at all. **Do not relax it on the grounds
that the reader renders under a strict CSP — it does not.**

### Bundle and loading strategy

Two mechanisms create the lazy boundaries:

- `reader-mount.tsx` loads the reader Client Component via `next/dynamic` with `ssr: false`. This
  keeps Readium out of every other route and off the server render, which is required rather than
  cosmetic — `EpubNavigator` builds its frame pool against real DOM APIs at construction. The
  wrapper component exists because Next 16 rejects `ssr: false` inside a Server Component.
- `readium-engine.ts` reaches `@readium/navigator` (257K, the bulk) only through a dynamic
  `import()`, so it is absent even from the reader page's initial JavaScript. All other Readium
  references in that module are type-only and erased at compile time.

The figures below come from **enumerating every emitted chunk and every lazy edge** in a fresh
build, not from confirming the chunks we expected to find:

- **26 lazy edges — every lazy edge in the application is Readium's.** Fifteen emit a chunk; the
  other eleven are `@readium/shared` accessibility-locale imports that emit no chunk at all.
- **17 chunks, 501,080 bytes (~489K)** form Readium's lazy subtree. Fifteen (~456K) contain Readium
  code or ReadiumCSS; the remaining two (34K) are the reader Client Component and the adapter
  module, which hold no Readium code themselves and exist only to load it.
- **13 of those chunks (~146K) are ReadiumCSS variants** — `before`/`default`/`after` for each of
  `default`, `cjk-horizontal`, `cjk-vertical` and `rtl`, plus the EBPAJ font patch. The navigator
  fetches them itself at runtime, so they sit a *third* lazy level below it.

A reader does not pay ~489K to open a book: only one script-mode variant set loads. For a
Latin-script publication that is the navigator (257K), `@readium/shared` plus the reader client
(52K + 26K), the adapter (8K) and the `default` CSS trio (38K) — roughly **381K on first open**,
and nothing whatsoever before a book is opened.

Verified negatives, each paired with a control query confirming the lookup itself works:

- No Readium chunk in `build-manifest.json`, nor among its four `rootMainFiles`.
- None of the 22 per-route `page_client-reference-manifest.js` files names one — including the
  reader route, since Readium is lazy there too.
- Nothing Readium-derived on the server. The single `.next/server/**` file matching `readium` is
  our own compiled `lib/reader/session.ts`, which matches solely on the
  `https://readium.org/webpub-manifest/context.jsonld` constant: it contains no `@readium` code, no
  `EpubNavigator` and no ReadiumCSS. The `ssr: false` guarantee holds.

### Table of contents

`ReaderEngine` also carries `getTableOfContents(): Promise<ReaderTocEntry[]>` (`lib/reader/engine.ts`),
added for the contents drawer. Justified as a **shared** abstraction rather than a Readium shape
wearing a different name: Readium exposes `publication.toc` (a `Links` tree whose items carry
`title`, `href`, and `children`), and epub.js — the deferred fallback — exposes `book.navigation.toc`
with the same three fields. `toReaderTocEntries` in `readium-engine.ts` maps the former onto
`ReaderTocEntry`; an untitled link is dropped rather than rendered as a blank row, since a nav entry
with no label is not something a reader can navigate by. `[]` is a legal result, not an error state —
a sample manifest's toc is filtered to the servable set and can filter down to nothing.

### Width stays outside the boundary

`ReaderPreferences` gained `width: "narrow" | "medium" | "wide"` for the reading-column control, and
it is **deliberately not part of what crosses into the engine**: column width is a property of the
container the engine renders into, not a property of the engine itself. The reader component applies
it as a `max-width` on the host element, and `toEpubPreferences` (`readium-engine.ts`) ignores the
field outright — pinned by a unit test. This is worth recording precisely because it is the kind of
preference a future contributor would "helpfully" plumb through to `IEpubPreferences`: the consequence
of *not* doing that is that changing the width still resizes the engine's host element and Readium
re-paginates against it, which is position-affecting in exactly the way a font-size change is (see
the corpus matrix's width-change row).

### Navigation surface

S5.5 registers exactly one navigator listener, `textSelected`. The adapter converts its frame-local
rectangle to parent-viewport coordinates, and keeps the full selected text separate from bounded
persisted anchors. Decoration activation uses one observer for the user-highlight group; other
groups and removed annotations never activate application UI. Destroy removes that observer,
decorations, selection listeners and transient targets, and cancels pending navigation callbacks.

Next, previous and goTo remain the navigation surface, including app-owned keyboard controls.
Readium keyboard-peripheral and swipe callbacks remain unset. Layout and typography changes are
serialized with navigation, capture a visible text anchor, merge preferences (including columnCount),
and restore the passage after repagination. Light-theme colors remain null so publisher CSS wins.

The entitled manifest's validated stable positions supply page labels from Readium's actual visible
progression boundaries. Old and sample manifests still receive fallback mount positions but expose
no digital-position labels. Neither position arithmetic nor spread width determines completion;
S4's navigation-boundary-derived whole-book progression remains authoritative.

### Locator mapping

`ReaderLocator` is the persisted shape; Readium's `Locator` is the engine's. The adapter translates
in both directions and no Readium instance crosses the boundary. `locations` is a flat
string/number map on our side and structured on Readium's, so `position` and `fragment` are
reserved keys and everything else maps to `otherLocations`.

S5.5 search/position anchors also carry a Unicode-code-point `textOffset` into the selector element's
whitespace-normalized full text. The adapter verifies quote and bounded context at that offset and
maps it back to UTF-16 DOM endpoints. Decorations receive Readium domRange values internally.
An unresolved or ambiguous annotation is skipped individually and reported to the application.

Readium 2.10's navigation path drops domRange when forwarding go_text. For exact offset navigation,
the adapter inserts a temporary empty span at the verified DOM range start, invokes the exposed
frame go_id message (which uses Readium's own LTR/RTL/CJK snapper), and removes the marker in a
finally block and on destroy. It restores split text nodes, selection ranges and decoration ranges.
Markers never modify stored XHTML or escape into application locators. A mismatched offset is
refused; it never falls back to the first identical quote. Ordinary S4 locators retain their native
navigation path. Browser passage-identity and cross-engine acceptance still require Task 11;
mocked adapter tests alone do not establish visual fidelity.

Outbound locators are rebuilt through `parseReaderLocator`, which applies the shared
`PROGRESSION_EPSILON` clamp. This is load-bearing: `reading_progress.progression` is constrained
`check (progression between 0 and 1)`, and a real engine reports a progression a hair outside that
band from floating-point rounding on the last page. Clamping in the adapter means no caller has to
re-clamp before persisting.

## What this decision does not rest on

This is the part that keeps the ADR honest, and it is why the status is provisional. See
`docs/runbooks/reader-corpus-matrix.md` for exactly how the owner runs the matrix below and judges
each column — it is the one place these rows live; this section says what is missing, not how to
fill it in.

**Not tested — no result exists, and none was inferred:**

- **Physical Safari, mobile Safari, and mobile Chrome: untested.** Playwright desktop WebKit is
  useful engine evidence, but it is not a physical Safari or touch-device result.
- **The five private EPUB fixtures: untested.** `fixtures/epub/private/` is empty; there are zero
  `.epub` files in the tree. The corpus is copyrighted material supplied by the repository owner
  and must never be committed.
- **Render fidelity, embedded fonts, images, long-chapter performance, internal links, TOC
  navigation, typography and width changes applied to real content, reload restore, sample
  boundaries, and initialization time: all unmeasured**, because each requires the corpus above.

**Automated generated-fixture evidence now exists in desktop Chromium, Firefox, and WebKit.** The
same end-to-end golden path and thirteen reader-depth journeys passed in each engine against the owned
local stack. Chromium and Firefox also proved the fixture's linked publisher stylesheet loaded and
applied. WebKit exercised reading, progress, annotations, exact anchors, search, access teardown,
themes, keyboard, and accessibility, but its blob-frame linked stylesheet request omits the auth
cookies on the local HTTP harness (and Readium's frame CSP upgrades insecure asset requests).
Publisher-CSS fidelity in WebKit therefore remains explicitly unverified; it is not promoted to a
pass by the functional result.

This does **not** discharge the corpus matrix. One generated two-chapter fixture is not five real
EPUBs, and desktop emulation is not physical mobile/Safari evidence. What is additionally verified
is that the adapter satisfies
its lifecycle contract against a mocked navigator, that the project compiles, lints, typechecks and
builds with Readium integrated, and that Readium stays out of every bundle it should.

Two shortcuts were explicitly rejected: substituting public-domain or generated EPUBs for the
private corpus and reporting the result as the corpus matrix, and inferring the WebKit and Firefox
rows from Readium's documentation.

### Whole-book progression: two defects found in a real browser, both fixed

Task 10 ran the golden-path fixture end to end through the real reader, not through a mocked
navigator, and found two defects exactly where this ADR already flagged the gap: TOC navigation and
a real book's layout.

- **Progress was quantized to chapter starts and could never reach 1.** The original derivation read
  `totalProgression` straight off the seeded position list — `index / itemCount`, one entry per
  reading-order item — which never advances by paging within a resource. A publication topped out at
  `(N - 1) / N` on its last page: a two-chapter book reported `0.5` there and could never cross
  `FINISHED_TOTAL_PROGRESSION` (0.99), so a finished book stayed "In progress" in the library
  forever.
- **Fixing that exposed a second defect: a single-column resource reports `progression: 0`.** The
  first fix derived `(index + locations.progression) / itemCount`, which advances correctly within a
  multi-column resource — but a resource that fits in a single column has no pagination range to
  normalize against, so Readium reports `0` on its only page, even when that page is the true end of
  the book with `canGoForward` already `false`. Short final items — a colophon, a dedication, a
  one-page "The End" — are the ordinary shape of a real book, so the fractional derivation alone
  would have shipped a whole class of books that could never be marked finished.
- **The fix takes the endpoint from the navigation boundary, not the fraction.**
  `deriveTotalProgression` in `lib/reader/readium-engine.ts` returns `1` whenever `canGoForward ===
  false`, independent of the final resource's length or column count, and falls back to
  `(index + within) / itemCount` everywhere else, which keeps mid-book percentages smooth.
- **And the fraction is capped one epsilon below the threshold.** `(N - 1) / N` is under `0.99` only
  while `N` is under 100; at 120 reading-order items the first page of item 120 derives `0.9917`, so
  an uncapped fraction marked a long book completed — a write `save_reading_progress` never
  downgrades — on merely landing in its final chapter. `deriveTotalProgression` therefore returns
  `Math.min(fraction, FINISHED_TOTAL_PROGRESSION - Number.EPSILON)`. That value
  (`0.9899999999999998`) still renders as 99%, so no book is visibly pinned lower, and completion
  comes from the navigation boundary and nowhere else.

**The durable lesson:** every test in `readium-engine.test.ts` mocks the navigator and supplies
`currentLocator` directly, so neither defect was reachable from that suite — it pins the adapter's
arithmetic *given* how Readium normalizes per-resource progression, not the premise itself. Only
`e2e/reader-completion.spec.ts`, run against the real engine, exercises Readium's own normalization.
A green unit-test run on this adapter is evidence the arithmetic is internally consistent, not
evidence it matches what Readium actually reports.

**An accepted consequence, not a bug.** "No next page" is the only end-of-book signal this system
has, so reaching the last page through the contents drawer marks the book finished — including a
reader who jumps straight to a short final chapter having read nothing before it.
`library_items.state` is never downgraded from `completed` once set, so that write is irreversible.
This was accepted for this release rather than fixed: the alternative — tracking which resources
were actually paged through, not merely which one is current — is a materially larger feature than
this release scope covers.

**A known, unfixed defect.** `getLocator()` can intermittently return the locator from *before* the
most recent move: a race between the navigation callback resolving and the navigator republishing
`currentLocator`. A reader who turns a page and immediately closes the tab may therefore have the
previous page's position saved instead of the one they just turned to. At the 0.99 finished
threshold this mostly costs a page of position, but a stale read on the *final* page turn of a book
costs the reader a completion instead. Not chased for this release.

**`epubjs` was not evaluated.** The plan makes it the fallback, to be assessed only if Readium
misses an exit criterion. Those criteria cannot be assessed yet, so epub.js is *deferred*, not
rejected on evidence. This ADR should not be read as having compared the two.

### The default theme silently overrode publisher CSS, found by the golden path

Task 8 wired `ReaderEngine.setPreferences` into `reader-client.tsx` so it fires on every mount —
before this, nothing in the app ever called it. `toEpubPreferences` in `lib/reader/readium-engine.ts`
unconditionally submitted concrete `textColor`/`backgroundColor` values for the `light` theme
(`#111827` on `#ffffff`). ReadiumCSS applies a submitted colour as a user override, so once the call
was live, the default theme — the one every reader who has never opened the settings panel sees —
started beating the publication's own `h1`/body colours instead of leaving them alone.

**The fix.** `light` now resolves to `{ backgroundColor: null, textColor: null }`, the same "leave
the publisher's own styling alone" convention `FONT_STACKS.publisher` already used for fonts. Only
`sepia` and `dark` are deliberate reader overrides and keep concrete colours.

As of 2026-10-04, new device preferences default to `sepia` (Paper), publisher fonts at 16px,
medium line spacing (1.75), and medium column width. Existing saved preferences remain unchanged.
The light-theme publisher-colour checks explicitly select or seed `light`; the behaviour above
describes the light theme, which was the default when the defect was found.

**The durable lesson.** No unit test caught this. `readium-engine.test.ts` asserts what
`toEpubPreferences` hands to `submitPreferences` — that the adapter's *output* matches the theme
table — which stayed internally consistent whether the table's light entry was a real colour or
`null`. Nothing in that suite renders a frame or reads computed style, so it cannot see that a
submitted colour then wins a CSS cascade against the publication's own stylesheet. Only
`e2e/ebook-golden-path.spec.ts`, which asserts `getComputedStyle` on a fixture `h1` against the real
rendered frame, could catch it — and did, failing on this branch while passing on `main`. Same shape
as the whole-book-progression defects above: a green adapter-level suite is evidence the mapping is
internally consistent, not evidence of what the browser actually renders.

## Known supported-profile exclusions

These come from the processing pipeline, not the reader engine, but they define what the reader can
ever be asked to display and belong in this record.

- **`image/svg+xml` is not in the default media-type allowlist**, and an EPUB containing any SVG
  manifest item is rejected **whole**, not degraded per resource. SVG can carry `<script>` that is
  live when the resource is served directly by href — which describes the **admin preview**, where an
  iframe navigates at the route itself. It is *not* how the reader serves resources: there they are
  fetched and re-hosted as `blob:` documents. The exclusion remains correct, and under the frame's
  substituted `script-src … 'unsafe-inline'` (below) it matters more than the original reason implied.
  SVG cover wrappers are common in real EPUBs, so this is a live risk to the pending corpus matrix:
  a book failing this way has failed for a processor reason, not an engine reason. The allowlist is
  XHTML, CSS, NCX, JPEG/PNG/GIF/WebP, and the OTF/TTF/WOFF/WOFF2 font types.
- **Inline `<style>` blocks are stripped.** `sanitize-html` offers no CSS-aware sanitization for
  block content, so the tag is excluded rather than passed through unsanitized. A book relying on
  inline `<style>` renders unstyled.
- **External stylesheets ship byte-for-byte but are scanned, and the scan fails closed.** It is a
  real CSS tokenizer rather than a regex: an `@import` or URL-bearing construct it cannot resolve
  into a reference is rejected rather than skipped, and bare-string URL functions
  (`image-set()`, `src()`, and similar) are covered as well as `url()`.
- **The processor's XML round-trip validation is more lenient than a browser's XHTML parser** (it
  uses `fast-xml-parser`), so content that survives processing can still parse differently in the
  engine. The XML prolog is dropped from sanitized output — harmless, since output is UTF-8, but
  worth knowing when diagnosing a parse difference.

## Where the boundary and the engine do not line up

Recorded, not resolved — at the time of the spike. Item 1 has since been **closed by Task 10**;
items 2 and 3 stand.

1. ~~**Navigation has no success channel.**~~ **Closed (Task 10).** Readium reports completion via
   a callback carrying `ok`, and exposes `canGoForward` / `canGoBackward`; `next()` and
   `previous()` returned `Promise<void>`, so a refusal at a book boundary was indistinguishable
   from a successful move and a page-turn control could not disable itself at the end of a book.
   Task 10 builds that control, so it widened the interface rather than working around the gap:

   ```ts
   export type ReaderNavigationState = { canGoForward: boolean; canGoBackward: boolean };
   export type ReaderNavigationResult = ReaderNavigationState & { moved: boolean };
   ```

   `goTo()`, `next()` and `previous()` now return `ReaderNavigationResult`, and a new
   `getNavigationState()` reports the same two facts without moving — needed because the control
   has to render correctly on first paint, before any navigation has happened, and "previous is
   unavailable at the opening page" is not something a default can guess for a reader restored to
   the middle of a book.

   Widened as a **shared** abstraction, not around Readium: `moved` is Readium's `ok` and epub.js's
   settled `rendition.next()`, while the two boundary flags are Readium's getters and epub.js's
   `rendition.location.atStart` / `atEnd`. Neither engine's vocabulary appears in the type, so the
   fallback engine can still satisfy it.

   Note `moved` and `canGoForward` answer different questions and both are needed: a move can
   succeed *and* land on the last page, which is precisely the state a control must render.
2. **`ReaderLocator` carries no media type** and Readium's `Locator` requires one, so it is
   recovered from the publication's reading order, falling back to `application/xhtml+xml`.
3. **A locator's `otherLocations` value that is neither string nor number is dropped** on the way
   out, because the shared `locations` map admits only those two types.

Whether any of these should change the interface is a decision for whoever needs the capability;
none of them blocks the MVP reading path.

## Consequences

- Opening a book costs roughly 381K of lazily loaded JavaScript for a Latin-script publication
  (~489K exists across Readium's 17-chunk subtree, but only one ReadiumCSS variant set loads).
  Browsing the catalog costs none of it.
- `vitest.config.ts` inlines `/@readium\//` via `server.deps.inline`. The repo's `pool: "vmThreads"`
  overflows the stack when loading these packages as externalized ESM. The workaround is scoped to
  Readium so the pool choice and every other test file are unaffected.
- Task 10 owns reading-progress restore and reader-session minting; the page passes a null initial
  locator until then, which the engine treats as "open at the beginning".

## What would reopen this decision

- The owner's five-EPUB × four-browser matrix failing any gate criterion: all five supported EPUBs
  render, locator restore is stable across a typography change, protected/sample boundaries hold,
  and no critical browser failure remains.
- A WebKit or Firefox defect that blocks reading and has no reasonable workaround.
- SVG cover wrappers proving common enough across the corpus that whole-publication rejection is
  untenable — this reopens the processing profile (SVG sanitization, or per-resource degradation
  instead of wholesale rejection) rather than the engine choice.
- Readium Web dropping the reflowable-EPUB capabilities this integration relies on, or going
  unmaintained.

Until the matrix lands, this ADR is re-confirmed rather than re-decided, and issue #1's exit
criteria stay formally open.
