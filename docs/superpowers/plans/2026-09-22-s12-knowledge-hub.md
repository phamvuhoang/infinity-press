# S12 Knowledge Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bilingual, crawlable knowledge hub where editors publish safe typed-block ideas and articles connected to books, topics, and each other, and readers discover them through public pages, backlinks, search, sitemap, and structured data.

**Architecture:** Postgres stores two first-class editorial entities with real join-table foreign keys, RLS-filtered public read RPCs, audited admin mutation RPCs, readiness gates, redirect-safe slug writes, and lexical search. TypeScript owns the discriminated block schema and renders it through one exhaustive Server Component that only creates React elements; admin Client Components edit the same typed structure and upload knowledge images through short-lived signed URLs. Public Server Components use a server-only knowledge DAL, existing catalog DTOs, metadata helpers, routes, cards, and storefront revalidation.

**Tech Stack:** Next.js 16.3 App Router, React 19 Server Components and Server Actions, Supabase/Postgres/Auth/RLS/Storage, TypeScript 6, Zod 4, Vitest 5, pgTAP, Playwright 1.63, Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-09-21-s12-knowledge-hub-design.md`

## Global Constraints

- Read the local Next.js 16 guides before changing framework code: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`, `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md`, `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.md`, `node_modules/next/dist/docs/01-app/02-guides/forms.md`, `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `node_modules/next/dist/docs/01-app/01-getting-started/08-caching.md`, and `node_modules/next/dist/docs/01-app/01-getting-started/09-revalidating.md`.
- Customer routes stay under `/{locale}` for exactly `vi` and `en`; `/admin` remains unprefixed. A missing localization returns 404 and never falls back to the other language.
- Every `/admin/ideas` and `/admin/articles` page and every Server Action calls `requireAdmin()` itself. Shared page components and the admin layout are not authorization boundaries.
- A service-role client may be created only after `requireAdmin()` and an entity-visibility check pass. Never expose `SUPABASE_SERVICE_ROLE_KEY` to browser code.
- Stored editorial content is typed JSON only. No schema, action, database column, or renderer accepts stored HTML; `BlockRenderer.tsx` never uses `dangerouslySetInnerHTML`.
- The content schema rejects HTML-tag syntax in every editorial text field with `/<\/?[a-z][^>]*>/i`; React escaping remains the second safety boundary for ordinary angle characters that are not tags.
- Inline content is an array of runs: `{ text, marks?: ('emphasis'|'strong')[], link?: InternalLink|ExternalLink }`. Internal links store an entity kind plus the localized slug; external links accept only absolute `https:` or `http:` URLs.
- Internal link kinds are `book`, `idea`, `article`, `author`, `series`, and `topic`. Their localized route is generated at render time; stored old slugs remain functional through the existing public redirect map.
- A `quote` has exactly one attribution source: nonblank free text or `bookId`. A `quote` with `bookId` and every `book_quote` is capped at 300 Unicode grapheme clusters. Extract and reuse the grapheme helper used by `buildAttributedQuote`; do not implement a second counter.
- A rendered book-backed quote always includes the localized book title, author, and canonical book link. If a referenced book is no longer published/localized, omit the whole block rather than render an unattributed quote.
- `body_blocks` has a maximum of 100 blocks so the serialized form remains comfortably under Next.js's 1 MB Server Action body limit. Lists contain at most 50 items; every inline run is nonblank and at most 5,000 characters.
- Knowledge images live in the existing public `covers` bucket under `knowledge/{ideas|articles}/{entityId}/{uuid}.{jpg|png|webp}`. The server mints keys and signed uploads; the block stores only storage key, alt text, width, and height.
- `published_at` is set with `coalesce(published_at, now())` on an article's first successful publish. Unpublishing and republishing preserve the original date, so reverse-chronological archives do not reorder editorial history.
- URL namespace includes the path segment. Enforce `(locale, slug)` inside `idea_localizations` and inside `article_localizations`; `/ideas/shared` and `/articles/shared` may coexist because they are different public paths. No existing entity type shares either path segment.
- A published idea detail always displays its question and short answer above the body, so its JSON-LD includes one matching `FAQPage` question/answer. Never infer FAQ structured data from arbitrary blocks.
- Idea index grouping is many-to-many: an idea appears under every published related topic in that locale; an idea without a visible topic appears once under `Other` / `Khác`.
- Search group order is books, authors, ideas, articles, series, topics. Existing book/author matching behavior and rank stay unchanged; idea/article body blocks are not searched.
- Public reads explicitly filter entity status and locale inside security-definer RPCs. Do not rely on RLS alone because admins can read drafts.
- Every create, details edit, localization edit, SEO edit, relation replacement, publish, and unpublish operation writes exactly one `audit_logs` row in the same transaction.
- Slug changes on published knowledge localizations call `record_slug_redirect(oldPath, newPath)` in the same transaction. That function removes reverse collisions and rewrites incoming destinations, so redirect chains remain flattened.
- Public pages keep the current caching model; do not add `use cache`. Every knowledge mutation calls a shared `revalidateKnowledgeHub()` that invalidates `"/[lang]"` as a layout and `/sitemap.xml`, plus the relevant admin paths.
- S9 currently owns pgTAP `042` and its remaining plan should use `043`–`049`; S11 reserves `050`. Use `051`–`053` for S12 and migrations beginning `20260926100000`.
- Applied migrations are never edited. Update `lib/supabase/database.types.ts` from a reset local stack after the S12 migrations; do not hand-maintain generated definitions.
- Run database and Playwright suites only against local Supabase. Follow `docs/runbooks/testing-environments.md`, including its scratch-workdir, port-ownership, environment-export, and stale-fixture warnings.
- Use Node.js 22. The final gate is `npm run check`, `npm run db:test`, and `npm run check:full` on an owned local stack, or the runbook's explicit scratch-stack equivalents for the database commands.

## File Structure

| Area | Files and responsibility |
| --- | --- |
| Content contract | `lib/knowledge/blocks.ts`, `lib/knowledge/blocks.test.ts`, `lib/reader/quote.ts`, `components/knowledge/BlockRenderer.tsx` and tests: typed safe blocks, shared grapheme rules, exhaustive rendering. |
| Database schema | `supabase/migrations/20260926100000_s12_knowledge_schema.sql`, `supabase/tests/051_s12_knowledge_schema.sql`: ideas/articles, localizations, six join tables, constraints, grants, and RLS. |
| Admin database lifecycle | `20260926110000_s12_knowledge_admin.sql`, `052_s12_knowledge_admin.sql`, `lib/knowledge/readiness.ts`: audited CRUD/localization/SEO/relation/publish RPCs, readiness parity, redirects. |
| Admin application | `lib/data/admin-knowledge.ts`, `app/admin/knowledge/actions.ts`, admin route wrappers, `components/admin/knowledge/*`, admin nav: protected DAL/actions, typed block editor, image uploads, readiness, relations, and publishing. |
| Public read model | `20260926120000_s12_knowledge_public.sql`, `053_s12_knowledge_public_search.sql`, `lib/data/knowledge.ts`, `lib/knowledge/public-types.ts`: published localized indexes/details/backlinks and search extension. |
| Public pages | `app/[lang]/(public)/ideas/*`, `articles/*`, `components/knowledge/*`, dictionaries, routes: index/detail rendering, localized alternates, relations, and cards. |
| Existing-surface integration | book page, topic entity page, search page, catalog search types/DAL: knowledge backlinks and grouped search results. |
| SEO and verification | `lib/seo/json-ld.ts`, `app/sitemap.ts`, E2E spec/support, `docs/runbooks/knowledge-hub.md`: Article/FAQ JSON-LD, canonical/hreflang/sitemap, acceptance journeys, operator guidance. |

---

### Task 1: Define and render the typed content-block contract

**Files:**
- Create: `lib/knowledge/blocks.ts`
- Create: `lib/knowledge/blocks.test.ts`
- Create: `components/knowledge/BlockRenderer.tsx`
- Create: `components/knowledge/BlockRenderer.test.tsx`
- Modify: `lib/reader/quote.ts`
- Modify: `lib/reader/quote.test.ts`
- Modify: `lib/i18n/routes.ts`
- Modify: `lib/i18n/routes.test.ts`

**Interfaces:**
- Produces `KnowledgeBlock`, `InlineRun`, `KnowledgeEntityKind`, and `knowledgeBlocksSchema`.
- Produces `MAX_BOOK_QUOTE_GRAPHEMES = 300`, `splitGraphemes(text)`, and `isWithinBookQuoteLimit(text)` from `lib/reader/quote.ts`; `buildAttributedQuote` consumes the same helper.
- Produces `getKnowledgeRoutes(locale)` with `ideas`, `idea(slug)`, `articles`, and `article(slug)`.
- Produces `BlockRenderer({ blocks, locale, bookCopy, booksById, ideasById })`, where `bookCopy` is `Dictionary["catalog"]["book"]` and maps contain only published localized references.

- [ ] **Step 1: Write failing grapheme-helper tests**

  Extend the existing quote suite with direct helper assertions for 300/301 ASCII characters, Vietnamese combining sequences, joined emoji, and the documented code-point fallback when `Intl.Segmenter` is unavailable:

  ```ts
  expect(splitGraphemes("a\u0306\u0301".repeat(301))).toHaveLength(301);
  expect(isWithinBookQuoteLimit("👩‍💻".repeat(300))).toBe(true);
  expect(isWithinBookQuoteLimit("👩‍💻".repeat(301))).toBe(false);
  ```

  Run: `npx vitest run lib/reader/quote.test.ts`.
  Expected: FAIL because the helpers are not exported.

- [ ] **Step 2: Extract the shared quote primitives without changing S5.5 output**

  Implement:

  ```ts
  export const MAX_BOOK_QUOTE_GRAPHEMES = 300;

  export function splitGraphemes(text: string): string[] {
    return typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
      : Array.from(text);
  }

  export function isWithinBookQuoteLimit(text: string): boolean {
    return splitGraphemes(text).length <= MAX_BOOK_QUOTE_GRAPHEMES;
  }
  ```

  Refactor `buildAttributedQuote` to call `splitGraphemes` and the constant. Re-run the entire existing quote suite to prove byte-for-byte output remains unchanged.

- [ ] **Step 3: Write the failing block-schema matrix**

  Create one valid fixture for every block and assert the parsed discriminated union. Use this exact stored shape:

  ```ts
  type InlineRun = {
    text: string;
    marks?: ("emphasis" | "strong")[];
    link?:
      | { kind: "internal"; entity: "book" | "idea" | "article" | "author" | "series" | "topic"; slug: string }
      | { kind: "external"; href: string };
  };

  type KnowledgeBlock =
    | { type: "paragraph"; content: InlineRun[] }
    | { type: "heading"; level: 2 | 3; text: string }
    | { type: "list"; ordered: boolean; items: InlineRun[][] }
    | { type: "quote"; text: string; attribution?: string; bookId?: string }
    | { type: "book_quote"; bookId: string; text: string; locatorLabel?: string }
    | { type: "image"; storageKey: string; alt: string; width: number; height: number }
    | { type: "book_card"; bookId: string }
    | { type: "idea_card"; ideaId: string };
  ```

  Reject unknown types, duplicate marks, relative/executable external URLs, malformed internal slugs, raw HTML tags in every text-bearing field, empty paragraph/list content, invalid UUID card references, image paths outside `knowledge/(ideas|articles)/...`, a quote with zero or two attribution sources, and 301-grapheme book-backed quotes. Assert exactly 100 blocks pass and 101 fail.

- [ ] **Step 4: Implement the Zod schemas and exported inferred types**

  Compose small schemas (`safeText`, `inlineRunSchema`, `inlineContentSchema`, then each block) and finish with:

  ```ts
  export const knowledgeBlocksSchema = z.array(knowledgeBlockSchema).max(100);
  export type KnowledgeBlock = z.infer<typeof knowledgeBlockSchema>;
  export type InlineRun = z.infer<typeof inlineRunSchema>;
  ```

  Use `superRefine` for quote XOR and call `isWithinBookQuoteLimit` whenever `bookId` is present and for every `book_quote`. Do not sanitize or transform HTML into text; invalid stored markup is rejected.

- [ ] **Step 5: Add failing route and renderer tests**

  Route tests assert:

  ```ts
  expect(getKnowledgeRoutes("vi")).toEqual({
    ideas: "/vi/ideas",
    idea: expect.any(Function),
    articles: "/vi/articles",
    article: expect.any(Function),
  });
  expect(getKnowledgeRoutes("vi").idea("song-tinh-thuc")).toBe("/vi/ideas/song-tinh-thuc");
  ```

  Renderer tests cover every block, nested emphasis/strong/link combinations, ordered/unordered lists, dimensions/alt for images, and localized routes. Assert no render of missing `book_card`, `idea_card`, or book-backed quote references; assert a valid book quote shows title, author, canonical link, and locator. Read the source file and assert it contains neither `dangerouslySetInnerHTML` nor a raw-HTML case.

- [ ] **Step 6: Implement routes and the exhaustive Server Component renderer**

  `BlockRenderer.tsx` must not be a Client Component. Render inline runs by wrapping text in `<em>`, `<strong>`, and then `<Link>`/`<a rel="noopener noreferrer">`; React supplies escaping. Use an exhaustive `never` assertion after the switch:

  ```ts
  const unreachable: never = block;
  throw new Error(`Unsupported knowledge block: ${JSON.stringify(unreachable)}`);
  ```

  Render knowledge images through `next/image` with stored dimensions and `coverPublicUrl(storageKey)`. Reuse `BookCard` for `book_card`; use a small linked idea card for `idea_card`. Do not serialize blocks into DOM attributes.

- [ ] **Step 7: Verify and commit the content contract**

  ```bash
  npx vitest run lib/reader/quote.test.ts lib/knowledge/blocks.test.ts components/knowledge/BlockRenderer.test.tsx lib/i18n/routes.test.ts
  npm run check
  git add lib/reader/quote.ts lib/reader/quote.test.ts lib/knowledge/blocks.ts lib/knowledge/blocks.test.ts components/knowledge/BlockRenderer.tsx components/knowledge/BlockRenderer.test.tsx lib/i18n/routes.ts lib/i18n/routes.test.ts
  git commit -m "feat(knowledge): define safe typed content blocks"
  ```

---

### Task 2: Add knowledge entities, localizations, relations, RLS, and grants

**Files:**
- Create: `supabase/migrations/20260926100000_s12_knowledge_schema.sql`
- Create: `supabase/tests/051_s12_knowledge_schema.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Produces `ideas`, `idea_localizations`, `articles`, `article_localizations`, `idea_books`, `idea_topics`, `idea_links`, `article_books`, `article_ideas`, and `article_topics` exactly as specified.
- Uses existing `public.content_status` and `authors(id)`.
- Browser roles receive published-row SELECT only; all writes remain behind later admin RPCs.

- [ ] **Step 1: Write the failing schema/constraint pgTAP suite**

  Assert all ten tables, exact primary/foreign keys, cascade behavior, required columns, defaults, and uniqueness. Include:

  ```sql
  select col_is_fk('public', 'articles', 'author_id', 'articles have a real author foreign key');
  select col_is_unique('public', 'idea_localizations', array['locale', 'slug'], 'idea paths are unique per locale');
  select col_is_unique('public', 'article_localizations', array['locale', 'slug'], 'article paths are unique per locale');
  select throws_ok(
    $$ insert into public.idea_links(idea_id, related_idea_id, position)
       values (:'idea_a', :'idea_a', 1) $$,
    '23514', null, 'ideas cannot link to themselves'
  );
  ```

  Assert `jsonb_typeof(body_blocks) = 'array'`, positive/unique editorial positions within each parent, one localization per entity+locale, supported locales only, and that identical `en/shared` slugs may coexist between idea/article because their URL prefixes differ.

- [ ] **Step 2: Write the failing RLS and grant matrix**

  Seed draft and published entities plus mixed published/draft relation targets. As `anon` and a non-admin authenticated reader, assert only published parent/localization rows and relation rows whose parent and target are both public are selectable. Assert no browser role can insert/update/delete any S12 table. As an authenticated admin, assert all draft/published rows are readable but direct writes still fail.

- [ ] **Step 3: Run the schema suite red**

  Run:

  ```bash
  supabase test db supabase/tests/051_s12_knowledge_schema.sql --workdir .superpowers/scratch/sbworkdir
  ```

  Expected: FAIL because the S12 relations do not exist.

- [ ] **Step 4: Implement the schema and indexes**

  Create the base/localization tables with timestamps and `body_blocks jsonb not null default '[]'::jsonb check (jsonb_typeof(body_blocks) = 'array')`. Add updated-at triggers using the repository's existing `touch_updated_at` trigger function for ideas and both localization tables. Articles use `published_at timestamptz` and `created_at`; article localization carries `updated_at`.

  Add the six explicit join tables. Ordered tables use primary key on the pair, `position > 0`, and unique `(parent_id, position)`. Unordered topic tables use the entity/topic pair as primary key. Add indexes on every reverse foreign-key direction used by book/topic backlinks.

- [ ] **Step 5: Implement RLS and explicit privileges**

  Enable RLS everywhere. Public base/localization policies require parent `status='published'`. Relation policies require the parent published and the referenced book/idea/topic published; localization-specific visibility remains enforced by the public RPC later. Add admin SELECT policies using `public.is_admin()`.

  Revoke all from `anon, authenticated`, then grant SELECT to both roles and let policies filter it. Grant no direct writes to browser roles. Explicitly grant SELECT/INSERT/UPDATE/DELETE on the S12 tables to `service_role` for local fixtures and trusted operations; normal application mutations still use the audited admin RPCs.

- [ ] **Step 6: Reset, run pgTAP, generate types, and commit**

  ```bash
  supabase db reset --workdir .superpowers/scratch/sbworkdir
  supabase test db --workdir .superpowers/scratch/sbworkdir
  supabase gen types --local --lang typescript --workdir .superpowers/scratch/sbworkdir > lib/supabase/database.types.ts
  git diff --check
  git add supabase/migrations/20260926100000_s12_knowledge_schema.sql supabase/tests/051_s12_knowledge_schema.sql lib/supabase/database.types.ts
  git commit -m "feat(knowledge): add editorial graph schema"
  ```

---

### Task 3: Add readiness and audited admin lifecycle RPCs

**Files:**
- Create: `lib/knowledge/readiness.ts`
- Create: `lib/knowledge/readiness.test.ts`
- Create: `supabase/migrations/20260926110000_s12_knowledge_admin.sql`
- Create: `supabase/tests/052_s12_knowledge_admin.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Produces `checkIdeaReadiness(snapshot): IdeaReadinessIssueCode[]` and `checkArticleReadiness(snapshot): ArticleReadinessIssueCode[]`.
- Produces SQL `idea_readiness_issues(uuid)` and `article_readiness_issues(uuid)` with the same code order.
- Produces create, details, localization, SEO, relation, publish, and unpublish RPCs listed below.

- [ ] **Step 1: Write failing TypeScript readiness tests**

  Define exact issue codes and order:

  ```ts
  type IdeaReadinessIssueCode = "missing_localization" | "missing_blocks" | "missing_related_book";
  type ArticleReadinessIssueCode = "missing_localization" | "missing_blocks";
  ```

  A complete idea localization has nonblank slug, question, short answer, and at least one parsed block; a complete article localization has slug, title, excerpt, and at least one parsed block. Assert any one complete locale satisfies localization/block requirements, but the idea still requires one relation in `idea_books`. Test issue messages and editor-section mappings for the readiness badge/publish panel.

- [ ] **Step 2: Implement readiness helpers and error parsers**

  Export snapshots, issue arrays, messages, section mappings, and `parseIdeaReadinessError`/`parseArticleReadinessError` for database messages using SQLSTATE `EB030` and `EB031`. Keep the same issue order as SQL.

- [ ] **Step 3: Write failing pgTAP tests for every admin RPC**

  Cover these exact signatures:

  ```text
  admin_create_idea(locale, slug, question, short_answer) -> uuid
  admin_create_article(author_id, locale, slug, title, excerpt) -> uuid
  admin_update_article(article_id, author_id) -> void
  admin_save_idea_localization(idea_id, locale, slug, question, short_answer, body_blocks) -> uuid
  admin_save_article_localization(article_id, locale, slug, title, excerpt, body_blocks) -> uuid
  admin_save_idea_seo(idea_id, locale, seo_title, seo_description) -> void
  admin_save_article_seo(article_id, locale, seo_title, seo_description) -> void
  admin_set_idea_relations(idea_id, book_ids, topic_ids, related_idea_ids) -> void
  admin_set_article_relations(article_id, book_ids, idea_ids, topic_ids) -> void
  publish_idea(idea_id) / unpublish_idea(idea_id) -> void
  publish_article(article_id) / unpublish_article(article_id) -> void
  ```

  Assert non-admin execution fails, inputs replace ordered/unordered relations atomically, duplicates/self-links roll back, every successful call writes exactly one correctly named audit row, and each publish refuses every readiness failure independently.

- [ ] **Step 4: Add redirect and article-date assertions**

  Publish localized fixtures, rename each slug, and assert exactly one old→new redirect. Rename again and assert both historic source paths point directly to the newest path with no destination that is itself a source. Assert draft slug edits write no redirect. Publish/unpublish/republish an article with clock-separated timestamps and assert `published_at` stays equal to its first publish time.

- [ ] **Step 5: Run admin pgTAP red**

  Run: `supabase test db supabase/tests/052_s12_knowledge_admin.sql --workdir .superpowers/scratch/sbworkdir`.

  Expected: FAIL because all S12 admin functions are missing.

- [ ] **Step 6: Implement readiness SQL and create/update functions**

  `idea_readiness_issues` and `article_readiness_issues` inspect localizations and `jsonb_array_length`. Revoke their execution from browser roles. Create functions insert a draft base row plus the initial localization in one transaction and one audit row. Localization functions validate `vi|en`, lock the parent, upsert content fields, and call `record_slug_redirect` only when the parent is already published and the slug changed. SEO functions require an existing localization and update only SEO fields.

- [ ] **Step 7: Implement relation and publish functions**

  Relation functions lock the parent, delete/insert each set, use `unnest(... ) with ordinality` for ordered arrays, and write one audit row containing all ordered IDs. Publish functions lock, call readiness SQL, raise `EB030`/`EB031` with comma-separated codes, then update status; article publish sets `published_at = coalesce(published_at, now())`. Unpublish sets status to draft without clearing article date. Grant admin mutation execution only to `authenticated`.

- [ ] **Step 8: Reset, verify parity, regenerate types, and commit**

  ```bash
  npx vitest run lib/knowledge/readiness.test.ts
  supabase db reset --workdir .superpowers/scratch/sbworkdir
  supabase test db --workdir .superpowers/scratch/sbworkdir
  supabase gen types --local --lang typescript --workdir .superpowers/scratch/sbworkdir > lib/supabase/database.types.ts
  git diff --check
  git add lib/knowledge/readiness.ts lib/knowledge/readiness.test.ts supabase/migrations/20260926110000_s12_knowledge_admin.sql supabase/tests/052_s12_knowledge_admin.sql lib/supabase/database.types.ts
  git commit -m "feat(knowledge): add audited editorial lifecycle"
  ```

---

### Task 4: Build the protected admin DAL, actions, editors, and image upload

**Files:**
- Create: `lib/data/admin-knowledge.ts`, `lib/data/admin-knowledge.test.ts`
- Create: `lib/data/knowledge-images.ts`, `lib/data/knowledge-images.test.ts`
- Create: `app/admin/knowledge/actions.ts`, `app/admin/knowledge/actions.test.ts`
- Create: `app/admin/knowledge/image-actions.ts`, `app/admin/knowledge/image-actions.test.ts`
- Create: `components/admin/knowledge/knowledge-pages.tsx`, `knowledge-pages.test.tsx`
- Create: `components/admin/knowledge/knowledge-create-form.tsx`
- Create: `components/admin/knowledge/knowledge-localization-form.tsx`
- Create: `components/admin/knowledge/knowledge-block-editor.tsx`, `knowledge-block-editor.test.tsx`
- Create: `components/admin/knowledge/knowledge-relations-form.tsx`, `knowledge-relations-form.test.tsx`
- Create: `components/admin/knowledge/knowledge-seo-form.tsx`
- Create: `components/admin/knowledge/knowledge-publish-panel.tsx`, `knowledge-publish-panel.test.tsx`
- Create: `app/admin/ideas/page.tsx`, `app/admin/ideas/new/page.tsx`, `app/admin/ideas/[ideaId]/page.tsx`
- Create: `app/admin/articles/page.tsx`, `app/admin/articles/new/page.tsx`, `app/admin/articles/[articleId]/page.tsx`
- Modify: `components/admin/admin-nav.tsx`
- Create: `components/admin/admin-nav.test.tsx`
- Modify: `lib/catalog/schemas.ts`, `lib/catalog/schemas.test.ts`
- Modify: `lib/catalog/revalidate.ts`, `lib/catalog/revalidate.test.ts`

**Interfaces:**
- Produces discriminated `AdminKnowledgeDTO` / `AdminKnowledgeListItemDTO` and DAL methods matching every Task 3 RPC.
- Produces Zod action schemas for create, content localization, SEO, and relations; content schemas parse a JSON string then call `knowledgeBlocksSchema`.
- Produces `revalidateKnowledgeHub(kind, id)`.
- Produces signed uploads under the exact knowledge storage-key prefix.

- [ ] **Step 1: Write failing DAL mapping and authorization tests**

  Test list/detail mapping for both kinds, locale ordering `vi,en`, ordered relation positions, article author, persisted SEO, and readiness snapshots. Every exported DAL function must call `requireAdmin()` before `createClient()`; image signing must not call `createAdminClient()` when auth or entity lookup fails. Assert raw database errors become safe typed errors for duplicate slug, not found, and readiness failures.

- [ ] **Step 2: Implement the server-only admin DALs**

  Keep one discriminated DTO:

  ```ts
  type AdminKnowledgeDTO =
    | { kind: "idea"; id: string; status: Status; localizations: IdeaLocalization[]; bookIds: string[]; topicIds: string[]; relatedIdeaIds: string[]; readinessIssues: IdeaReadinessIssueCode[] }
    | { kind: "article"; id: string; status: Status; authorId: string; publishedAt: string | null; localizations: ArticleLocalization[]; bookIds: string[]; ideaIds: string[]; topicIds: string[]; readinessIssues: ArticleReadinessIssueCode[] };
  ```

  Use authenticated session clients for all reads/RPCs. `createKnowledgeImageUpload(kind,id,input)` gates admin, validates UUID/kind, verifies the entity through the session client, then creates the service-role client, selects the `covers` bucket, and signs the relative storage key `knowledge/{kind plural}/{id}/{uuid}.ext` without writing a database row.

- [ ] **Step 3: Write failing action schema and authorization tests**

  Assert every action calls `requireAdmin({next})` before parsing, rejects invalid locale/UUID/HTML/block JSON/relations without a write, maps known failures to the correct field or publish issue, hides unknown database text, revalidates on success, and redirects only after create. Verify the image action accepts JPEG/PNG/WebP up to 5 MB and returns only `{storageKey,path,token}`.

- [ ] **Step 4: Implement schemas, actions, and revalidation**

  Add schemas with these fields:

  ```ts
  ideaCreate: { locale, slug, question, shortAnswer }
  articleCreate: { authorId, locale, slug, title, excerpt }
  ideaLocalization: { locale, slug, question, shortAnswer, bodyBlocks }
  articleLocalization: { locale, slug, title, excerpt, bodyBlocks }
  knowledgeSeo: { seoTitle: string|null, seoDescription: string|null }
  ideaRelations: { bookIds: uuid[], topicIds: uuid[], relatedIdeaIds: unique uuid[] }
  articleRelations: { bookIds: uuid[], ideaIds: uuid[], topicIds: uuid[] }
  ```

  `revalidateKnowledgeHub` calls `revalidatePath("/[lang]", "layout")`, `revalidatePath("/sitemap.xml")`, both admin list paths, and the edited admin detail path. Every Server Action calls it after a successful mutation and before a create redirect.

- [ ] **Step 5: Write failing typed block-editor interaction tests**

  Starting with one paragraph, exercise Add block for all eight types, editing inline runs/marks/internal/external links, adding/removing list items, selecting book/idea references, image upload result insertion, drag reorder plus Move up/down keyboard controls, and removal. Assert the hidden `bodyBlocks` input contains schema-valid JSON in visual order and that an action failure preserves unsaved state.

- [ ] **Step 6: Implement the block editor and signed image flow**

  Make the editor a Client Component with local `KnowledgeBlock[]` state; do not use a `contentEditable` or WYSIWYG HTML surface. Render type-specific form fields and repeated inline-run controls. For image blocks, select a local file + alt, call the protected reservation action, upload with `uploadToSignedUrl`, measure dimensions with `createImageBitmap`, then insert the typed image block. Show upload/action failures in `role="alert"` and saved state in `role="status"`.

- [ ] **Step 7: Write failing admin page and relation/publish tests**

  Assert all six route files call `requireAdmin()` before shared renderers. List tables show status, locales, and readiness. Editors expose anchored Details, Localizations, Relations, SEO, Publish sections. Idea relations preserve book/idea order; article relations preserve book/idea order; topic selections are unordered. Publish is disabled with messages until readiness is empty and calls the correct publish/unpublish action.

- [ ] **Step 8: Implement admin pages and navigation**

  Shared page components accept `kind`. Load books through `listAdminBooks`, topics/authors through existing option DALs, and ideas through `listAdminKnowledge("idea")`; filter self from related idea options. Each locale has a content form and SEO form. Article Details has author selection; idea Details shows immutable ID/status. Add Ideas and Articles to admin navigation and keep admin copy English-only.

- [ ] **Step 9: Verify the complete admin slice and commit**

  ```bash
  npx vitest run lib/data/admin-knowledge.test.ts lib/data/knowledge-images.test.ts lib/catalog/schemas.test.ts lib/catalog/revalidate.test.ts app/admin/knowledge/actions.test.ts app/admin/knowledge/image-actions.test.ts components/admin/knowledge
  npm run check
  git add lib/data/admin-knowledge.ts lib/data/admin-knowledge.test.ts lib/data/knowledge-images.ts lib/data/knowledge-images.test.ts lib/catalog/schemas.ts lib/catalog/schemas.test.ts lib/catalog/revalidate.ts lib/catalog/revalidate.test.ts app/admin/knowledge app/admin/ideas app/admin/articles components/admin/knowledge components/admin/admin-nav.tsx components/admin/admin-nav.test.tsx
  git commit -m "feat(admin): add idea and article editors"
  ```

---

### Task 5: Add published knowledge read RPCs and the server-only public DAL

**Files:**
- Create: `supabase/migrations/20260926120000_s12_knowledge_public.sql`
- Create: `supabase/tests/053_s12_knowledge_public_search.sql`
- Create: `lib/knowledge/public-types.ts`
- Create: `lib/data/knowledge.ts`, `lib/data/knowledge.test.ts`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Produces `knowledge_idea_index(locale)`, `knowledge_idea_page(locale,slug)`, `knowledge_article_index(locale)`, `knowledge_article_page(locale,slug)`, `knowledge_for_book(locale,book_id)`, and `knowledge_for_topic(locale,topic_id)`.
- Produces `KnowledgeIdeaSummary`, `KnowledgeArticleSummary`, `KnowledgeIdeaPage`, `KnowledgeArticlePage`, and `KnowledgeLinkSummary`.
- `KnowledgeIdeaPage` carries `createdAt` and localization `updatedAt`; `KnowledgeArticlePage` carries preserved `publishedAt`, localization `updatedAt`, and the localized published author reference required by visible byline and Article JSON-LD.
- Public DAL maps relation IDs to existing `CatalogBookCard` and published idea summaries while preserving editorial position.

- [ ] **Step 1: Write failing public-read pgTAP assertions**

  As anon/authenticated readers, assert index/detail RPCs return only published entities with the requested localization; draft, archived, and missing-locale entities never appear. Verify idea index topic grouping inputs, article reverse `published_at desc, id` order, relation order, alternate slug only when the other localization exists, and null for malformed/missing slugs.

  Assert book/topic backlink RPCs return only published localized ideas/articles and deterministic order: ideas by localized question then ID; articles by `published_at desc` then ID.

- [ ] **Step 2: Extend the same pgTAP file with search cases**

  Replace `search_catalog(text,text)` without changing its return signature. Seed accented Vietnamese idea question/short answer and article title/excerpt. Assert accented and unaccented queries return `kind='idea'|'article'`, drafts never appear, body-only text does not match, each kind caps at 20, and existing book/author/series/topic results and scores remain unchanged.

- [ ] **Step 3: Run public/search pgTAP red**

  Run: `supabase test db supabase/tests/053_s12_knowledge_public_search.sql --workdir .superpowers/scratch/sbworkdir`.

  Expected: FAIL because the knowledge read RPCs and search kinds do not exist.

- [ ] **Step 4: Implement the published read RPCs**

  Use stable security-definer functions with `set search_path=''`, fully qualified relations, exact `vi|en` filtering, explicit `status='published'`, and revoke/grant to `anon, authenticated`. Detail RPCs return JSON with scalar content, lifecycle timestamps, localized author data for articles, ordered `bookIds`, `relatedIdeaIds`/`ideaIds`, and localized topic refs. Index RPCs return flat rows; TypeScript performs the final topic grouping.

  `knowledge_for_book` and `knowledge_for_topic` return `(kind, slug, title, excerpt, published_at)` where idea title is its question and excerpt is its short answer.

- [ ] **Step 5: Extend `search_catalog` without indexing body blocks**

  Add two `union all` branches to the existing scored CTE. Idea score is `greatest(catalog_match_score(question), catalog_match_score(short_answer))`; article score uses title/excerpt. Keep the same normalized query bounds, public filters, per-kind row number limit, and deterministic final order. Revoke default execution and restore anon/authenticated grants after replacement.

- [ ] **Step 6: Write failing DAL parsing/order/error tests**

  Mock RPCs and `getBookCards`. Assert malformed slugs short-circuit, invalid `body_blocks` cause a safe public error, relation arrays preserve RPC order, missing/unpublished card references are dropped, book-backed blocks resolve only visible localized cards, multi-topic ideas appear in each group, no-topic ideas appear in the localized Other group, and database details stay on `cause` while logs retain request ID.

- [ ] **Step 7: Implement public types and DAL**

  Keep `lib/data/knowledge.ts` server-only and wrap exported reads in React `cache` for per-render request deduplication, matching `lib/data/catalog.ts`. Parse every RPC response with Zod, including `knowledgeBlocksSchema`. Build `booksById` from `getBookCards(locale)` and `ideasById` from the published idea index; expose resolved arrays/maps on detail DTOs so `BlockRenderer` never queries.

- [ ] **Step 8: Reset, run suites, regenerate types, and commit**

  ```bash
  supabase db reset --workdir .superpowers/scratch/sbworkdir
  supabase test db --workdir .superpowers/scratch/sbworkdir
  supabase gen types --local --lang typescript --workdir .superpowers/scratch/sbworkdir > lib/supabase/database.types.ts
  npx vitest run lib/data/knowledge.test.ts
  npm run check
  git add supabase/migrations/20260926120000_s12_knowledge_public.sql supabase/tests/053_s12_knowledge_public_search.sql lib/supabase/database.types.ts lib/knowledge/public-types.ts lib/data/knowledge.ts lib/data/knowledge.test.ts
  git commit -m "feat(knowledge): add published read models"
  ```

---

### Task 6: Build localized idea and article index/detail pages

**Files:**
- Create: `components/knowledge/knowledge-link-list.tsx`, `knowledge-link-list.test.tsx`
- Create: `components/knowledge/idea-index.tsx`, `idea-index.test.tsx`
- Create: `components/knowledge/article-index.tsx`, `article-index.test.tsx`
- Create: `app/[lang]/(public)/ideas/page.tsx`, `page.test.tsx`
- Create: `app/[lang]/(public)/ideas/[slug]/page.tsx`, `page.test.tsx`
- Create: `app/[lang]/(public)/articles/page.tsx`, `page.test.tsx`
- Create: `app/[lang]/(public)/articles/[slug]/page.tsx`, `page.test.tsx`
- Modify: `lib/i18n/dictionaries/en.json`, `lib/i18n/dictionaries/vi.json`
- Modify: `components/site-header.tsx`
- Create: `components/site-header.test.tsx`

**Interfaces:**
- Consumes Task 5 DAL DTOs and Task 1 renderer/routes.
- `KnowledgeLinkList` renders idea/article summaries with localized canonical links.
- All four pages are public Server Components; detail pages return 404 for missing locale/entity.

- [ ] **Step 1: Add exact bilingual knowledge copy**

  Add dictionary sections for navigation `ideas` and `articles`; idea/article index titles/descriptions; labels for short answer, related books, related ideas, topics, author, published date; and `otherTopic` (`Other` / `Khác`). Add Ideas and Articles links to `SiteHeader` and extend `current` with both values. Test localized hrefs, current-page state, and the existing locale switch behavior.

- [ ] **Step 2: Write failing index-page tests**

  Idea index tests assert question links grouped under every related topic, one localized Other group, no duplicate inside the same group, and an empty-state message. Article index tests assert reverse chronological order, title/excerpt/author/date, and empty state. Both assert locale validation and fixed index-page metadata.

- [ ] **Step 3: Implement index components and routes**

  Validate locale with `isLocale`/`notFound`, load dictionary and cached index DTOs, render `SiteHeader current`, one H1, semantic grouped sections/lists, and `SiteFooter`. Use `Intl.DateTimeFormat(locale)` for article dates. Index metadata uses `buildPageMetadata` with both fixed locale paths.

- [ ] **Step 4: Write failing idea-detail tests**

  Assert H1 question and short answer are the first article content, followed by `BlockRenderer`, related `BookGrid`, related ideas, then topics in that order. Assert missing localization calls `notFound`; an absent other-locale slug gives the header switcher the other locale home; existing alternate uses its idea path. Assert no empty relation section is rendered.

- [ ] **Step 5: Implement idea detail**

  Reuse `BookGrid`, `KnowledgeLinkList`, `BlockRenderer`, breadcrumb JSON-LD plumbing, and existing layout primitives. Metadata title/description use SEO override then question/short answer and include only existing locale paths. Pass resolved `booksById` and `ideasById` into the renderer.

- [ ] **Step 6: Write failing article-detail tests**

  Assert title, linked/localized author where available, published date, excerpt, blocks, related books, related ideas, and linked topic tags. Assert missing localization/invalid slug 404 and correct alternate fallback.

- [ ] **Step 7: Implement article detail and verify all pages**

  Render title/author/date/excerpt before blocks; related books then ideas then topic tags. Run:

  ```bash
  npx vitest run components/knowledge/idea-index.test.tsx components/knowledge/article-index.test.tsx components/knowledge/knowledge-link-list.test.tsx 'app/[lang]/(public)/ideas' 'app/[lang]/(public)/articles' components/site-header.test.tsx lib/i18n/dictionary.test.ts
  npm run check
  ```

- [ ] **Step 8: Commit public knowledge pages**

  ```bash
  git add components/knowledge/knowledge-link-list.tsx components/knowledge/knowledge-link-list.test.tsx components/knowledge/idea-index.tsx components/knowledge/idea-index.test.tsx components/knowledge/article-index.tsx components/knowledge/article-index.test.tsx 'app/[lang]/(public)/ideas' 'app/[lang]/(public)/articles' components/site-header.tsx components/site-header.test.tsx lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json
  git commit -m "feat(knowledge): add localized public hub pages"
  ```

---

### Task 7: Add knowledge backlinks to book and topic pages

**Files:**
- Modify: `app/[lang]/(public)/books/[slug]/page.tsx`
- Create: `app/[lang]/(public)/books/[slug]/page.test.tsx`
- Modify: `components/catalog/entity-page.tsx`
- Create: `components/catalog/entity-page.test.tsx`
- Modify: `lib/i18n/dictionaries/en.json`, `lib/i18n/dictionaries/vi.json`

**Interfaces:**
- Consumes `getKnowledgeForBook(locale, bookId)` and `getKnowledgeForTopic(locale, topicId)`.
- Renders the Task 6 `KnowledgeLinkList`; author and series pages do not request backlinks.

- [ ] **Step 1: Write failing book-page backlink tests**

  Mock `getBookPage`, action state, and knowledge backlinks. Assert the DAL receives the resolved public `book.bookId`, a mixed Ideas/Articles section links to localized paths, empty results render no heading, and existing purchase/sample/topic/FAQ behavior remains unchanged.

- [ ] **Step 2: Integrate book backlinks**

  Load knowledge links in the existing post-book `Promise.all`, after `getBookPage` has passed its public/missing-locale gate. Render below current descriptive/FAQ content with localized heading `Ideas and articles about this book` / `Ý tưởng và bài viết về cuốn sách này`.

- [ ] **Step 3: Write failing topic-page backlink tests**

  For `kind='topic'`, assert `getKnowledgeForTopic(locale, entity.id)` and render localized links; for author/series, assert no call and no knowledge section. Empty results render nothing. Preserve current metadata, portrait, books, and JSON-LD behavior.

- [ ] **Step 4: Integrate topic backlinks**

  Once `getEntityPage` succeeds, load backlinks only for topics. Render after the existing book grid with heading `Ideas and articles` / `Ý tưởng và bài viết`. Do not merge these links into S11 recommendation shelves; the two components have different DTOs and semantics.

- [ ] **Step 5: Verify and commit the integrations**

  ```bash
  npx vitest run 'app/[lang]/(public)/books/[slug]/page.test.tsx' components/catalog/entity-page.test.tsx lib/data/knowledge.test.ts
  npm run check
  git add 'app/[lang]/(public)/books/[slug]/page.tsx' 'app/[lang]/(public)/books/[slug]/page.test.tsx' components/catalog/entity-page.tsx components/catalog/entity-page.test.tsx lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json
  git commit -m "feat(catalog): link books and topics to knowledge"
  ```

---

### Task 8: Extend search, metadata, JSON-LD, and sitemap

**Files:**
- Modify: `lib/catalog/search.ts`, `lib/catalog/search.test.ts`
- Modify: `lib/data/catalog.ts`, `lib/data/catalog.test.ts`
- Modify: `app/[lang]/(public)/search/page.tsx`
- Create: `app/[lang]/(public)/search/page.test.tsx`
- Modify: `lib/seo/json-ld.ts`, `lib/seo/json-ld.test.ts`
- Modify: `app/[lang]/(public)/ideas/[slug]/page.tsx`, `page.test.tsx`
- Modify: `app/[lang]/(public)/articles/[slug]/page.tsx`, `page.test.tsx`
- Modify: `app/sitemap.ts`, `app/sitemap.test.ts`
- Modify: `lib/i18n/dictionaries/en.json`, `lib/i18n/dictionaries/vi.json`

**Interfaces:**
- Extends `SearchHitKind` to `book|author|series|topic|idea|article` and `CatalogSearchResults` with `ideas`/`articles`.
- Produces `knowledgeArticleSchema(...)` and `ideaFaqSchema(...)` plain serializable objects.
- Sitemap consumes `getKnowledgeSitemapEntries(locale)` returning published localized idea/article paths.

- [ ] **Step 1: Write failing search type/group/page tests**

  Assert `groupSearchHits` preserves deterministic score/name order inside all six groups. Mock the extended RPC response and assert `searchCatalog` maps book hits to cards while returning idea/article hits unchanged. Search page group order must be Books, Authors, Ideas, Articles, Series, Topics, with localized headings and correct knowledge routes. Total count includes both new groups.

- [ ] **Step 2: Implement the search application layer**

  Extend Zod enums/types/grouping and result DTOs. Add idea/article sections to the Server Component after authors and before series/topics. Do not fetch body blocks or render excerpts in the result list; the matched question/title is the link text and the RPC score already considered short answer/excerpt.

- [ ] **Step 3: Write failing Article and FAQPage JSON-LD tests**

  Idea Article schema uses question as headline, short answer as description, page URL, language, and `dateModified` from localization. Article schema uses title, excerpt, author Person, `datePublished`, `dateModified`, URL, and language. Assert internal IDs, SEO-only strings, blocks, and unpublished refs never leak.

  `ideaFaqSchema` must exactly mirror visible hero content:

  ```ts
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [{
      "@type": "Question",
      name: idea.question,
      acceptedAnswer: { "@type": "Answer", text: idea.shortAnswer },
    }],
  }
  ```

  Assert the builder returns null when either visible string is blank, and detail pages include FAQPage only when the Q&A is rendered.

- [ ] **Step 4: Implement structured data on both detail pages**

  Add `Article` JSON-LD for ideas and articles plus breadcrumbs. Idea pages add the non-null FAQ schema to the same `<JsonLd data={[...]}>` payload. Continue using the existing escaping serializer; `BlockRenderer` itself still has no `dangerouslySetInnerHTML`.

- [ ] **Step 5: Write failing sitemap tests**

  Assert localized `/ideas` and `/articles` index URLs are always listed, published localized detail URLs appear once, drafts/missing-locales do not appear, and a failed knowledge read rejects rather than emitting a partial sitemap. Preserve all current catalog URL assertions and the five-minute revalidation export.

- [ ] **Step 6: Implement sitemap entries and run the SEO/search slice**

  Load catalog cards and knowledge entries for each locale, add fixed indexes plus detail paths, deduplicate, and map through `absoluteUrl`. Run:

  ```bash
  npx vitest run lib/catalog/search.test.ts lib/data/catalog.test.ts 'app/[lang]/(public)/search/page.test.tsx' lib/seo/json-ld.test.ts app/sitemap.test.ts 'app/[lang]/(public)/ideas/[slug]/page.test.tsx' 'app/[lang]/(public)/articles/[slug]/page.test.tsx'
  npm run check
  ```

- [ ] **Step 7: Commit search and SEO discovery**

  ```bash
  git add lib/catalog/search.ts lib/catalog/search.test.ts lib/data/catalog.ts lib/data/catalog.test.ts 'app/[lang]/(public)/search/page.tsx' 'app/[lang]/(public)/search/page.test.tsx' lib/seo/json-ld.ts lib/seo/json-ld.test.ts 'app/[lang]/(public)/ideas/[slug]/page.tsx' 'app/[lang]/(public)/ideas/[slug]/page.test.tsx' 'app/[lang]/(public)/articles/[slug]/page.tsx' 'app/[lang]/(public)/articles/[slug]/page.test.tsx' app/sitemap.ts app/sitemap.test.ts lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json
  git commit -m "feat(discovery): index knowledge in search and SEO"
  ```

---

### Task 9: Add end-to-end journeys and the knowledge-hub runbook

**Files:**
- Create: `e2e/knowledge-hub.spec.ts`
- Create: `e2e/support/knowledge.ts`
- Modify: `e2e/support/catalog.ts`
- Create: `docs/runbooks/knowledge-hub.md`
- Modify: `docs/runbooks/testing-environments.md`

**Interfaces:**
- E2E support uses only the local-loopback guarded clients and real authenticated admin RPCs.
- The spec covers the reader search journey, admin idea lifecycle, and locale-missing behavior required by S12.

- [ ] **Step 1: Add local-only E2E knowledge helpers**

  Add helpers that create a confirmed admin, sign into an authenticated Supabase client, call S12 create/localization/relation/publish RPCs, and seed a valid typed paragraph. Extend catalog seeding to return the book/topic/author IDs needed for relations. Never use service role to call admin-only RPCs because `is_admin()` derives identity from `auth.uid()`.

- [ ] **Step 2: Write the failing reader discovery journey**

  Seed/publish a Vietnamese idea with diacritics in its question and one related published book. Search using the same phrase without diacritics, open the Ideas result, assert question and short answer above the body, follow the related book, and assert the book page links back to the idea.

- [ ] **Step 3: Write the failing admin create/relate/publish journey**

  Sign into the real `/internal/en/sign-in` admin flow, create an idea, add one paragraph in the typed editor, select a related book/topic/idea, save SEO, publish, and assert one audit row for each submitted mutation. Visit the public URL and assert no literal markup/script from an attempted HTML value can be stored or rendered.

- [ ] **Step 4: Add the missing-locale and language-switch assertion**

  Create an English-only published idea. Assert `/vi/ideas/{enSlug}` returns 404; on the English page, assert the `hreflang="vi"` switch points to `/vi`, not a fabricated Vietnamese idea URL. Also assert the English canonical and sitemap entry exist while the Vietnamese detail entry does not.

- [ ] **Step 5: Run the focused E2E file against local Supabase**

  Export the exact Supabase/Mailpit variables from `docs/runbooks/testing-environments.md`, then run:

  ```bash
  npm run test:e2e -- e2e/knowledge-hub.spec.ts
  ```

  Expected before implementation: FAIL because the admin/public knowledge routes do not exist. Expected after Tasks 1–8: PASS with no skipped tests.

- [ ] **Step 6: Write the operator runbook**

  Document:

  - Choosing an idea for one answerable life question versus an article for broader editorial writing.
  - Creating localizations, adding/reordering every block type, and using only absolute external links.
  - Uploading a knowledge image and writing meaningful alt text.
  - Quoting a book: 300 grapheme clusters including Vietnamese combining marks/emoji, required book attribution, and optional locator label.
  - Relating/reordering books and ideas, choosing topics, reading readiness, publishing/unpublishing, and verifying both locales.
  - Slug redirects, search expectations, cache revalidation, sitemap/JSON-LD checks, and why missing translations return 404.
  - Local-only test commands and warnings against database reset, fixtures, or admin writes on the cloud project.

  Add the runbook to the testing-environment documentation's relevant-runbooks list without changing any safety rule.

- [ ] **Step 7: Run the complete final gates**

  If this repository owns the default 543xx stack:

  ```bash
  npm run db:reset
  npm run db:test
  npm run check
  npm run check:full
  git diff --check
  ```

  If another project owns 543xx, use:

  ```bash
  supabase db reset --workdir .superpowers/scratch/sbworkdir
  supabase test db --workdir .superpowers/scratch/sbworkdir
  npm run check
  npm run check:full
  git diff --check
  ```

  Confirm the pgTAP plan counts, unit-test count, and ordinary Playwright count increase by the committed S12 tests; investigate any skip rather than accepting a green exit code.

- [ ] **Step 8: Commit acceptance coverage and documentation**

  ```bash
  git add e2e/knowledge-hub.spec.ts e2e/support/knowledge.ts e2e/support/catalog.ts docs/runbooks/knowledge-hub.md docs/runbooks/testing-environments.md
  git commit -m "test(knowledge): cover editorial and reader journeys"
  ```

## Self-Review Results

- **Spec coverage:** Tasks 1–3 cover typed blocks, no-HTML storage/rendering, quote limits/attribution, schema, real foreign keys, RLS, readiness, audit, publishing, and redirects. Tasks 4–7 cover both admin editors, uploads, all public pages, localized 404s, relations, and book/topic backlinks. Task 8 covers lexical search, canonical/hreflang metadata, Article/FAQ JSON-LD, and sitemap. Task 9 covers all required Playwright journeys and the runbook.
- **Resolved ambiguity:** FAQPage mirrors the always-visible idea question/short answer; actual route prefixes define slug namespaces; first publication fixes article chronology; multi-topic ideas appear in each group; invalidated book-backed blocks fail closed by rendering nothing.
- **Type consistency:** Stored blocks use `bookId`/`ideaId` in TypeScript and `book_id`/`idea_id` only in SQL; RPC arguments use snake_case generated names; public DTOs use camelCase; every later task consumes the exact types/functions defined earlier.
- **Security check:** All admin actions reauthorize, service role is image-signing-only after entity verification, public RPCs filter status/locale explicitly, storage keys are server-minted, raw HTML has neither a schema path nor renderer branch, and JSON-LD uses the existing escaping serializer.
- **Scope check:** No graph visualization, extraction, embeddings, body indexing, social features, collections, or `ja` locale enters the plan.
- **Placeholder scan:** Every in-scope behavior has an exact file owner, interface, red test, implementation action, verification command, and commit boundary; no deferred marker remains.
