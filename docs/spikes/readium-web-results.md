# Readium Web feasibility spike — results

Date: 2026-09-12. Engine under test: Readium Web ("ts-toolkit").

This document is the evidence log behind [ADR-005](../adr/ADR-005-reader-engine.md). It is
deliberately explicit about the boundary between what was measured and what was not, because the
decision it supports is only as good as that boundary.

## Status: partial. The corpus matrix has not been run.

The spike splits in two, and only one half is recorded here.

| Half | Owner | State |
| --- | --- | --- |
| Adapter, bundle isolation, automated checks (plan Steps 1-4, 8) | agent | Done, recorded below |
| Five-EPUB × four-browser manual matrix and the decision gate (plan Steps 5-6) | repository owner | **Not run** |

Two reasons the second half could not be executed in this environment, both structural rather than
a matter of effort:

1. **The corpus does not exist here.** `fixtures/epub/private/` is empty and there are zero `.epub`
   files anywhere in the tree — only `README.md` and `manifest.example.json`. The five books are
   supplied by the owner and are copyrighted material that must never be committed.
2. **The browsers do not exist here.** The Playwright cache holds only `ffmpeg`; there is no
   Chromium, Firefox, or WebKit binary, and downloads are blocked on this machine.

Two shortcuts were available and were **not** taken, because either would have made ADR-005
actively misleading rather than merely incomplete:

- No public-domain or generated EPUB was substituted for the private corpus and reported as the
  corpus matrix. A synthetic EPUB demonstrates that the adapter mounts; it says nothing about the
  real books this decision is for.
- No WebKit or Firefox result was inferred, extrapolated, or filled in from Readium's own
  documentation. "Readium supports WebKit" is not a test result.

## Versions tested

| Package | Version | How the set was chosen |
| --- | --- | --- |
| `@readium/shared` | 2.5.0 | current `latest` |
| `@readium/navigator` | 2.10.0 | current `latest` |
| `@readium/navigator-html-injectables` | 2.8.0 | current `latest` |
| `@readium/decorator` | 1.2.0 | transitive, exact pin |
| `@readium/helpers` | 1.1.0 | transitive, exact pin |

Mutual compatibility is not an assumption: `@readium/navigator@2.10.0` declares **exact**
(non-caret) dependencies on `@readium/shared@2.5.0` and
`@readium/navigator-html-injectables@2.8.0`, so the installed trio is precisely the set the
navigator itself pins. Confirmed two ways — the published `latest` tags and the navigator's own
dependency ranges. `npm ls` shows the tree fully deduped with no unmet peers.

## Automated evidence obtained

| Check | Result |
| --- | --- |
| Adapter lifecycle tests (`lib/reader/readium-engine.test.ts`) | 20 passed |
| Full unit suite | 45 files, 572 passed (552 before this task, +20 new) |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | succeeded |

### Bundle isolation, verified from build output

The requirement is that catalog and public bundles do not pull Readium in.

**Method** (corrected in fix round 1): every emitted chunk was scanned for Readium content and
every lazy edge in `react-loadable-manifest.json` enumerated. The first version of this section
checked only the two chunks it expected and reported "exactly two", which undercounted by an order
of magnitude — the conclusion held, the arithmetic did not.

| Measure | Value |
| --- | --- |
| Lazy edges in the whole application | 26 — **all of them Readium's** |
| ...that emit a chunk | 15 (the other 11 are `@readium/shared` accessibility-locale imports emitting nothing) |
| Chunks in Readium's lazy subtree | 17, 501,080 bytes (~489K) |
| ...whose content is Readium code/CSS | 15 (~456K) |
| ...that are the reader client + adapter modules | 2 (34K, no Readium code of their own) |
| ...that are ReadiumCSS script-mode variants | 13 (~146K) |
| Realistic first-open cost, Latin-script book | ~381K (one CSS variant set only) |

The three lazy levels:

```
1. reader-mount.tsx -> reader-client            3602 (26K), 6149 (52K), 6693 (8K)
2. readium-engine.ts -> @readium/navigator      6108 (257K)
3. epubInjectables.js -> ReadiumCSS × 13        2880, 8035, 2083, 756, 994, 8857, 3457,
                                                9584, 4211, 9091, 9915, 3354, 4864  (~146K)
```

Level 3 is Readium loading its own stylesheets at runtime from inside the navigator chunk — only
the variant matching the publication's script mode (`default`, `cjk-horizontal`, `cjk-vertical`,
`rtl`, plus an optional EBPAJ patch) is actually fetched.

Verified negatives, each with a control query proving the lookup works:

- No Readium chunk in `.next/build-manifest.json` or its four `rootMainFiles`. Control: a known
  initial chunk (`3794-08a06c115a7464d8`) *is* found in that file by the same method.
- None of the 22 `page_client-reference-manifest.js` files names a Readium chunk — including the
  reader route itself. Control: 15 of those manifests do reference static chunks.
- Nothing Readium-derived on the server. The one `.next/server/**` file matching `readium`
  (`chunks/902.js`) is our own compiled `lib/reader/session.ts`, matching only on the
  `https://readium.org/webpub-manifest/context.jsonld` constant — zero `@readium` code, zero
  `EpubNavigator`, zero `--RS__`.

Both application-level boundaries matter, and the second as much as the first:

1. `reader-mount.tsx` loads the reader Client Component with `next/dynamic` and `ssr: false`, so
   no other route carries it. `ssr: false` is rejected inside a Server Component in Next 16, which
   is why that one-line wrapper component exists at all.
2. `readium-engine.ts` reaches `@readium/navigator` only through a dynamic `import()`, so the
   largest package (257K) is not even in the reader page's initial JavaScript — it is fetched when
   a book is actually opened. Everything else the adapter needs from that package is a type-only
   import, which TypeScript erases.

## Integration findings

Four things that would ordinarily block a Readium Web integration, checked in the installed
packages rather than assumed:

- **Readium CSS needs no hosting.** `createReadiumEpubRules` inlines the Readium CSS variants with
  `?raw` imports and injects them as `Blob`s. The published `dist` contains no `?raw` specifiers,
  no bare `@readium/css` import, and no `path-browserify` import — all pre-bundled. There is no CDN
  dependency and no static-asset route to stand up, which also keeps the reader CSP-friendly.
- **No origin allowlist gets in the way** — but not for the reason first recorded here. `Injector`'s
  `allowedDomains` governs *injectables*, not manifest fetches, which is why the manifest's
  `/api/...` hrefs were never filtered. An empty list is **not** an inactive filter: `isValidUrl`
  rejects every `http(s)` URL, and Readium's own injectables pass only because they are `blob:`.
  The same empty list is fed into the substituted frame CSP's domain list, where it did matter.
  Corrected during the final fix wave.
- **Root-relative hrefs survive `Link.toURL()`** — true, and it was the defect rather than the
  reassurance. `toURL()` strips a leading `/`, resolves against `file:///` when there is no base,
  then strips the scheme back off, so `/api/reader/publications/{id}/...` round-trips unchanged.
  With no `self` link there is no `baseURL`, so the `<base href>` Readium injects into each frame
  stays root-relative — and a `blob:` URL has an opaque path, against which such a base cannot be
  resolved. The frame could then resolve no stylesheet, image or font at all, and issued no request
  for any of them. The adapter now supplies a `self` link at the origin root; see
  `withOriginBaseURL` in `lib/reader/readium-engine.ts`.
- **No position-list request is made.** `load()` calls `positionsFromManifest()`, which looks for a
  link with media type `application/vnd.readium.position-list+json`. The entitled manifest carries
  no such link — the served manifest has no `links` array at all, and the one the adapter adds is a
  `self` link — so this resolves to `[]` without issuing a request. (The adapter supplies the
  position list itself; an empty one crashes `EpubNavigator.load()`.)

The reader session is an httpOnly cookie scoped to `/api`, so every manifest and resource fetch must
carry credentials. The adapter passes an explicit same-origin fetch implementation into
`HttpFetcher` rather than relying on the default, which additionally avoids Readium's
`window.fetch.bind(window)` default.

## Where `ReaderEngine` and Readium do not line up

Recorded rather than resolved. The interface was **not** widened, per the spike's own terms — these
are the spike's actual output.

1. **Navigation has no success channel.** — **Closed by Task 10; recorded here as the spike found
   it.** Readium reports completion through a callback carrying `ok: boolean`, and exposes
   `canGoForward` / `canGoBackward`. `ReaderEngine.next()` and `previous()` returned
   `Promise<void>`, so "moved" and "refused, already at the last page" were indistinguishable to a
   caller, and a page-turn button could not disable itself at a book boundary. Task 10, which
   builds that button, widened the boundary to `ReaderNavigationResult`
   (`{ moved, canGoForward, canGoBackward }`) and added `getNavigationState()` for the
   before-first-move case. See ADR-005 for the reasoning and for why the shape stays satisfiable
   by epub.js.
2. **`ReaderLocator` carries no media type.** Readium's `Locator` requires `type`. The adapter
   recovers it from the publication's own reading order via `linkWithHref`, falling back to
   `application/xhtml+xml`. This works, but it means a `goTo()` for an href absent from the
   manifest silently gets a guessed media type.
3. **`locations` is a flat map, Readium's is structured.** Readium models `position` and
   `fragments` as named fields and everything else as `otherLocations`. The adapter translates in
   both directions using the reserved keys `position` and `fragment`; a locator carrying an
   `otherLocations` value that is neither a string nor a number is dropped rather than serialized.

None of the three is a reason to reject Readium, and none is fixed by switching to epub.js — items
1 and 2 are properties of the shared interface, which any engine would meet.

## Environment finding worth carrying

The branch originally used `pool: "vmThreads"`. That pool both exposed a Readium import recursion
and, on the CI-pinned Node 22 runtime, caused `sanitize-html` to load `htmlparser2` as an
untransformed ES module. Inlining dependencies did not fix the CommonJS-to-ESM boundary under
`vmThreads`. The final configuration uses Vitest's default pool, keeps per-file isolation, and has
passed the GitHub Linux `web` job on Node 22. Re-run that job after any future pool change; a newer
local Node release can hide this compatibility failure.

## Before interpreting any corpus failure

Three known properties of the *processor* can make a book fail for reasons that have nothing to do
with the reader engine. Recording them here so the owner's matrix does not misattribute a failure.

- **An EPUB containing any `image/svg+xml` manifest item is rejected whole.** SVG is not in the
  default media-type allowlist, and `buildResource` throws `UNSUPPORTED_MEDIA` on the first
  non-allowlisted item rather than degrading per resource. SVG cover wrappers are common in real
  EPUBs. Record SVG presence per fixture *before* interpreting any failure.
- **Inline `<style>` blocks are stripped**, so a book relying on them renders unstyled. External
  `<link rel="stylesheet">` is unaffected but is scanned, and the scan fails closed.
- **The processor's XML round-trip check is more lenient than a real XHTML parser.** It uses
  `fast-xml-parser`; a named-entity corruption bug once passed straight through it. Content that
  survives processing can still parse differently in the engine. The XML prolog is also dropped
  from sanitized output (harmless — output is UTF-8, which is the default — but worth knowing when
  diagnosing a parse difference).

## The matrix, for the owner to complete

Per fixture in `fixtures/epub/manifest.local.json`, across desktop Chrome, mobile Chrome,
Safari/WebKit, and Firefox. **Every cell below is unmeasured.**

| Fixture | Browser | Render fidelity | Embedded fonts | Images | Long chapters | Internal links | TOC | Next/prev | Typography change | Reload restore | Sample boundary | Console errors | Init time | Has SVG? | Inline `<style>`? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| book-01 | | | | | | | | | | | | | | | |
| book-02 | | | | | | | | | | | | | | | |
| book-03 | | | | | | | | | | | | | | | |
| book-04 | | | | | | | | | | | | | | | |
| book-05 | | | | | | | | | | | | | | | |

Acceptance gate (plan Step 6): all five supported EPUBs render, locator restore is stable across a
typography change, protected/sample boundaries hold, and no critical browser failure remains. If
any criterion fails, record the exact failure and a minimal reproduction here, then evaluate
`epubjs` against this same `ReaderEngine` interface — without modifying the interface to expose
engine-specific types.
