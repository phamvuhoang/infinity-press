# S5.5 Reader Depth and Visual Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task-by-task. The user selected subagent-driven execution, with explicit model routing. Steps use checkbox (`- [ ]`) syntax for tracking. This document plans implementation; writing it does not start implementation or authorize deployment.

**Goal:** Ship private highlights, notes, named bookmarks, entitled in-book search, attributed short quotes, stable digital positions, and the responsive S5.5 reader before S6 launch hardening.

**Architecture:** Extend the existing sanitized EPUB pipeline and authenticated reader-session boundary, keeping all Readium types inside the adapter. Commit database and extraction contracts before their consumers, then add client state and accessible components before switching the S4 shell. Preserve publication-version identity, S4 progress/completion semantics, and sample-resource isolation.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase/Postgres with pgTAP, installed Readium packages, Vitest/Testing Library, Playwright, existing Base UI dialog primitives, and Node.js 22.

**Spec:** `docs/superpowers/specs/2026-09-19-s5-5-reader-depth-visual-parity-design.md` (binding feature design); `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md` (launch constraints and sequence); `docs/ref/InfinityBooks_PRD_Roadmap_Technical_Design_v2.md` (§§3.5, 8–9, 15, 17). Read all three with `docs/adr/ADR-005-reader-engine.md`.

## Global Constraints

- “At widths of 1280px and above, render a persistent 360–420px sidebar and a two-page reading spread with a quiet center divider.”
- “Below 1280px, render one page and move the sidebar into an accessible drawer.”
- “Copy or share at most 300 Unicode grapheme clusters from the current text selection, always followed by the book title, author, and canonical book URL.”
- “Query length after trimming is 2–100 characters.” “At most 50 results are returned.”
- “Every touch target is at least 44px.”
- “Search input debounces for 250ms and cancels superseded requests.”
- “Only sanitized XHTML is indexed.”
- “Completion remains based on S4's navigation-boundary-derived whole-book progression, not position arithmetic.”
- “The sample reader calls none of these endpoints.” This includes annotation CRUD and full-book search.
- “Note text, selected text, search query text, and quote text are excluded from analytics and logs.” Do not log full locators or extracted text either. Preserve request IDs and stable error codes.
- “Ask Infinity is presentation only and cannot send selected or publication content.”
- “Cross-device reader preference sync. S4's device-local preferences remain unchanged.”
- “A later publication version does not silently inherit old annotations; cross-version migration remains out of scope.”
- “Run `npm run check` after every task.” At every delivery gate run local database reset/tests and `npm run check:full`, following the environment procedure below.
- Customer routes remain under `/{locale}` (`vi`, `en`); `/admin` stays unprefixed. Every protected page/action retains its own authorization gate. Every entitled API request repeats reader-session authorization.
- Use new migrations and regenerate `lib/supabase/database.types.ts`. Never edit an applied migration. Raw EPUBs and derived resources remain private; sanitization remains the content security boundary.
- Do not add AI calls, embeddings, reviews, annotation export, fixed-layout support, payment providers, cross-version migration, or S6 production cutover work.
- Read the relevant installed `node_modules/next/dist/docs/` guide before changing Next.js code. Keep Readium lazy-loaded behind `ReaderEngine` and preserve the existing sample and admin-preview paths.

## Scope, baseline, and implementation decisions

This is the S5.5 plan named by the parent spec's plan sequence, not a replacement plan for S1–S6. The inspected baseline contains S5 (`286768f`, PR #21) and the approved September 19 design. Existing implementation seams are `lib/data/library.ts:getReadableBook`, `lib/reader/session.ts`, `lib/reader/readium-engine.ts`, `components/reader/reader-client.tsx`, and `lib/epub/job-store.ts:SupabaseJobStore.complete`. Recheck the branch at execution time; preserve unrelated changes, including the untracked `cmd.txt` present when this plan was written.

Specific S5.5 decisions override the older PRD's generic model: a note is a field on a highlight, completion has no review prompt, and annotation migration is excluded. The stored preference key remains `sepia`, labelled Paper in English. Do not rename persisted preferences.

The following fill gaps in the design without adding product scope. Record changes to them as controller rulings before dispatching affected work:

1. **Locator spaces:** processor/search storage uses original in-publication hrefs; client DTOs and annotations use the existing protected resource URL form. Centralize conversion and membership validation. Reject external URLs, traversal, another publication's resource URL, oversized locators, and non-reading-order resources. Do not mutate stored XHTML to create anchors.
2. **Bounds:** search chunks contain at most 1,024 Unicode code points, quote anchors at most 160 code points with 64 before/after, excerpts at most 240 code points, and serialized locators at most 16 KiB of UTF-8. These are implementation bounds, not additional quote-sharing entitlements. A long annotation selection is rejected above the spec's 1,000-character storage limit with localized feedback; copy/share can still truncate its own selection to 300 graphemes. Notes cap at 5,000 characters, bookmark labels at 1–120 characters. Use code points for database-aligned text limits; quote sharing specifically uses graphemes.
3. **Search privacy:** return only `{ chapterTitle, excerpt, locator }`; never return `plain_text`, rank, storage keys, or a locator whose `text.highlight` contains the whole chunk. Rank exact token matches before normalized token matches before trigram fallback, with ordinal as the deterministic tie-breaker. Preserve original accented text for excerpts and anchors.
4. **ID-only mutation URLs:** PATCH and DELETE use `/api/reader/annotations/{annotationId}?publicationId={uuid}`. The query supplies a candidate publication solely to select its cookie and authorize the session before any annotation lookup. Filter the row by authorized profile, publication, and annotation ID; the query never grants access. This keeps the specified path and avoids a privileged pre-authorization lookup.
5. **Database defense:** new authenticated RPCs recheck session authorization inside the same transaction as CRUD/search. Table RLS separately enforces the design's owner/entitlement/current-publication predicate. No service-role client is needed in these routes. Worker-only processing/backfill RPCs remain service-role-only.
6. **Positions:** the entitled manifest adds `infinityBooks: { positions: ReaderLocator[] | null }`, with hrefs projected into protected URLs. The sample manifest never includes this full-book extension. Adapter fallback positions can still support mounting old books, but `getPositionInfo()` returns null without a validated extension; hide page labels, retain progress.
7. **Sidebar discoverability:** retain exactly Contents, Bookmarks, Notes tabs. Bookmarks includes a labelled Highlights section so highlights without notes can be reopened/deleted, and completion can open that section. Notes is the subset of highlights with non-null notes. Show distinct bookmark/highlight counts without double-counting note rows.
8. **Layout control:** desktop defaults to two pages and may choose one page for the current mount; below 1280px always use one page. A responsive resize restores the current locator and the desktop choice when wide again. This is not a new synced preference. Both sides of a spread report the digital positions actually visible; never fabricate `end = current + 1` when typography exposes a different range.
9. **Visual evidence:** the three requested documents provide measurable layout requirements but no linked pixel reference artifact was found in the inspected docs. Build to their explicit geometry and existing site design tokens. New screenshots establish regression baselines, not proof of matching an unavailable external mockup. Record that distinction in the evidence file.

## Execution and model routing

Use a fresh implementer per task with `fork_turns: "none"`, an explicit `model`, and an explicit `reasoning_effort`. The model names below are in this session's spawn allowlist; check the executing session's allowlist before dispatch. If a preset is unavailable, select the closest available tier and record the substitution. These are task-routing choices, not pricing or benchmark claims.

| Task | Implementer / effort | Task reviewer / effort | Reason |
| --- | --- | --- | --- |
| 1. Database and authorization | `gpt-5.6-terra` / high | `gpt-6-astra` / high | SQL/RLS, transactional authorization and text exposure |
| 2. Sanitized text extraction | `gpt-5.6-terra` / high | `gpt-5.6-sol` / high | Stable DOM anchors, Unicode and deterministic ordering |
| 3. Processing and backfill | `gpt-5.6-terra` / high | `gpt-5.6-sol` / high | Atomic writes, lease preservation, immutable versions |
| 4. Reader API and projection | `gpt-5.6-terra` / high | `gpt-6-astra` / high | Cross-user denial and per-request session boundaries |
| 5. Readium adapter | `gpt-6-astra` / high | `gpt-6-astra` / high | Cross-frame selection/decorations and navigation races |
| 6. Quote utility | `gpt-5.6-luna` / medium | `gpt-5.6-sol` / medium | Complete small implementation supplied below |
| 7. Annotation state and editors | `gpt-5.6-terra` / high | `gpt-5.6-sol` / high | Optimistic mutations, retry, activation and teardown |
| 8. Search and shared session retry | `gpt-5.6-terra` / high | `gpt-5.6-sol` / high | Cancellation, race handling and lost access |
| 9. Reader page presentation data | `gpt-5.6-terra` / medium | `gpt-5.6-sol` / medium | Existing catalog and locale integration |
| 10. Responsive shell and completion | `gpt-5.6-terra` / high | `gpt-5.6-sol` / high | Multi-component accessibility and responsive layout |
| 11. Acceptance and operational evidence | `gpt-5.6-terra` / high | `gpt-5.6-sol` / high | Real browser/database integration and CI |
| Final whole-branch review | — | `gpt-6-astra` / high | Cross-task security, correctness and spec coverage |

Do not dispatch implementation workers concurrently: several tasks share the client, dictionaries, generated types, and local database. Subagent-driven does not mean parallel writers. Workers must not spawn helpers or their own reviewers. The controller owns dispatch and review.

At execution start use `using-git-worktrees` to create or verify an isolated implementation branch; use the SDD skill's `scripts/sdd-workspace PLAN_FILE` to establish its private ledger. Before Task 1, write the skill's preflight table covering every task and every shared file/interface pair. Keep the complete task brief, global constraints, relevant spec sections, dependencies, permitted paths, report path, and acceptance commands in each dispatch. Use `scripts/task-brief` and `scripts/review-package`; record BASE before implementation, not `HEAD~1` afterward.

Every task gets one independent task reviewer reporting both spec compliance and code quality. The controller resolves unverifiable cross-task claims. Fix rounds 1–3 resume the same implementer; rounds 4–5 use a fresh implementer one tier higher (or the strongest available with increased effort if already at the top). Review only the fix range on re-review. Record decisions and residual findings per SDD; never call unmet security or acceptance criteria passed. A final whole-branch review uses the strongest available model once, with one consolidated fix dispatch and scoped re-review if needed. Do not repeatedly run the full suite for an unchanged reviewed commit.

## Delivery gates and validation environment

| Gate from design §5 | Tasks | Exit evidence |
| --- | --- | --- |
| 1. Schema/RLS | 1 | Constraint, cross-user, revocation, ranking and RPC pgTAP |
| 2. Extraction/backfill | 2–3 | Determinism, atomic rollback and unchanged resource hashes |
| 3. Engine contract | 4–5 | Manifest projection, adapter behavior and existing reader regression |
| 4. Reader-depth flows | 6–8 | Quote limits, annotations/bookmarks/search/retry component tests |
| 5. Visual parity/completion | 9–10 | Responsive integration, translations, completion actions |
| 6. Acceptance | 11 | E2E, visual/a11y/browser evidence and corpus status |

Run focused tests red, implement, run them green, then `npm run check` before each task commit. Run database reset/tests after each schema change. At a gate run database reset/tests and `npm run check:full`; this subsumes the task's `npm run check`, so do not immediately repeat it. Read `docs/runbooks/testing-environments.md` before any test setup, and `docs/runbooks/epub-processing.md` before CLI work.

For the default stack, only after verifying it belongs to this repository:

```bash
node --version
supabase status
npm run db:reset
npm run db:test
eval "$(supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export E2E_MAILPIT_URL="$MAILPIT_URL"
export E2E_DATABASE_URL="$DB_URL"
npm run check:full
```

If the default ports belong to another project, use the owned scratch stack and replace **every** Supabase command above with its `--workdir .superpowers/scratch/sbworkdir` equivalent. Specifically, replace the npm database scripts with `supabase db reset --workdir ...` and `supabase test db --workdir ...`; never reset the unrelated default stack. Export from that same scratch stack before builds. Do not print credentials, rely on cloud `.env.local`, silently skip tests, or reuse an unidentified server on port 3000. Only stop a server after identifying it as this task's process. Record the actual commands and stack identity in reports.

For each schema change generate types from that same local stack:

```bash
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
```

Add `--workdir .superpowers/scratch/sbworkdir` for a scratch stack. Generated-file redirection is a mechanical regeneration, not a handwritten edit. Use `apply_patch` for authored files.

## File and interface map

| Area | Files and responsibility |
| --- | --- |
| Database | New `20260919100000_reader_depth.sql`, `20260919110000_reader_search_processing.sql`; new pgTAP files; generated database types |
| Extraction | New `lib/epub/search-index.ts`; extend `types.ts`, `process.ts`; keep sanitized-resource parsing independent of IO |
| Persistence | Extend `job-store.ts`; new `lib/epub/search-backfill.ts`; CLI subcommand in `scripts/ebook.ts` |
| Reader boundary | Extend `lib/reader/types.ts`, `engine.ts`, `readium-engine.ts`; new `locator-paths.ts` |
| Server | New `lib/reader/annotations.ts` (validation/DTO types), `lib/data/reader-annotations.ts`, `lib/data/reader-search.ts`; route-local authorization via new `lib/reader/request-context.ts` |
| Client state | New `components/reader/use-reader-annotations.ts`, `lib/reader/api-client.ts`; keep engine ownership in `reader-client.tsx` |
| Client surfaces | New selection toolbar, annotation editor, saved-items panel, search panel, sidebar, completion panel, scoped CSS module |
| Presentation | Extend `lib/data/library.ts`, reader page and mount props; use existing catalog contracts and locale URL helpers |
| Evidence | New reader-depth E2E/visual specs and support; extend browser CI, corpus/runbooks and ADR |

Shared types added in Task 1's neutral TypeScript contract:

```ts
// lib/reader/annotations.ts
export type HighlightColor = "yellow" | "green" | "rose";
export type AnnotationDraft =
  | { kind: "highlight"; locator: ReaderLocator; selectedText: string;
      color: HighlightColor; noteText: string | null }
  | { kind: "bookmark"; locator: ReaderLocator; label: string };
export type AnnotationPatch =
  | { kind: "highlight"; color?: HighlightColor; noteText?: string | null }
  | { kind: "bookmark"; label: string };
export type ReaderAnnotation = AnnotationDraft & {
  id: string; publicationId: string; createdAt: string; updatedAt: string;
};
export type ReaderSearchResult = {
  chapterTitle: string | null; excerpt: string; locator: ReaderLocator;
};
```

Import `ReaderLocator` from `lib/reader/types.ts`. Never include profile IDs or storage paths in client DTOs. Add runtime parsers in Task 4; these declarations are not runtime validation.

## Task 1: Annotation schema, private search storage, and authorized RPCs

**Model:** `gpt-5.6-terra`, high. **Reviewer:** `gpt-6-astra`, high. **Dependencies:** baseline only.

**Files:** Create `supabase/migrations/20260919100000_reader_depth.sql`, `supabase/tests/reader_annotations.test.sql`, `supabase/tests/reader_search.test.sql`, `lib/reader/annotations.ts`. Modify `lib/supabase/database.types.ts`.

**Interfaces:** Produce the neutral types above and SQL contracts below. `p_payload` uses the camelCase draft/patch fields above. CRUD returns table rows, mapped to DTOs in Task 4. `p_operation` is one of `list`, `create`, `update`, `delete`; create derives identity from the session. Delete returns the deleted row so zero rows means missing/foreign.

```sql
public.reader_annotation_request(
  p_session_id uuid, p_publication_id uuid, p_operation text,
  p_annotation_id uuid default null, p_payload jsonb default null
) returns setof public.reader_annotations

public.search_reader_publication(
  p_session_id uuid, p_publication_id uuid, p_query text
) returns table (chapter_title text, excerpt text, locator_json jsonb)
```

- [ ] Add pgTAP fixtures using the existing session/entitlement test patterns: two profiles, two publications, one superseded version, active and revoked grants. Assert constraints, both annotation indexes, unique publication/ordinal and GIN search indexes. Test owner CRUD, foreign read/update/delete, attempted profile/publication movement, revoked/restored access to the same version, inactive/draft/unpublished book/publication, expired session, and browser access to raw chunks. Include anonymous RPC execution denial and authenticated RPC calls with forged session/profile combinations.
- [ ] Run `supabase test db` on the verified stack and record the missing-table/function failure. Representative schema assertion:

```sql
select has_table('public', 'reader_annotations', 'annotation storage exists');
select has_table('public', 'ebook_search_chunks', 'private chunks exist');
select has_column('public', 'ebook_publications', 'positions_json', 'rollout positions are nullable');
select ok(not has_table_privilege('authenticated', 'public.ebook_search_chunks', 'SELECT'),
          'browser role cannot select chunks');
```

- [ ] Implement every column, FK, kind-dependent nullability and length constraint in design §6.1–6.2; preserve nonempty bookmark names after trimming. Validate locator JSON shape/size at the database boundary as well as later in TypeScript. Prevent ownership/publication/kind/anchor mutation via the update path and column privileges or an immutable-fields trigger. Add server-managed timestamps. RLS must implement **all** three conditions in §6.1 for SELECT/INSERT/UPDATE/DELETE, including WITH CHECK on writes.
- [ ] Add nullable `positions_json`. Add stored normalized chunk text maintained on writes using existing `catalog_normalize`; build `simple` tsvectors and GIN indexes, including trigram on normalized text. Do not falsely declare `unaccent` immutable to create a generated-column index. No anon/authenticated SELECT grant or policy on chunks. Lock down helper/RPC execution (`revoke ... from public, anon`; grant only intended roles), use qualified names and `set search_path = ''` for definer functions. Recheck `authorize_reader_session` inside both RPCs; do not trust a passed profile ID.
- [ ] Implement validated `plainto_tsquery('simple', ...)` token search and normalized token search, then bounded trigram fallback. Cap at 50; break ties by ordinal. Return a centered excerpt no longer than 240 code points and bounded locator context. Enforce query bounds in SQL too. Test at least 55 matching chunks, accent/no-accent Vietnamese, empty/punctuation-only queries, ranking ties, and a revoked/superseded publication.
- [ ] Run local reset/tests, regenerate types, run the Gate 1 checks, and commit only task paths with message `feat: add private reader annotations and search schema`.

## Task 2: Deterministic extraction and stable positions from sanitized XHTML

**Model:** `gpt-5.6-terra`, high. **Reviewer:** `gpt-5.6-sol`, high. **Dependencies:** 1.

**Files:** Create `lib/epub/search-index.ts`, `lib/epub/search-index.test.ts`. Modify `lib/epub/types.ts`. Task 3 integrates the pure extractor into processing.

**Interfaces:** Add these neutral declarations to `lib/epub/types.ts` and import them into the extractor. No database, Next.js, browser DOM, or Readium runtime dependency.

```ts
export type ProcessedSearchChunk = {
  href: string; chapterTitle: string | null; ordinal: number;
  plainText: string; locator: ReaderLocator;
};
export type ProcessedSearchIndex = {
  searchChunks: ProcessedSearchChunk[]; positions: ReaderLocator[];
};
export function buildSearchIndex(input: {
  readingOrder: ReadingOrderItem[]; resources: ProcessedResource[]; toc: TocEntry[];
}): ProcessedSearchIndex;
```

- [ ] Add real sanitized-XHTML fixtures in the unit test: duplicate words, nested inline tags, headings, list/table/quote blocks, repeated sibling tags, accented Vietnamese, emoji, whitespace, empty resources, and a long paragraph. Verify no nested-block double counting, no CSS/script text, deepest fragment-aware TOC association, contiguous ordinals, bounded text/context, and unchanged resource bytes. Test anchors resolve back to the intended substring in the parsed original document.
- [ ] Run `npm run test:unit -- lib/epub/search-index.test.ts`, expecting missing extractor failure. Add this independent repeatability assertion to the fixture tests:

```ts
const first = buildSearchIndex(input);
expect(buildSearchIndex(input)).toEqual(first);
expect(first.searchChunks.map((row) => row.ordinal))
  .toEqual(first.searchChunks.map((_, index) => index));
expect(first.searchChunks.every((row) => Array.from(row.plainText).length <= 1024)).toBe(true);
```

- [ ] Implement a structural XHTML traversal with the installed XML parser (preserve sibling order and namespace handling). Build selectors from immutable IDs where unique, otherwise deterministic tag/`:nth-of-type` ancestry. Normalize whitespace with a text-node mapping so anchors still resolve in original XHTML. Split overlong blocks without splitting code points. Use bounded exact quote plus before/after to disambiguate repeated text in the same element; do not use selector alone.
- [ ] Emit positions near each 1,024-code-point boundary across reading order, preserving resource starts for empty/non-text chapters as needed by navigation. Use sequential one-based `locations.position`, relative original href, selector, quote and context; derive resource/whole-book fractions consistently without making positions completion authority. Verify identical positions across repeated extraction and intact resource hashes. Avoid counting an element's descendant text twice.
- [ ] Run focused tests and `npm run check`, then commit task paths as `feat: derive searchable EPUB text and stable positions`.

## Task 3: Atomic processing integration and immutable-publication backfill

**Model:** `gpt-5.6-terra`, high. **Reviewer:** `gpt-5.6-sol`, high. **Dependencies:** 1–2.

**Files:** Create `supabase/migrations/20260919110000_reader_search_processing.sql`, `supabase/tests/reader_search_processing.test.sql`, `lib/epub/search-backfill.ts`, `lib/epub/search-backfill.test.ts`. Modify `lib/epub/types.ts`, `process.ts`, `process.test.ts`, `job-store.ts`, `job-store.test.ts`, `job-store.supabase.test.ts`, `worker.test.ts`, `scripts/ebook.ts`, `lib/supabase/database.types.ts`, `docs/runbooks/epub-processing.md`.

**Interfaces:** `ProcessedPublication` gains required `searchChunks` and `positions` from `ProcessedSearchIndex`. Add `p_search_chunks jsonb, p_positions jsonb` to the completion RPC and explicitly retire the old callable overload after adapting callers. New worker-only `replace_publication_search(p_publication_id uuid, p_search_chunks jsonb, p_positions jsonb) returns void`. Backfill exports `indexPublicationSearch(publicationId: string): Promise<{ publicationId: string; chunkCount: number; positionCount: number }>`.

- [ ] Write rollback tests: an invalid final chunk leaves no publication/resource/index DB rows committed; a stale worker lease cannot replace the index; replacing publication A leaves publication B unchanged. Preserve existing version and job ownership tests. Update test fixture factories that construct `ProcessedPublication`, rather than masking missing fields with optional properties.
- [ ] Run `npm run test:unit -- lib/epub` and the database suite to observe failures. Integrate extraction after all XHTML sanitization and resource assembly:

```ts
const searchIndex = buildSearchIndex({ readingOrder, resources, toc });
// In the existing processEpub return value:
return { metadata, readingOrder, resources, toc, sampleHrefs, ...searchIndex };
// In SupabaseJobStore.complete's existing RPC arguments:
// p_search_chunks: publication.searchChunks,
// p_positions: publication.positions,
```

- [ ] Extend the current completion transaction to write resource metadata, publication, chunks and positions together. Preserve its lease, stale-version, status and sample invariants. Storage uploads remain before the SQL transaction as today; database readiness must not become visible with a partial index. Serialize chunk fields explicitly, not arbitrary object spreads into SQL payloads. Update the in-memory store to model the same all-or-nothing outcome.
- [ ] Implement `index-search --publication <uuid>`: validate UUID before IO, read the stored manifest/reading order, TOC, and already-sanitized private XHTML, call the same extractor, then one replacement transaction locked to that publication. Reject missing resources/malformed input before replacing anything. Do not call `processEpub`, source storage, publication transition RPCs, or upload any object. Restrict the new RPC to the worker credential and validate every chunk href against the publication's existing resources.
- [ ] Test the backfill twice: identical derived results, resource SHA-256 unchanged, manifest bytes/key unchanged, version and active pointer unchanged, other publication untouched. Assert stdout/stderr contain identifiers/counts/stable codes only, including failures. Add the exact command and environment verification to the processing runbook; no cloud backfill is run during implementation.
- [ ] Run reset/tests, regenerate types, Gate 2 checks, and commit as `feat: persist and backfill private reader search indexes`.

## Task 4: Session-authorized annotation/search APIs and manifest positions

**Model:** `gpt-5.6-terra`, high. **Reviewer:** `gpt-6-astra`, high. **Dependencies:** 1–3.

**Files:** Create `lib/reader/locator-paths.ts`, `locator-paths.test.ts`, `request-context.ts`, `request-context.test.ts`, `lib/data/reader-annotations.ts`, `reader-annotations.test.ts`, `lib/data/reader-search.ts`, `reader-search.test.ts`; create route and colocated `route.test.ts` in `app/api/reader/publications/[publicationId]/annotations/`, `app/api/reader/publications/[publicationId]/search/`, and `app/api/reader/annotations/[annotationId]/`. Modify `lib/reader/annotations.ts`, `session.ts`, `session.test.ts`, and entitled manifest route tests. Add `lib/reader/annotations.test.ts`.

**Interfaces:** `parseAnnotationDraft(value: unknown): AnnotationDraft`, `parseAnnotationPatch(value: unknown): AnnotationPatch`; `requireReaderRequestContext(request: NextRequest, publicationId: string): Promise<AuthorizedReaderContext & { sessionId: string }>`; `toReaderResourceHref(publicationId: string, href: string): string` and `toPublicationResourceHref(publicationId: string, href: string): string`. The request helper checks application auth (401), cookie/header, then `authorizeReaderSession` (404). DAL uses the authenticated client and Task 1 RPCs. GET collection returns `{ annotations: ReaderAnnotation[] }`; create/update return `{ annotation: ReaderAnnotation }`; delete returns 204; search returns `{ results: ReaderSearchResult[] }`.

- [ ] Read local Next.js Route Handlers and async route-params guides. Write route tests mirroring existing manifest tests: no application session → 401; missing/expired/wrong-publication/foreign/revoked/superseded reader session → identical 404; malformed authenticated payload → 400; temporary failure → generic 502 with request ID. Verify no DAL calls happen before authorization. Test all four methods, not just GET.
- [ ] Run focused route/validation tests red. Add concrete parser negatives:

```ts
expect(() => parseAnnotationDraft({ kind: "bookmark", locator, label: " " })).toThrow();
expect(() => parseAnnotationDraft({ kind: "highlight", locator,
  selectedText: "x".repeat(1001), color: "yellow", noteText: null })).toThrow();
expect(() => toPublicationResourceHref("pub-a",
  "/api/reader/publications/pub-b/resources/chapter.xhtml")).toThrow();
```

- [ ] Implement strict bounded payload reconstruction with Zod plus `parseReaderLocator`, finite numeric location values, bounded text/context, path normalization and membership in that publication's reading order. Strip neither invalid immutable fields nor foreign paths silently: reject attempts to change profile/publication/kind/locator through PATCH. Escape-free text is stored as text, rendered as text, never HTML. Apply the same checks to stored data returned to clients.
- [ ] Implement route handlers with awaited `params`, private/no-store on success and errors, standard UUID validation, non-disclosing denials and sanitized error logging. PATCH/DELETE require the candidate publication query described above, then perform owner+publication+ID-filtered RPC mutation. Search validates query bounds without logging the request URL/query. Never log raw Postgres exception text that might include offending rows. Use existing request-ID helpers rather than inventing a second format.
- [ ] Project nullable valid stored positions in `resolveEntitledManifest`; rewrite original hrefs consistently with reading-order links. A null/invalid extension does not block old-book reads. Test that sample manifest/resource routes expose neither full-book positions nor search text, and DTO locator quotes/excerpts stay bounded. Do not construct a new service-role client in these CRUD/search paths.
- [ ] Run focused tests, `npm run check`, and `npm run check:full` because authorization changed; commit as `feat: expose session-authorized reader depth APIs`.

## Task 5: Engine-neutral selection, decorations, responsive spreads, and positions

**Model:** `gpt-6-astra`, high. **Reviewer:** `gpt-6-astra`, high. **Dependencies:** 2–4.

**Files:** Modify `lib/reader/types.ts`, `engine.ts`, `engine.test.ts`, `readium-engine.ts`, `readium-engine.test.ts`, and engine doubles in `components/reader/reader-client.test.tsx`. Update `docs/adr/ADR-005-reader-engine.md` where the listener contract changes.

**Interfaces:** Add exactly the four types and five methods in design §8, reproduced here for dispatch clarity:

```ts
export type ReaderSelection = {
  locator: ReaderLocator; text: string;
  rect: { x: number; y: number; width: number; height: number };
};
export type ReaderAnnotationDecoration = {
  id: string; locator: ReaderLocator; color: "yellow" | "green" | "rose";
};
export type ReaderPositionInfo = { current: number; end: number; total: number };
export type ReaderAnnotationRenderResult = { unresolvedIds: string[] };
// New ReaderEngine methods:
// setSelectionListener(listener: (selection: ReaderSelection | null) => void): void;
// setAnnotationActivationListener(listener: (annotationId: string) => void): void;
// setAnnotations(annotations: ReaderAnnotationDecoration[]): Promise<ReaderAnnotationRenderResult>;
// setResponsiveLayout(input: { pageCount: 1 | 2 }): Promise<void>;
// getPositionInfo(): Promise<ReaderPositionInfo | null>;
```

- [ ] Inspect installed Readium declarations/implementation for `BasicTextSelection`, `Decoration`, decorator activation, column count, visible location boundaries, and frame coordinates. Write adapter tests using the existing navigator seam before changing production code. Test parent-viewport selection rects (including frame offset), bounded locator conversion, group-specific activation, unresolved single annotation isolation, replacement/removal of decorations, no callbacks after destroy, and async calls completing after destroy/remount.
- [ ] Run `npm run test:unit -- lib/reader/readium-engine.test.ts components/reader/reader-client.test.tsx` red. Replace the old “registers no navigator listeners” assertion with the exact narrower contract:

```ts
expect(Object.keys(navigatorInput.listeners)).toEqual(["textSelected"]);
```

Use the existing captured navigator-input variable in that suite; preserve negative keyboard/swipe/peripheral assertions. Add layout and restore tests that assert passage identity after repagination, not just an unchanged numeric fraction.
- [ ] Map selection into `ReaderSelection` and keep Readium objects inside the adapter. Register one user-highlight decoration group; only that group's activation reaches the application. Resolve/skip bad annotations individually and return unresolved IDs. Unregister listener/group state during destroy. Track full selected text separately from bounded persisted anchors so quote actions can truncate longer selections correctly.
- [ ] Read the validated manifest extension before constructing navigator positions; keep fallback mount positions for older books but return null position info for those. Determine current/end from actual visible boundaries against stable ordered positions; clamp only to valid ranges, never infer completion. Preserve original progress boundary logic and navigation-result reconciliation.
- [ ] Implement `setResponsiveLayout` using the installed `columnCount` API, capturing/restoring the locator around preference updates and serializing it with navigation. Explicit next/previous/goTo remain the only app navigation paths. Readium keyboard peripheral/swipe remains disabled. Ensure preference submission does not accidentally overwrite page count and vice versa. Retain light-theme publisher CSS behavior from ADR-005.
- [ ] Run focused tests, Gate 3 checks, and commit as `feat: extend reader engine for selection and spreads`. Record browser limitations honestly; mocked adapter tests alone are not visual or cross-browser acceptance.

## Task 6: Unicode-safe attributed quote utility

**Model:** `gpt-5.6-luna`, medium. **Reviewer:** `gpt-5.6-sol`, medium. **Dependencies:** 1 (otherwise independent).

**Files:** Create `lib/reader/quote.ts`, `lib/reader/quote.test.ts`.

**Interfaces:** `buildAttributedQuote(input: { selection: string; title: string; author: string; canonicalBookUrl: string }): { text: string; truncated: boolean }`. Clipboard/Web Share interaction is owned by Task 7; this utility is pure.

- [ ] Write tests for 0/299/300/301 ASCII characters, Vietnamese combining marks, joined emoji, exact attribution, and the documented `Array.from` fallback by temporarily stubbing `Intl.Segmenter`. Restore the global after each test. Exact example:

```ts
const result = buildAttributedQuote({ selection: "a".repeat(301), title: "Book",
  author: "Author", canonicalBookUrl: "https://example.test/en/books/book" });
expect(result).toEqual({
  text: `“${"a".repeat(300)}”\n— Book, Author\nhttps://example.test/en/books/book`,
  truncated: true,
});
```

- [ ] Run `npm run test:unit -- lib/reader/quote.test.ts` red.
- [ ] Implement the complete pure function:

```ts
export function buildAttributedQuote(input: {
  selection: string; title: string; author: string; canonicalBookUrl: string;
}): { text: string; truncated: boolean } {
  const units = typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" })
      .segment(input.selection), (part) => part.segment)
    : Array.from(input.selection);
  const quote = units.slice(0, 300).join("");
  return {
    text: `“${quote}”\n— ${input.title}, ${input.author}\n${input.canonicalBookUrl}`,
    truncated: units.length > 300,
  };
}
```

The fallback may truncate earlier within a multi-code-point grapheme, as specified by the design's `Array.from` fallback; test and document that distinction, do not claim equivalent segmentation. Never append ellipsis inside the quoted portion beyond the cap.
- [ ] Run focused tests and `npm run check`; commit as `feat: bound and attribute reader quotes`.

## Task 7: Annotation state, saved items, selection toolbar, and editors

**Model:** `gpt-5.6-terra`, high. **Reviewer:** `gpt-5.6-sol`, high. **Dependencies:** 4–6.

**Files:** Create `components/reader/use-reader-annotations.ts`, `use-reader-annotations.test.tsx`, `reader-selection-toolbar.tsx`, `reader-selection-toolbar.test.tsx`, `reader-annotation-editor.tsx`, `reader-annotation-editor.test.tsx`, `reader-saved-items.tsx`, `reader-saved-items.test.tsx`. Modify both `lib/i18n/dictionaries/{en,vi}.json`. Create `lib/reader/copy.ts` and move the existing `ReaderCopy` type there; re-export it from `reader-client.tsx` for existing imports, extending keys for these surfaces without mounting them yet.

**Interfaces:** The hook consumes `{ publicationId, enabled, request }`, where `request<T>(path: string, init?: RequestInit): Promise<T>` is injected until Task 8 supplies the shared client. Return `{ items, loadState, reload, create, update, remove, retry, setUnresolvedIds }`; create/update/remove take draft/patch/ID and return `Promise<void>`. `setUnresolvedIds(ids: string[]): void` reconciles the adapter render result against the stable keys/server IDs. Each item contains `{ key: string; annotation: ReaderAnnotation | AnnotationDraft; status: "synced" | "saving" | "unsynced"; unresolved: boolean }`. Keep stable client key separate from server ID; track pending operation privately. UI emits `onNavigate(locator)` and annotation actions, never reads Readium directly.

- [ ] Write hook tests with deferred network promises: optimistic create → success replaces client row; failed create → unsynced → retry; failed update/delete restores a recoverable view; local discard removes an unsaved item without server DELETE; repeated clicks do not duplicate concurrent submissions; late responses after publication change/unmount are ignored; empty note becomes null; a structurally valid but unresolvable stored locator appears unavailable rather than being silently deleted. Structurally invalid server data fails DTO validation and produces the scoped load error instead of entering engine state.
- [ ] Write interaction tests for named bookmarks with editable chapter-title/localized default, recolor/note/delete, tab item labels and counts, roving toolbar focus, Escape and focus return, clipped selection rects, touch action sheet, live feedback, Web Share unavailable → identical attributed copy, clipboard failure, cancelled sharing, and disabled Ask Infinity with no callback. Run the new component tests red.
- [ ] Implement state transitions explicitly; keep failed operation payload in memory for retry. Never persist selected text/notes in localStorage or analytics. Reconcile annotations with the engine through the controller later; preserve unresolved IDs and labels. Implement editor constraints from Task 1, render stored text as React text, and use the shared Dialog primitive for blocking editors.
- [ ] Implement the selection action bar from one action definition used by anchored and bottom-sheet layouts:

```tsx
<button type="button" disabled aria-describedby="reader-ask-soon">
  {copy.askInfinity}
</button>
<span id="reader-ask-soon">{copy.comingSoon}</span>
```

No click handler on the disabled affordance. Provide named yellow/green/rose controls, note state, Copy and Share. Use `buildAttributedQuote` for both clipboard/share payloads; use browser APIs from the direct user gesture, announce truncation/fallback/errors, and do not use an unbounded textarea fallback.
- [ ] Add all new strings to both dictionaries with matching structure; preserve user text verbatim. Run focused tests and `npm run check`; commit as `feat: add private reader annotation controls`.

## Task 8: Cancellable search and a shared one-time session recovery path

**Model:** `gpt-5.6-terra`, high. **Reviewer:** `gpt-5.6-sol`, high. **Dependencies:** 4, 7.

**Files:** Create `lib/reader/api-client.ts`, `api-client.test.ts`, `components/reader/reader-search-panel.tsx`, `reader-search-panel.test.tsx`. Modify `components/reader/reader-client.tsx`, `reader-client.test.tsx`, `lib/reader/copy.ts`, both dictionaries.

**Interfaces:** `createReaderApiClient(input: { publicationId: string; remint: () => Promise<void>; onLostAccess: (status: 401 | 404) => void }): { request<T>(path: string, init?: RequestInit): Promise<T> }`. For DELETE use `request<void>` and handle 204 without JSON parsing. `ReaderSearchPanel` receives `{ publicationId, request, onNavigate: (locator: ReaderLocator) => Promise<void>, copy }`. It renders grouped results and scoped retry; it does not own engine/session state.

- [ ] Add fake-timer and deferred-response tests: no search before 250ms; queries outside 2–100 trimmed code points never request; new query aborts old signal; late old results cannot replace current results; close/unmount aborts; AbortError is not a visible search failure. Test grouped chapters, untitled chapter copy, empty/error/retry, successful locator navigation and no persisted search history. Run focused tests red.
- [ ] Implement encoded query construction and result parsing, using only Task 4 DTOs. Keep previous results from being navigable after the query has changed until their associated request is current. Invoke the supplied navigation callback, which Task 10 will use to save progress and close the narrow drawer.
- [ ] Consolidate existing S4 session re-mint behavior behind the API client for the new reader-depth requests, preserving manifest/resource recovery. A 401 converges to signed-out; a 404 permits one shared in-flight re-mint and exactly one retry of that request; failed re-mint/repeated denial converges to revoked access. An abort or 502 does not revoke access. Parallel failing requests share the same re-mint promise. Do not retry ambiguous network failures of POST automatically.

```ts
// Required test outcome, using a mocked fetch and remint in api-client.test.ts:
expect(remint).toHaveBeenCalledTimes(1);
expect(onLostAccess).not.toHaveBeenCalled();
// Separate repeated-denial case:
expect(onLostAccess).toHaveBeenCalledWith(404);
```

- [ ] Keep existing shell behavior during this task; instantiate the client without mounting the new visual surfaces. Update the controller's request ownership/cleanup and sample guard tests so `mode === "sample"` never mints a reader session or starts annotations/search. On lost access abort pending work and clear private UI state consistently with S4's content teardown.
- [ ] Run focused tests, Gate 4 checks, and commit as `feat: add cancellable reader search and session recovery`.

## Task 9: Server-derived attribution and related-book presentation

**Model:** `gpt-5.6-terra`, medium. **Reviewer:** `gpt-5.6-sol`, medium. **Dependencies:** 4, 8.

**Files:** Modify `lib/data/library.ts`, `library.test.ts`, `app/[locale]/(reader)/read/[bookId]/page.tsx`, `components/reader/reader-mount.tsx`, `reader-client.tsx`, and props fixtures in `reader-client.test.tsx`. Create `app/[locale]/(reader)/read/[bookId]/page.test.tsx`. Inspect `lib/data/catalog.ts` and the existing catalog domain relation mapping before adding any query helper.

**Interfaces:** `getReadableBook` adds `authorName: string`, `canonicalBookUrl: string`, `relatedBooks: Array<{ title: string; authorName: string; href: string; coverUrl: string | null }>`, capped at 3. Entitled reader props carry those fields; sample props can omit them (or provide their existing server-derived presentation data), and depth actions remain unavailable in sample mode.

- [ ] Write DAL/page tests for exact localized canonical URL, localized author/display-name fallback consistent with catalog, no fallback book URL into the other locale, exclusion of unpublished/unlocalized/self books, empty relations, and no storage keys/additional publication IDs in props. Assert the page still calls `requireUser()` independently.
- [ ] Run the library/page tests red. Reuse the existing book-page relation selection/mapping where available; the inspected `lib/data/catalog.ts` has no standalone `getRelatedBooks` export, so do not call an invented helper. If the catalog domain exposes relation cards, map those; otherwise add a narrowly scoped related-book helper in `lib/data/library.ts` using existing author/topic/series relations and published/localized predicates, limited to three deterministic results. No new recommendation service or schema.
- [ ] Build canonical URLs through the existing locale routes and configured site origin on the server. Pass presentation values through the dynamic mount boundary:

```tsx
<ReaderMount
  backHref={withLocale(locale, "/library")}
  bookId={book.bookId}
  bookTitle={book.title}
  copy={copy}
  initialLocator={book.initialLocator}
  libraryHref={withLocale(locale, "/library")}
  locale={locale}
  manifestUrl={`/api/reader/publications/${book.publicationId}/manifest`}
  mode="entitled"
  publicationId={book.publicationId}
  signInHref={getCatalogRoutes(locale).signInFor(withLocale(locale, `/read/${book.bookId}`))}
  authorName={book.authorName}
  canonicalBookUrl={book.canonicalBookUrl}
  relatedBooks={book.relatedBooks}
/>
```

Keep the page's existing authorization and imports. Update the prop union rather than making sample mode invent entitlement data.
- [ ] Run focused tests and `npm run check`; commit as `feat: supply reader attribution and completion recommendations`.

## Task 10: Switch to the responsive reading shell and wire all depth flows

**Model:** `gpt-5.6-terra`, high. **Reviewer:** `gpt-5.6-sol`, high. **Dependencies:** 5–9.

**Files:** Create `components/reader/reader-sidebar.tsx`, `reader-sidebar.test.tsx`, `reader-completion-panel.tsx`, `reader-completion-panel.test.tsx`, `reader-shell.module.css`, `lib/reader/layout.ts`, `layout.test.ts`. Modify `reader-client.tsx`, `reader-client.test.tsx`, `reader-toc-drawer.tsx`, `reader-toc-drawer.test.tsx`, `reader-settings-panel.tsx`, `lib/reader/copy.ts`, both dictionaries, and `lib/i18n/dictionary.test.ts` as needed.

**Interfaces:** `readerPageCount(width: number, desktopChoice: 1 | 2 = 2): 1 | 2` returns `width >= 1280 ? desktopChoice : 1`. Sidebar consumes TOC/current locator/items/counts/load state and emits selection/navigation/editor actions. One controller owns engine, selected passage, active panel/tab, progress saves and layout transactions. Completion uses existing whole-book completion signal and presentation props from Task 9.

- [ ] Add responsive tests for 390/768/1279/1280/1440, null position hiding, localized singular/range labels, sidebar tabs/counts, highlights without notes, keyboard guard contexts, completion opening Notes/Highlights/Bookmarks, and empty recommendations. Test mount sequence: mint → mount/preferences → load TOC/navigation/positions/annotations → apply annotations → ready; annotation-fetch failure still reaches readable state with sidebar Retry. Run focused tests red.
- [ ] Build one sidebar content component used by persistent sidebar and existing accessible drawer. Contents uses `aria-current`; implement tab arrow/Home/End keys and tab/panel associations. Retain focus trapping/return in dialogs, 44px targets, labelled regions, live save status and reduced-motion behavior. Use the existing site's colors/spacing/type tokens; shared UI remains outside Readium.

```css
.shell { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
.persistentSidebar { display: none; }
.readerMain { min-width: 0; min-height: 0; }
@media (min-width: 1280px) {
  .shell { grid-template-columns: clamp(360px, 27vw, 420px) minmax(0, 1fr); }
  .persistentSidebar { display: flex; }
}
@media (prefers-reduced-motion: reduce) {
  .shell *, .shell *::before, .shell *::after { transition: none; animation: none; }
}
```

Keep the existing full-height reader/iframe sizing contract. Adjust the S4 single-column maximum width so two-page mode has enough space; do not put two iframes side by side as a fake spread. The adapter controls actual columns. The center divider is visual only and absent in one-page mode.
- [ ] Wire the annotation hook, activation listener, selection actions and search panel. Retain selection until an explicit dismissal, navigation, Escape, or another blocking panel opens. Capture needed selection when opening the note editor before clearing the toolbar state. Every successful saved-item/search/TOC navigation goes through the existing returned-state/progress-save path. Failed/unresolved navigation keeps the saved item and reports Location unavailable. Close drawer after navigation below 1280px; keep desktop sidebar open.
- [ ] On resize or layout choice, serialize engine layout/restoration with page turns, reapply annotations after layout settles, then read position info. Detach media/listener subscriptions on destroy. Themes apply to chrome and content; preserve publisher CSS for default content where S4 does. Settings continue using device-local storage. Keyboard arrows do nothing when focused in input, textarea, dialog, menu, or contenteditable. Touch-sized layout uses the bottom sheet; tablet uses anchored actions only where its measured rect fits.
- [ ] Replace completion card with library, Notes, Highlights/Bookmarks and optional related published books. It appears only at S4 total progression 1; page position arithmetic never marks completion. Add search/layout/settings/overflow and disabled Ask Infinity in the top toolbar, with all actions available in the compact mobile menu. Ensure sample mode has no depth fetches or depth controls while keeping its existing end action.
- [ ] Run focused tests, Gate 5 checks, and commit as `feat: ship responsive reader depth shell and completion`.

## Task 11: Browser, security, accessibility, visual, and corpus acceptance

**Model:** `gpt-5.6-terra`, high. **Reviewer:** `gpt-5.6-sol`, high. **Dependencies:** all prior tasks.

**Files:** Create `e2e/reader-depth.spec.ts`, `e2e/reader-depth-visual.spec.ts`, `e2e/support/reader-depth.ts`, `docs/runbooks/reader-depth.md`, `docs/validation/2026-09-19-s5-5-reader-depth.md`. Modify `e2e/support/publication.ts`, `e2e/reader-completion.spec.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`, `docs/runbooks/reader-corpus-matrix.md`, `docs/runbooks/testing-environments.md`, `docs/adr/ADR-005-reader-engine.md`; add visual snapshots in Playwright's generated snapshot directories. Add `@axe-core/playwright` as a development dependency with lockfile change if no existing accessibility runner is installed.

**Interfaces:** `e2e/support/reader-depth.ts` exports helpers to locate the **active** reading frame and select a known passage in a generated, sanitized, multi-chapter fixture. Extend `seedProcessedBook`'s fixture pipeline to include real chunks/positions, retaining existing callers. Use known non-sensitive fixture text for deterministic screenshots; never snapshot private corpus content into git.

- [ ] Write browser journeys before implementation fixes: create/reload/recolor/delete highlight; create/edit/remove note; rename/reopen bookmark at exact text; Vietnamese accent/no-accent search and passage navigation; 300-grapheme attributed clipboard/share with unavailable clipboard fallback; completion links; lost access after revocation. Intercept only browser clipboard/share APIs, not the annotation/search backend or Readium engine.
- [ ] Add sample network-denial assertions and security journeys for missing session, another reader's annotation ID, expired session recovery, revoked/restored entitlement and superseded publication. Verify private endpoints deny on the next protected request and search never returns an entire long chunk through excerpts **or locator context**. Test old publication with null positions remains readable. Do not infer passage visibility from preloaded inactive frames.

```ts
const forbiddenCalls: string[] = [];
page.on("request", (request) => {
  const pathname = new URL(request.url()).pathname;
  if (/^\/api\/reader\/(?:annotations(?:\/|$)|publications\/[^/]+\/(?:annotations|search)(?:\/|$))/.test(pathname)) {
    forbiddenCalls.push(pathname);
  }
});
// Open the fixture's public sample and exercise its controls.
expect(forbiddenCalls).toEqual([]);
```

Place the assertion after the real sample navigation and settled interactions, not immediately after installing the listener. Separately capture the network around attempted activation of disabled Ask Infinity and assert no request/content emission.
- [ ] Add deterministic snapshots for 390/768/1440 × light/paper/dark (nine required shell cases), plus selection/editor/search/completion states where geometry matters. Fixed public fixture title, locale, viewport height, fonts and animations; wait for the active publication frame/fonts/layout to settle. Assert sidebar width 360–420 on desktop, real two-column content, one-column narrow layout, no clipping and 44px targets. Review generated baselines visually before committing; never update them merely to make a failure disappear.
- [ ] Run axe against the shell/drawer/editor and active publication frame where accessible, plus keyboard-only tab/selection/focus-return tests. Add locale coverage for Vietnamese and English states, reduced motion and visible focus in all themes. Use real frame computed styles for publisher-CSS/theme checks; unit output mappings cannot prove visual behavior.
- [ ] Extend the existing main/nightly browser-matrix CI selection to include `reader-depth.spec.ts` alongside `ebook-golden-path.spec.ts`. Preserve the current Chromium PR gate and one-worker local fixture discipline. Visual baselines may be Chromium-only in a pinned environment; functional matrix runs Chromium, Firefox, WebKit. WebKit emulation is not evidence for physical Safari/mobile; record actual device/browser checks separately.
- [ ] Run Gate 6 locally with exported environment. Then, where browsers are installed, run:

```bash
E2E_BROWSER_MATRIX=all npm run test:e2e -- e2e/ebook-golden-path.spec.ts e2e/reader-depth.spec.ts
npm run test:e2e -- e2e/reader-depth-visual.spec.ts --project=chromium
git diff --check
```

Missing browser binaries are a reported verification gap, not a pass. Request tool escalation for blocked downloads if necessary. Do not broaden into cloud tests to work around a local failure.
- [ ] Extend the existing single corpus matrix with selection, decoration, search-locator navigation, one/two-page spread and annotation restore columns. Validate the five private EPUBs across desktop Chrome/Safari/Firefox and mobile Chrome/Safari when available, preserving processor-profile exclusions and recording actual evidence. Never commit private EPUBs, book text, screenshots of private content, keys or personal annotations. If files/devices/design references are unavailable, record exact outstanding owner checks and leave the affected exit criteria unverified; do not promote ADR-005 to Accepted on generated fixtures alone.
- [ ] Update the reader-depth runbook with local backfill, retry/unresolved-location behavior, quote fallback, rollout order (schema → worker → application → operator backfill), old-book fallback and rollback. App rollback must preserve annotations/index rows and keep the new compatible database state; do not suggest destructive down-migrations. Record test commands, counts, environment, snapshot review and limitations in the validation file. Remove only stale statements in existing runbooks directly contradicted by this work.
- [ ] Commit as `test: verify reader depth and responsive visual acceptance`. Hand the branch, full diff package, validation file and ledger findings to the final reviewer. Resolve findings using the SDD final-review process, then report verified results and outstanding manual gates. S6 cutover and production deployment remain separate work.

## Spec coverage and final handoff checklist

| Design requirement | Owning tasks |
| --- | --- |
| §6 schema, RLS, immutable publication identity | 1, 4 |
| §7 sanitized extraction, stable positions, atomic backfill | 2, 3 |
| §8 neutral engine, selection, decoration, activation, spread | 5 |
| §9 authorized CRUD/search and presentation DTO | 4, 9 |
| §10 loading, optimistic save/retry, bookmarks, search, quote | 6, 7, 8, 10 |
| §11 sidebar/topbar/footer/responsive layout/completion | 10 |
| §12 Vietnamese/English, localized canonical attribution | 7–10 |
| §13 accessibility and themes | 7, 10, 11 |
| §14 privacy, sample isolation, disabled AI | 1, 4, 7, 8, 11 |
| §15 failure recovery, null positions, lost access | 3–5, 7, 8, 10, 11 |
| §§16–17 full verification and corpus evidence | 11 plus each gate |
| §18 pre-launch S5.5, S6 handoff | Scope and Task 11 |

- [ ] All task commits have focused test evidence and independent spec/quality verdicts.
- [ ] Every required automated gate passed against the owned local stack, or is explicitly reported as blocked/unverified.
- [ ] All nine visual cases have reviewed baselines; actual spread/anchor behavior has browser evidence.
- [ ] Private EPUB/browser/manual checks have evidence or clearly named outstanding checks, never fabricated passes.
- [ ] Final review covers the whole branch and all deferred/parked findings; report controller rulings and their consequences.
- [ ] Handoff identifies the implementation branch/commits, validation file, remaining S6 owner work and rollout/backfill instructions. Do not claim production launch or merge/deploy without that separate authorization.
