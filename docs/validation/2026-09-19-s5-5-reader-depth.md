# S5.5 reader depth validation — 2026-09-19

## Scope and environment

Validated the generated, sanitized reader-depth fixture and the complete ebook golden path on the
owned scratch Supabase stack only: API `57321`, database `57322`, and Mailpit `57324`. Browser runs
used the Node 22 package wrapper (v22.23.2), Playwright 1.63.0, and one worker. No cloud project,
private EPUB, customer data, or backend interception was used.

## Automated evidence

- Focused reader/API/worker tests: 7 files / 161 tests passed before the final cross-browser
  regressions; the reader-session and reader-controller regressions then passed 2 files / 64 tests.
- Database: reset completed; pgTAP passed 28 files / 844 tests.
- Production check: lint, typecheck, 1,713 unit tests passed (one skipped), and the production build
  passed.
- Full Chromium application suite: 75/75 passed after the scratch storage service finished its
  reset restart. The immediately preceding run was invalidated by that restart and is not counted.
- Functional matrix: `ebook-golden-path.spec.ts` plus `reader-depth.spec.ts` passed 30/30 across
  Chromium, Firefox, and WebKit.
- The controller independently reviewed the current 13 PNGs and accepted footer controls,
  completion copy, shell, selection, editor, and search geometry.
- Review closure reran `reader-depth.spec.ts` in Chromium: 9/9 passed. It now correlates privacy
  assertions to the matching long database chunk; reopens the renamed later-occurrence bookmark;
  checks subsequently saved progress for marker leakage; proves live highlight decoration across
  reload/reflow/theme/typography changes and restoration; checks backend deletion; and verifies
  authenticated missing/invalid-cookie private 404s.
- Fix round 3 ran update and no-update 13/13 through CI's exact Playwright 1.63.0 Ubuntu Noble amd64
  digest. The amd64 update produced hashes byte-identical to all 13 controller-inspected PNGs. The
  sole contract asserts x86_64, Chromium 153.0.8010.12, Node 22.23.2, and image fonts.
- Focused production regressions passed 5 files / 76 tests. Workflow YAML parsed successfully;
  the browser matrix exports Mailpit and database URLs before Playwright config evaluation.
- `git diff --check`: run as the final repository gate and recorded in the Task 11 report.

The journeys cover highlight/note lifecycle, exact later duplicate-occurrence bookmark reopening,
accented and unaccented Vietnamese search, bounded quote/share/clipboard fallback, disabled Ask
network silence, sample isolation, missing/foreign session denial, expiration recovery,
revocation/restoration, superseded publication denial, null-position compatibility, keyboard/focus,
English/Vietnamese presentation, reduced motion, axe, completion links, and responsive themes.
The axe gate now fails every reported WCAG A/AA violation, including moderate-impact findings.
The sandboxed publication exposes no app-controlled keyboard-addressable selection surface: the
browser test proves it contains no text input, editable element, or tabbable non-interactive text
container. Chromium F7 probing did not yield a stable, inspectable caret and interfered with the
later Readium selection callback, so native browser/assistive-technology caret selection remains an
explicit physical-browser manual gap. Outer-shell keyboard behavior, the selection toolbar,
dismissal focus, and visible focus in light, paper, and dark remain enforced.

Fix round 2 also proves the renamed-bookmark activation caused the inspected progress write: it
captures `client_sequence`, `updated_at`, and the locator before activation, waits for a greater
sequence, verifies a later timestamp, and compares the resulting href/text offset/quote to the
saved bookmark before checking marker absence. Supabase CLI 2.106's `INBUCKET_URL` now supplies
`E2E_MAILPIT_URL` in CI. Ordinary discovery lists 62 tests in 18 files with zero visual cases;
the pinned script lists exactly 13 visual tests in one file.

## Visual fixes accepted

- Dark Previous/Next controls use the shell's semantic current color and retain a visible focus
  ring at 390, 768, and 1440 widths.
- Dark completion and sidebar secondary copy use inherited theme foreground with bounded opacity;
  dark hover/focus states use the existing ivory/current-color tokens.

## Final whole-branch review closure — 2026-09-21

This round supersedes the earlier test counts above. Exact navigation now preserves href, selector,
offset, and quote/context together. A new compatible migration centers search locators on the
matched text rather than the 1024-character chunk start, including normalized/original Unicode
offset conversion. Raw quote text is separate from normalized annotation text; over-1000-character
selections retain Copy/Share and show localized recoverable annotation feedback. Terminal access
loss clears private reader surfaces and gates further work. Optimistic highlights decorate by
stable client key, activation opens the specific note, rapid page turns are refused before queuing,
and publication changes start independent annotation loads.

The added real-browser cases cover cross-paragraph/over-limit selection, signout teardown, a target
selector different from the visible page-start selector, and computed dark hover contrast for the
header, compact menu, search results, and settings. The search journey now navigates a match at
offset 920 within an existing 1024-character chunk at 390px, while asserting bounded private text.
Actual hover regression reproduced 1.09:1 contrast before the current-color fix; the gate requires
at least 4.5:1. Copy preserves both truncation and success announcements. The S6 runbook explicitly
requires pausing old workers before retiring their completion RPC signature.

- Owned scratch database reset and pgTAP: 28 files / 847 tests passed.
- `npm run check`: lint, typecheck, 153 unit-test files / 1723 tests passed (one file/test skipped),
  and production build passed, using Node 22.23.2.
- Focused real Chromium reader-depth: 13/13 passed.
- `npm run check:full`: all check gates and 66/66 ordinary Chromium application tests passed
  (18 spec files, no skipped browser cases); the separate visual suite is excluded from discovery.
- Functional matrix: golden path plus 13 reader-depth journeys passed in Chromium, Firefox, and
  WebKit, 42/42 total, with no skipped cases.
- Pinned Ubuntu Noble amd64 Chromium: 13/13 passed without update mode, through OrbStack/Rosetta
  on this ARM host. The initial Docker Desktop/QEMU attempt crashed before rendering (the known
  runbook limitation); it is not counted as pixel evidence. All 13 canonical PNGs are unchanged.
- `git diff --check` passed. No snapshots, private fixtures, keys, or customer data were added.

Remaining design Minor: sidebar book/author/progress presentation is below the approved design.
The manual and owner gates below remain open; these changes do not constitute launch approval.

The second final-fix round closes the optimistic-note Save interaction found in re-review. Typed
notes merge into the stable client draft, survive reopening while create is pending/failed, and
reach the server after create/retry. A failed post-create update retains the note and retries PATCH
without creating a duplicate. Five new regressions include the real controller/editor with another
annotation present. Focused hook/controller/editor tests passed 84/84; `npm run check` passed lint,
typecheck, 1728 unit tests (one skipped), and production build. `git diff --check` passed. This
hook-only round did not rerun browser, database, or visual gates; their evidence above is round 1.

## Limitations and outstanding owner gates

- `fixtures/epub/private/` contains no EPUB files, so the five-by-five private corpus matrix remains
  entirely unmeasured. Do not move ADR-005 from Provisional on generated fixtures.
- No physical Safari, mobile Safari, or mobile Chrome run was available. Desktop Playwright WebKit
  is not a substitute.
- WebKit's local blob frame omits cookies from linked EPUB stylesheet requests, while Readium's CSP
  upgrades insecure asset URLs. Its functional reader journeys pass, but linked publisher CSS,
  images, and embedded-font fidelity are not claimed. Chromium and Firefox passed the computed
  publisher-stylesheet assertion; WebKit needs an owner-run HTTPS/private-corpus follow-up and may
  require a credential-safe resource-delivery design.
- S6 cutover, production backfill, deployment, and launch approval were not performed.

## Rollout and rollback

Use `docs/runbooks/reader-depth.md`: schema → worker → application → operator backfill. The backfill
is the idempotent local `index-search` command. Roll back only application/worker code to compatible
versions; preserve annotation/index/position rows and the additive schema. Never use a destructive
down-migration to recover an application rollout.
