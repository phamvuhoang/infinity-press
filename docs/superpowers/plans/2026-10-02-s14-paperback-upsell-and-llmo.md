# S14 Paperback Upsell and LLMO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show paperback retailer links on every book page with matching multi-Offer structured data and click analytics, publish `/llms.txt`, and complete the knowledge JSON-LD with author, publisher, and dates.

**Architecture:** One new table `book_retail_links` behind RLS, read through the existing `catalog_book_page` RPC and written through one audited admin RPC that replaces the set. The book page renders the links on the server, decorates them with UTM parameters through a pure helper, and a tiny client button sends a new browser analytics event. `bookSchema` grows an `offers` array. `/llms.txt` is a Route Handler built from the same published-only loaders the sitemap uses.

**Tech Stack:** Next.js 16.3 App Router, React 19 Server Components and Server Actions, Supabase/Postgres/RLS, TypeScript 6, Zod 4, Vitest 5, pgTAP, Playwright 1.63, Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-10-02-s14-paperback-upsell-and-llmo-design.md`

## Global Constraints

- Read the local Next.js 16 guides before changing framework code: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (Route Handlers), `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `node_modules/next/dist/docs/01-app/01-getting-started/09-revalidating.md`.
- Customer routes stay under `/{locale}` for exactly `vi` and `en`; `/admin` remains unprefixed. `/llms.txt` is a root route like `/sitemap.xml`.
- Every admin page and Server Action calls `requireAdmin()` itself. Never expose `SUPABASE_SERVICE_ROLE_KEY` to browser code.
- Retailer values are exactly `shopee`, `fahasa`, `tiki`, `other`. `label` is required when and only when `retailer = 'other'`. `price_minor` and `currency` are both set or both null.
- Stored URLs are absolute `https://` only, matching `^https://[^\s]+$` in SQL and `z.url({ protocol: /^https$/ })` in Zod. UTM parameters are appended at render time and never stored. A URL that already has any `utm_*` parameter is left untouched.
- Outbound links render with `target="_blank"` and `rel="nofollow noopener sponsored"`.
- The new analytics event is `click_external_store`. `analytics_events` gains `retailer text` constrained to the four values; there is still no JSON property column. The event is anonymous-allowed (not session-bound).
- `bookSchema` emits `offers` as an array only when at least one Offer exists. The paperback Offer never has `price` unless `price_minor` is set.
- `CatalogBookPage` gains `retailLinks: CatalogRetailLink[]` and `isbn: string | null`. Both come from `catalog_book_page` so the page keeps one round trip.
- `/llms.txt` lists only published entities for both locales, Vietnamese first, with descriptions truncated to 200 characters at a word boundary.
- There are no cache tags in this codebase. Every mutation goes through `revalidateBookAdmin(bookId)`; `revalidateStorefront()` gains `revalidatePath("/llms.txt")`.
- Migrations begin at `20260928100000`; pgTAP files use `057` and `058`. Applied migrations are never edited. Regenerate `lib/supabase/database.types.ts` with `npx supabase gen types typescript --local > lib/supabase/database.types.ts` after each migration task against a reset local stack.
- Dictionary keys are added to both `lib/i18n/dictionaries/en.json` and `vi.json`; `lib/i18n/dictionary.test.ts` enforces parity.
- Run database and Playwright suites only against local Supabase per `docs/runbooks/testing-environments.md`. Use Node.js 22. The final gate is `npm run check`, `npm run db:test`, and `npm run check:full`.

## Review Focus

1. A stored affiliate URL with its own `utm_source` must not be rewritten; `withRetailUtm` leaves any URL with a `utm_*` key untouched. Pinned in Task 3.
2. A URL with a fragment (`https://shopee.vn/x#reviews`) must keep the fragment after the query string. Pinned in Task 3.
3. A book whose edition has no ISBN must emit a paperback Offer without `isbn` rather than `isbn: null`. Pinned in Task 4.
4. A `click_external_store` beacon with an unknown retailer must be a 400 and never reach the table. Pinned in Task 2.
5. `/llms.txt` with a book whose short description contains a newline must emit one line per entity. Pinned in Task 7.

## File Structure

| Area | Files and responsibility |
| --- | --- |
| Schema and read model | `supabase/migrations/20260928100000_s14_retail_links.sql`, `supabase/tests/057_s14_retail_links.sql`: table, RLS, admin RPC, `catalog_book_page` extension. |
| Analytics | `supabase/migrations/20260928110000_s14_click_external_store.sql`, `supabase/tests/058_s14_click_external_store.sql`, `lib/analytics/events.ts`, `lib/analytics/browser.ts`, `app/api/analytics/events/route.ts` and test. |
| Retail contract | `lib/catalog/retail.ts` and test: retailer list, UTM helper, Zod schema. `lib/catalog/public-types.ts`, `lib/data/catalog.ts`: DTO and parsing. |
| Structured data | `lib/seo/json-ld.ts` and test: multi-Offer Book, knowledge author/publisher/dates. |
| Public page | `components/catalog/retail-link-button.tsx` and test, `app/[lang]/(public)/books/[slug]/page.tsx`, dictionaries. |
| Admin | `lib/data/books.ts`, `lib/catalog/schemas.ts`, `app/admin/books/[bookId]/editor-actions.ts`, `components/admin/book-editor/retail-links-form.tsx` and test, `app/admin/books/[bookId]/page.tsx`. |
| llms.txt | `app/llms.txt/route.ts` and test, `lib/seo/llms.ts` and test, `lib/catalog/revalidate.ts`, dictionaries. |
| Article page | `app/[lang]/(public)/articles/[slug]/page.tsx`, dictionaries. |
| Verification | `e2e/paperback-upsell.spec.ts`, `docs/runbooks/catalog-admin.md`, `docs/runbooks/seo-and-operations.md`. |

---

### Task 1: Retail links schema, public read, and admin RPC

**Files:**
- Create: `supabase/migrations/20260928100000_s14_retail_links.sql`
- Create: `supabase/tests/057_s14_retail_links.sql`
- Modify: `lib/supabase/database.types.ts` (regenerate)

**Interfaces:**
- Produces table `public.book_retail_links`.
- Produces `public.admin_set_book_retail_links(p_book_id uuid, p_links jsonb) returns void`. `p_links` is a JSON array of `{ retailer, label, url, priceMinor, currency, active }`; position is the array order.
- Produces `catalog_book_page` JSON keys `retailLinks` (array of `{ id, retailer, label, url, priceMinor, currency }` in position order, active only) and `isbn` (string or null).

- [ ] **Step 1: Write the failing pgTAP file**

```sql
begin;
select plan(22);

-- S14: retail links are readable only for published books and active rows, written only by the
-- audited admin RPC, and surfaced by catalog_book_page in position order.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1400000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's14-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1400000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's14-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1400000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1430000-0000-0000-0000-000000000001', 's14-author', 'S14 Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e1420000-0000-0000-0000-000000000001', 's14-book-published', 'vi', 'e1430000-0000-0000-0000-000000000001', 'published'),
  ('e1420000-0000-0000-0000-000000000002', 's14-book-draft', 'vi', 'e1430000-0000-0000-0000-000000000001', 'draft');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e1420000-0000-0000-0000-000000000001', 'vi', 's14-book-published', 'Sách S14'),
  ('e1420000-0000-0000-0000-000000000002', 'vi', 's14-book-draft', 'Sách nháp S14');
insert into public.editions (id, book_id, language_code, isbn)
values ('e1450000-0000-0000-0000-000000000001', 'e1420000-0000-0000-0000-000000000001', 'vi', '9786040000001');

-- Table shape --------------------------------------------------------------------------------
select has_table('public', 'book_retail_links', 'book_retail_links exists');
select col_is_unique('public', 'book_retail_links', array['book_id', 'position'], 'position is unique per book');

select throws_ok(
  $$insert into public.book_retail_links (book_id, retailer, url, position) values ('e1420000-0000-0000-0000-000000000001', 'amazon', 'https://a.example', 1)$$,
  '23514', null, 'an unknown retailer is refused');
select throws_ok(
  $$insert into public.book_retail_links (book_id, retailer, url, position) values ('e1420000-0000-0000-0000-000000000001', 'shopee', 'http://shopee.vn/x', 1)$$,
  '23514', null, 'a non-https url is refused');
select throws_ok(
  $$insert into public.book_retail_links (book_id, retailer, url, position) values ('e1420000-0000-0000-0000-000000000001', 'other', 'https://x.example', 1)$$,
  '23514', null, 'retailer other needs a label');
select throws_ok(
  $$insert into public.book_retail_links (book_id, retailer, label, url, position) values ('e1420000-0000-0000-0000-000000000001', 'shopee', 'Shopee', 'https://x.example', 1)$$,
  '23514', null, 'a named retailer must not carry a label');
select throws_ok(
  $$insert into public.book_retail_links (book_id, retailer, url, price_minor, position) values ('e1420000-0000-0000-0000-000000000001', 'shopee', 'https://x.example', 1000, 1)$$,
  '23514', null, 'price without currency is refused');

-- Admin RPC ----------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1400000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.admin_set_book_retail_links('e1420000-0000-0000-0000-000000000001', '[]'::jsonb)$$,
  '42501', null, 'a reader cannot set retail links');
select throws_ok(
  $$insert into public.book_retail_links (book_id, retailer, url, position) values ('e1420000-0000-0000-0000-000000000001', 'shopee', 'https://x.example', 1)$$,
  '42501', null, 'a reader cannot insert retail links directly');

select set_config('request.jwt.claim.sub', 'e1400000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_set_book_retail_links('e1420000-0000-0000-0000-000000000001', '[
      {"retailer":"tiki","label":null,"url":"https://tiki.vn/s14","priceMinor":null,"currency":null,"active":true},
      {"retailer":"shopee","label":null,"url":"https://shopee.vn/s14","priceMinor":129000,"currency":"VND","active":true},
      {"retailer":"other","label":"Nhà sách ABC","url":"https://abc.example/s14","priceMinor":null,"currency":null,"active":false}
    ]'::jsonb)$$,
  'an admin replaces the set');
select results_eq(
  $$select retailer, position from public.book_retail_links where book_id = 'e1420000-0000-0000-0000-000000000001' order by position$$,
  $$values ('tiki', 1), ('shopee', 2), ('other', 3)$$,
  'positions follow array order');
select results_eq(
  $$select count(*) from public.audit_logs where action = 'book.retail_links.set' and entity_id = 'e1420000-0000-0000-0000-000000000001'$$,
  array[1::bigint], 'one audit row per set');
select throws_ok(
  $$select public.admin_set_book_retail_links('e1420000-0000-0000-0000-000000000001', '[{"retailer":"shopee","label":null,"url":"ftp://x","priceMinor":null,"currency":null,"active":true}]'::jsonb)$$,
  '22023', null, 'a bad url in the payload is refused before any delete');
select results_eq(
  $$select count(*) from public.book_retail_links where book_id = 'e1420000-0000-0000-0000-000000000001'$$,
  array[3::bigint], 'a refused payload leaves the existing set intact');
select throws_ok(
  $$select public.admin_set_book_retail_links('e1420000-0000-0000-0000-00000000ffff', '[]'::jsonb)$$,
  'P0002', null, 'a missing book is P0002');

-- Public read --------------------------------------------------------------------------------
reset role;
set local role anon;
select results_eq(
  $$select count(*) from public.book_retail_links$$,
  array[2::bigint], 'anon sees only active links of published books');
select is(
  (select jsonb_array_length(public.catalog_book_page('vi', 's14-book-published') -> 'retailLinks')),
  2, 'catalog_book_page lists the two active links');
select is(
  (select public.catalog_book_page('vi', 's14-book-published') -> 'retailLinks' -> 0 ->> 'retailer'),
  'tiki', 'links keep position order');
select is(
  (select public.catalog_book_page('vi', 's14-book-published') -> 'retailLinks' -> 1 ->> 'priceMinor'),
  '129000', 'price is carried');
select is(
  (select public.catalog_book_page('vi', 's14-book-published') ->> 'isbn'),
  '9786040000001', 'isbn comes from the edition');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1400000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_set_book_retail_links('e1420000-0000-0000-0000-000000000002', '[{"retailer":"shopee","label":null,"url":"https://shopee.vn/draft","priceMinor":null,"currency":null,"active":true}]'::jsonb)$$,
  'a draft book can hold links');
reset role;
set local role anon;
select results_eq(
  $$select count(*) from public.book_retail_links where book_id = 'e1420000-0000-0000-0000-000000000002'$$,
  array[0::bigint], 'a draft book''s links are invisible');
reset role;

select is(has_function_privilege('anon', 'public.admin_set_book_retail_links(uuid, jsonb)', 'EXECUTE'), false, 'anon cannot execute the admin RPC');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:reset && npm run db:test -- supabase/tests/057_s14_retail_links.sql`
Expected: FAIL at `has_table`.

- [ ] **Step 3: Write the migration**

```sql
-- S14: paperback retailer links (spec section 5), the audited admin write path (section 7), and
-- the catalog_book_page extension that carries them to the book page in the same round trip.

create table public.book_retail_links (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  retailer text not null check (retailer in ('shopee', 'fahasa', 'tiki', 'other')),
  label text check (label is null or length(btrim(label)) between 1 and 80),
  url text not null check (url ~ '^https://[^\s]+$'),
  price_minor bigint check (price_minor is null or price_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  position integer not null check (position > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, position),
  check ((retailer = 'other') = (label is not null)),
  check ((price_minor is null) = (currency is null))
);

create trigger book_retail_links_touch_updated_at
  before update on public.book_retail_links
  for each row execute function public.touch_updated_at();

alter table public.book_retail_links enable row level security;

revoke all on public.book_retail_links from public, anon, authenticated;
grant select on public.book_retail_links to anon, authenticated;

create policy "public reads active links of published books" on public.book_retail_links
  for select to anon, authenticated
  using (
    active
    and exists (select 1 from public.books b where b.id = book_retail_links.book_id and b.status = 'published')
  );

create policy "admin reads retail links" on public.book_retail_links
  for select to authenticated
  using (public.is_admin());

-- Replaces the whole set. Positions are the array order, 1..N. Validated before the delete so a
-- bad payload leaves the existing set exactly as it was (the admin_set_related_books rule).
create function public.admin_set_book_retail_links(p_book_id uuid, p_links jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_row jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin_set_book_retail_links: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'admin_set_book_retail_links: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  if p_links is null or jsonb_typeof(p_links) <> 'array' then
    raise exception 'admin_set_book_retail_links: links must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_links) > 10 then
    raise exception 'admin_set_book_retail_links: at most 10 links per book' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_links) loop
    if (v_row ->> 'retailer') is null or (v_row ->> 'retailer') not in ('shopee', 'fahasa', 'tiki', 'other') then
      raise exception 'admin_set_book_retail_links: unknown retailer' using errcode = '22023';
    end if;
    if (v_row ->> 'url') is null or (v_row ->> 'url') !~ '^https://[^\s]+$' then
      raise exception 'admin_set_book_retail_links: url must be absolute https' using errcode = '22023';
    end if;
    if ((v_row ->> 'retailer') = 'other') <> ((v_row ->> 'label') is not null and length(btrim(v_row ->> 'label')) > 0) then
      raise exception 'admin_set_book_retail_links: label is required exactly for retailer other' using errcode = '22023';
    end if;
    if ((v_row ->> 'priceMinor') is null) <> ((v_row ->> 'currency') is null) then
      raise exception 'admin_set_book_retail_links: price and currency go together' using errcode = '22023';
    end if;
  end loop;

  delete from public.book_retail_links where book_id = p_book_id;
  insert into public.book_retail_links (book_id, retailer, label, url, price_minor, currency, position, active)
  select
    p_book_id,
    l.value ->> 'retailer',
    nullif(btrim(l.value ->> 'label'), ''),
    l.value ->> 'url',
    (l.value ->> 'priceMinor')::bigint,
    l.value ->> 'currency',
    l.ord,
    coalesce((l.value ->> 'active')::boolean, true)
  from jsonb_array_elements(p_links) with ordinality as l(value, ord);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'book.retail_links.set', 'books', p_book_id,
          jsonb_build_object('count', jsonb_array_length(p_links)));
end;
$$;

revoke execute on function public.admin_set_book_retail_links(uuid, jsonb) from public, anon;
grant execute on function public.admin_set_book_retail_links(uuid, jsonb) to authenticated;

-- catalog_book_page: two new keys. Everything else is 20260915100000's body unchanged.
create or replace function public.catalog_book_page(p_locale text, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'bookId', b.id,
    'description', bl.description,
    'audience', bl.audience,
    'keyIdeas', bl.key_ideas,
    'faq', bl.faq,
    'seoTitle', bl.seo_title,
    'seoDescription', bl.seo_description,
    'alternateSlug', (
      select other.slug from public.book_localizations other
      where other.book_id = b.id and other.locale <> bl.locale
    ),
    'isbn', (
      select e.isbn from public.editions e
      where e.book_id = b.id and e.isbn is not null
      order by e.language_code = p_locale desc, e.edition_number
      limit 1
    ),
    'retailLinks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rl.id,
        'retailer', rl.retailer,
        'label', rl.label,
        'url', rl.url,
        'priceMinor', rl.price_minor,
        'currency', rl.currency
      ) order by rl.position)
      from public.book_retail_links rl
      where rl.book_id = b.id and rl.active
    ), '[]'::jsonb)
  )
  from public.book_localizations bl
  join public.books b on b.id = bl.book_id
  where bl.locale = p_locale and bl.slug = p_slug and b.status = 'published';
$$;
```

If `public.touch_updated_at()` does not exist under that name, grep `supabase/migrations/20260927100000_s12_knowledge_schema.sql` for the trigger function the knowledge tables use and call that one.

- [ ] **Step 4: Run the test and regenerate types**

Run: `npm run db:reset && npm run db:test -- supabase/tests/057_s14_retail_links.sql && npx supabase gen types typescript --local > lib/supabase/database.types.ts`
Expected: 22 passing. `git diff --stat lib/supabase/database.types.ts` shows the new table and function.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260928100000_s14_retail_links.sql supabase/tests/057_s14_retail_links.sql lib/supabase/database.types.ts
git commit -m "feat(s14): book retail links schema, admin RPC, and catalog read"
```

---

### Task 2: `click_external_store` analytics event

**Files:**
- Create: `supabase/migrations/20260928110000_s14_click_external_store.sql`
- Create: `supabase/tests/058_s14_click_external_store.sql`
- Modify: `lib/analytics/events.ts`
- Modify: `lib/analytics/browser.ts`
- Modify: `app/api/analytics/events/route.ts`
- Modify: `app/api/analytics/events/route.test.ts`
- Modify: `lib/supabase/database.types.ts` (regenerate)

**Interfaces:**
- Produces `BrowserEventInput` member `{ eventName: "click_external_store"; bookId: string; retailer: Retailer; locale: Locale }` where `Retailer = "shopee" | "fahasa" | "tiki" | "other"`.
- Produces `TrackEventInput.retailer?: Retailer`.
- Produces `export const retailers = ["shopee", "fahasa", "tiki", "other"] as const` in `lib/analytics/browser.ts` (browser-safe; `lib/catalog/retail.ts` re-exports it in Task 3).

- [ ] **Step 1: Write the failing pgTAP file**

```sql
begin;
select plan(3);

select has_column('public', 'analytics_events', 'retailer', 'analytics_events has a retailer column');
select lives_ok(
  $$insert into public.analytics_events (event_name, retailer, locale) values ('click_external_store', 'shopee', 'vi')$$,
  'click_external_store with a known retailer is accepted');
select throws_ok(
  $$insert into public.analytics_events (event_name, retailer, locale) values ('click_external_store', 'amazon', 'vi')$$,
  '23514', null, 'an unknown retailer is refused');

select * from finish();
rollback;
```

- [ ] **Step 2: Write the migration**

```sql
-- S14: the browser reports a click on a paperback retailer link. The retailer is a constrained
-- column, not a JSON property: the table keeps its no-free-text rule.
alter table public.analytics_events
  add column retailer text check (retailer is null or retailer in ('shopee', 'fahasa', 'tiki', 'other'));

alter table public.analytics_events
  drop constraint analytics_events_event_name_check,
  add constraint analytics_events_event_name_check check (event_name in (
    'view_book', 'open_sample', 'begin_checkout', 'purchase', 'payment_failed',
    'open_reader', 'progress_25', 'progress_50', 'progress_75', 'progress_100',
    'change_reader_setting', 'view_library', 'book_published',
    'epub_job_started', 'epub_job_completed', 'epub_job_failed',
    'click_external_store'
  ));
```

If the existing constraint has a different name, read it with `select conname from pg_constraint where conrelid = 'public.analytics_events'::regclass and contype = 'c';` against the local stack and use that name.

- [ ] **Step 3: Run pgTAP and regenerate types**

Run: `npm run db:reset && npm run db:test -- supabase/tests/058_s14_click_external_store.sql && npx supabase gen types typescript --local > lib/supabase/database.types.ts`
Expected: 3 passing.

- [ ] **Step 4: Write the failing route test**

Add to `app/api/analytics/events/route.test.ts`, following its existing pattern for a valid anonymous `view_book` post:

```ts
it("accepts click_external_store with a known retailer from an anonymous browser", async () => {
  const response = await POST(request({ eventName: "click_external_store", eventId: crypto.randomUUID(), bookId: BOOK_ID, retailer: "shopee", locale: "vi" }));
  expect(response.status).toBe(202);
  expect(trackEventBestEffort).toHaveBeenCalledWith(expect.objectContaining({ eventName: "click_external_store", retailer: "shopee", bookId: BOOK_ID }), expect.anything());
});

it("refuses click_external_store with an unknown retailer", async () => {
  const response = await POST(request({ eventName: "click_external_store", eventId: crypto.randomUUID(), bookId: BOOK_ID, retailer: "amazon", locale: "vi" }));
  expect(response.status).toBe(400);
  expect(trackEventBestEffort).not.toHaveBeenCalled();
});
```

Use the file's existing `request()` helper and `BOOK_ID` constant names; if they differ, match the file.

- [ ] **Step 5: Run to verify failure**

Run: `npx vitest run app/api/analytics/events/route.test.ts`
Expected: FAIL, 400 on the first test.

- [ ] **Step 6: Implement**

`lib/analytics/browser.ts`:

```ts
export const retailers = ["shopee", "fahasa", "tiki", "other"] as const;
export type Retailer = (typeof retailers)[number];

export type BrowserEventInput =
  | { eventName: "view_book" | "open_sample"; bookId: string; locale: Locale }
  | { eventName: "click_external_store"; bookId: string; retailer: Retailer; locale: Locale }
  | { eventName: "open_reader"; bookId: string; publicationId: string; locale: Locale }
  | { eventName: "change_reader_setting"; bookId: string; publicationId?: string; locale: Locale }
  | { eventName: "view_library"; locale: Locale };
```

`lib/analytics/events.ts`: add `"click_external_store"` to `analyticsEventNames`, `retailer?: Retailer` to `TrackEventInput` (import the type from browser.ts), and in `toRow`: `if (input.retailer !== undefined) row.retailer = input.retailer;`.

`app/api/analytics/events/route.ts`: add to the discriminated union:

```ts
z.strictObject({ eventName: z.literal("click_external_store"), bookId: id, retailer: z.enum(retailers), ...common }),
```

importing `retailers` from `@/lib/analytics/browser`. It is not added to `sessionBoundEvents`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run app/api/analytics/events/route.test.ts lib/analytics`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260928110000_s14_click_external_store.sql supabase/tests/058_s14_click_external_store.sql lib/analytics lib/supabase/database.types.ts app/api/analytics/events
git commit -m "feat(s14): click_external_store analytics event"
```

---

### Task 3: Retail contract, DTO, and catalog parsing

**Files:**
- Create: `lib/catalog/retail.ts`
- Create: `lib/catalog/retail.test.ts`
- Modify: `lib/catalog/public-types.ts`
- Modify: `lib/data/catalog.ts`
- Modify: `lib/seo/json-ld.test.ts` (fixture gains `retailLinks: []`, `isbn: null`), and any other test fixture typed `CatalogBookPage` (grep `alternateSlug:` in `*.test.ts*`).

**Interfaces:**
- Produces `CatalogRetailLink = { id: string; retailer: Retailer; label: string | null; url: string; priceMinor: number | null; currency: string | null }`.
- Produces `CatalogBookPage.retailLinks: CatalogRetailLink[]` and `CatalogBookPage.isbn: string | null`.
- Produces `withRetailUtm(url: string, locale: Locale): string`.
- Produces `retailLinkSchema` and `retailLinksSchema` (Zod) for the admin action in Task 6.
- Produces `retailerLabel(link, labels)` returning the display label.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { retailLinksSchema, retailerLabel, withRetailUtm } from "@/lib/catalog/retail";

describe("withRetailUtm", () => {
  it("appends the four utm parameters", () => {
    expect(withRetailUtm("https://shopee.vn/x?y=1", "vi")).toBe(
      "https://shopee.vn/x?y=1&utm_source=infinitybooks&utm_medium=book_page&utm_campaign=paperback&utm_content=vi",
    );
  });
  it("leaves a url that already carries any utm parameter untouched", () => {
    const affiliate = "https://shopee.vn/x?utm_source=aff&aff_id=9";
    expect(withRetailUtm(affiliate, "en")).toBe(affiliate);
  });
  it("keeps a fragment after the query string", () => {
    expect(withRetailUtm("https://tiki.vn/x#reviews", "en")).toBe(
      "https://tiki.vn/x?utm_source=infinitybooks&utm_medium=book_page&utm_campaign=paperback&utm_content=en#reviews",
    );
  });
  it("returns a non-https url unchanged rather than throwing", () => {
    expect(withRetailUtm("not a url", "vi")).toBe("not a url");
  });
});

describe("retailLinksSchema", () => {
  const base = { retailer: "shopee", label: null, url: "https://shopee.vn/x", priceMinor: null, currency: null, active: true };
  it("accepts a plain link", () => {
    expect(retailLinksSchema.safeParse({ links: [base] }).success).toBe(true);
  });
  it("requires a label only for other", () => {
    expect(retailLinksSchema.safeParse({ links: [{ ...base, retailer: "other" }] }).success).toBe(false);
    expect(retailLinksSchema.safeParse({ links: [{ ...base, retailer: "other", label: "ABC" }] }).success).toBe(true);
    expect(retailLinksSchema.safeParse({ links: [{ ...base, label: "ABC" }] }).success).toBe(false);
  });
  it("rejects http and price without currency", () => {
    expect(retailLinksSchema.safeParse({ links: [{ ...base, url: "http://shopee.vn/x" }] }).success).toBe(false);
    expect(retailLinksSchema.safeParse({ links: [{ ...base, priceMinor: 1000 }] }).success).toBe(false);
  });
  it("caps at 10 links", () => {
    expect(retailLinksSchema.safeParse({ links: Array.from({ length: 11 }, () => base) }).success).toBe(false);
  });
});

describe("retailerLabel", () => {
  const labels = { shopee: "Shopee", fahasa: "Fahasa", tiki: "Tiki" };
  it("uses the dictionary for named retailers and the stored label for other", () => {
    expect(retailerLabel({ retailer: "tiki", label: null }, labels)).toBe("Tiki");
    expect(retailerLabel({ retailer: "other", label: "Nhà sách ABC" }, labels)).toBe("Nhà sách ABC");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/catalog/retail.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/catalog/retail.ts`**

```ts
import { z } from "zod";

import { retailers, type Retailer } from "@/lib/analytics/browser";
import type { Locale } from "@/lib/i18n/config";

export { retailers, type Retailer };

const UTM = { utm_source: "infinitybooks", utm_medium: "book_page", utm_campaign: "paperback" } as const;

// Appends the site's UTM set unless the stored URL already carries any utm_* key: an affiliate
// URL has its own tracking and must not be corrupted. Never throws - a bad stored URL is the
// admin RPC's problem, and the button must still render.
export function withRetailUtm(url: string, locale: Locale): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "https:") return url;
  for (const key of parsed.searchParams.keys()) if (key.startsWith("utm_")) return url;
  for (const [key, value] of Object.entries(UTM)) parsed.searchParams.set(key, value);
  parsed.searchParams.set("utm_content", locale);
  return parsed.toString();
}

export function retailerLabel(
  link: { retailer: Retailer; label: string | null },
  labels: Record<Exclude<Retailer, "other">, string>,
): string {
  return link.retailer === "other" ? (link.label ?? "") : labels[link.retailer];
}

export const retailLinkSchema = z
  .object({
    retailer: z.enum(retailers),
    label: z.string().trim().min(1).max(80).nullable(),
    url: z.url({ protocol: /^https$/, error: "Enter an absolute https:// URL." }),
    priceMinor: z.number().int().min(0).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    active: z.boolean(),
  })
  .refine((link) => (link.retailer === "other") === (link.label !== null), {
    message: "A label is required exactly when the retailer is Other.",
    path: ["label"],
  })
  .refine((link) => (link.priceMinor === null) === (link.currency === null), {
    message: "Price and currency go together.",
    path: ["priceMinor"],
  });

export const retailLinksSchema = z.object({ links: z.array(retailLinkSchema).max(10) });
export type RetailLinkInput = z.infer<typeof retailLinkSchema>;
```

`lib/catalog/public-types.ts`:

```ts
import type { Retailer } from "@/lib/analytics/browser";

export type CatalogRetailLink = {
  id: string;
  retailer: Retailer;
  label: string | null;
  url: string;
  priceMinor: number | null;
  currency: string | null;
};

export type CatalogBookPage = CatalogBookCard & {
  // ...existing fields
  isbn: string | null;
  // Active links of a published book, in editorial order. The URL is the stored one; the page
  // decorates it with UTM parameters at render time.
  retailLinks: CatalogRetailLink[];
};
```

`lib/data/catalog.ts` `bookPageSchema` gains:

```ts
isbn: z.string().nullable().catch(null),
retailLinks: z
  .array(
    z.object({
      id: z.string(),
      retailer: z.enum(retailers),
      label: z.string().nullable(),
      url: z.string(),
      priceMinor: z.number().nullable(),
      currency: z.string().nullable(),
    }),
  )
  .catch([]),
```

- [ ] **Step 4: Fix fixtures and run**

Add `isbn: null, retailLinks: []` to every `CatalogBookPage` literal in tests (`grep -rl "alternateSlug:" --include=*.test.ts* lib app components`).
Run: `npx vitest run lib/catalog lib/data/catalog.test.ts lib/seo && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/catalog/retail.ts lib/catalog/retail.test.ts lib/catalog/public-types.ts lib/data/catalog.ts lib/seo/json-ld.test.ts
git commit -m "feat(s14): retail link contract and catalog DTO"
```

---

### Task 4: Structured data: multi-Offer Book and complete knowledge Article

**Files:**
- Modify: `lib/seo/json-ld.ts`
- Modify: `lib/seo/json-ld.test.ts`

**Interfaces:**
- `bookSchema` keeps its signature. Output `offers` is `Offer[]` when non-empty, absent otherwise.
- `knowledgeArticleSchema` keeps its signature.

- [ ] **Step 1: Write the failing tests**

```ts
describe("bookSchema offers", () => {
  const siteOrg = { "@type": "Organization", name: "Infinity Books", url: "https://books.example" };

  it("emits an array with the ebook offer and one paperback offer per retail link", () => {
    const withLinks: CatalogBookPage = {
      ...book,
      isbn: "9786040000001",
      retailLinks: [
        { id: "l1", retailer: "shopee", label: null, url: "https://shopee.vn/x", priceMinor: 129000, currency: "VND" },
        { id: "l2", retailer: "other", label: "Nhà sách ABC", url: "https://abc.example/x", priceMinor: null, currency: null },
      ],
    };
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/harbour-lights", book: withLinks, paymentsEnabled: true });
    expect(schema.offers).toEqual([
      expect.objectContaining({ "@type": "Offer", price: "0", priceCurrency: "VND", seller: siteOrg, itemOffered: { "@type": "Book", bookFormat: "https://schema.org/EBook" } }),
      {
        "@type": "Offer",
        url: "https://shopee.vn/x?utm_source=infinitybooks&utm_medium=book_page&utm_campaign=paperback&utm_content=vi",
        availability: "https://schema.org/InStock",
        price: "129000",
        priceCurrency: "VND",
        seller: { "@type": "Organization", name: "Shopee" },
        itemOffered: { "@type": "Book", bookFormat: "https://schema.org/Paperback", isbn: "9786040000001" },
      },
      {
        "@type": "Offer",
        url: "https://abc.example/x?utm_source=infinitybooks&utm_medium=book_page&utm_campaign=paperback&utm_content=vi",
        availability: "https://schema.org/InStock",
        seller: { "@type": "Organization", name: "Nhà sách ABC" },
        itemOffered: { "@type": "Book", bookFormat: "https://schema.org/Paperback", isbn: "9786040000001" },
      },
    ]);
  });

  it("omits isbn on the paperback when the edition has none", () => {
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/x", paymentsEnabled: true,
      book: { ...book, isbn: null, retailLinks: [{ id: "l1", retailer: "tiki", label: null, url: "https://tiki.vn/x", priceMinor: null, currency: null }] } });
    const paperback = (schema.offers as Record<string, unknown>[])[1];
    expect(paperback.itemOffered).toEqual({ "@type": "Book", bookFormat: "https://schema.org/Paperback" });
    expect(paperback).not.toHaveProperty("price");
  });

  it("omits offers when there is no ebook offer and no link", () => {
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/x", paymentsEnabled: true, book: { ...book, offer: null, retailLinks: [] } });
    expect(schema).not.toHaveProperty("offers");
  });
});

describe("knowledgeArticleSchema completeness", () => {
  it("gives an idea the site as author and publisher and its creation date", () => {
    const schema = knowledgeArticleSchema({ siteUrl, locale: "vi", path: "/vi/ideas/x", kind: "idea", page: idea });
    expect(schema.author).toEqual({ "@type": "Organization", name: "Infinity Books", url: siteUrl });
    expect(schema.publisher).toEqual({ "@type": "Organization", name: "Infinity Books", url: siteUrl });
    expect(schema.datePublished).toBe(idea.createdAt);
    expect(schema.dateModified).toBe(idea.updatedAt);
  });
  it("gives an article a publisher beside its Person author", () => {
    const schema = knowledgeArticleSchema({ siteUrl, locale: "vi", path: "/vi/articles/x", kind: "article", page: article });
    expect(schema.publisher).toEqual({ "@type": "Organization", name: "Infinity Books", url: siteUrl });
    expect((schema.author as { "@type": string })["@type"]).toBe("Person");
  });
});
```

`idea` and `article` are the existing fixtures in this test file. The ebook offer's `price` string format follows `priceInMajorUnits`; copy whatever the existing ebook test expects.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/seo/json-ld.test.ts`
Expected: FAIL on `offers` shape.

- [ ] **Step 3: Implement**

In `lib/seo/json-ld.ts`:

```ts
import { retailerLabel, withRetailUtm } from "@/lib/catalog/retail";

const RETAILER_NAMES = { shopee: "Shopee", fahasa: "Fahasa", tiki: "Tiki" } as const;

function siteOrganization(siteUrl: string) {
  const { "@context": _context, ...organization } = organizationSchema(siteUrl);
  return organization;
}

function paperbackOfferSchema(book: CatalogBookPage, link: CatalogRetailLink, locale: Locale) {
  return {
    "@type": "Offer",
    url: withRetailUtm(link.url, locale),
    availability: "https://schema.org/InStock",
    ...(link.priceMinor !== null && link.currency !== null
      ? { price: priceInMajorUnits(link.priceMinor, link.currency), priceCurrency: link.currency }
      : {}),
    seller: { "@type": "Organization", name: retailerLabel(link, RETAILER_NAMES) },
    itemOffered: {
      "@type": "Book",
      bookFormat: "https://schema.org/Paperback",
      ...(book.isbn ? { isbn: book.isbn } : {}),
    },
  };
}
```

In `offerSchema`, add `seller: siteOrganization(siteUrl)` and `itemOffered: { "@type": "Book", bookFormat: "https://schema.org/EBook" }` (pass `siteUrl` in). In `bookSchema`:

```ts
const offers = [
  ...(book.offer ? [offerSchema(book, paymentsEnabled, url, siteUrl)] : []),
  ...book.retailLinks.map((link) => paperbackOfferSchema(book, link, locale)),
];
// ...
...(offers.length > 0 ? { offers } : {}),
```

In `knowledgeArticleSchema`, idea branch adds `datePublished: page.createdAt, author: siteOrganization(siteUrl), publisher: siteOrganization(siteUrl)`; article branch adds `publisher: siteOrganization(siteUrl)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/seo`
Expected: PASS. Existing bundle and book tests keep passing; if an existing test asserted the ebook Offer with `toEqual`, extend its expectation with `seller` and `itemOffered`.

- [ ] **Step 5: Commit**

```bash
git add lib/seo
git commit -m "feat(s14): multi-offer Book JSON-LD and complete knowledge Article fields"
```

---

### Task 5: Book page paperback block and click beacon

**Files:**
- Create: `components/catalog/retail-link-button.tsx`
- Create: `components/catalog/retail-link-button.test.tsx`
- Modify: `app/[lang]/(public)/books/[slug]/page.tsx`
- Modify: `lib/i18n/dictionaries/en.json`, `lib/i18n/dictionaries/vi.json`

**Interfaces:**
- Produces `RetailLinkButton({ bookId, locale, retailer, href, label })` (client).
- Dictionary `catalog.retail`: `{ title, intro, listPrice, labels: { shopee, fahasa, tiki } }`.

- [ ] **Step 1: Write the failing component test**

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const sendAnalyticsEvent = vi.fn();
vi.mock("@/lib/analytics/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/browser")>()),
  sendAnalyticsEvent: (...args: unknown[]) => sendAnalyticsEvent(...args),
}));

import { RetailLinkButton } from "@/components/catalog/retail-link-button";

afterEach(cleanup);

describe("RetailLinkButton", () => {
  it("is an outbound sponsored link that reports the click and keeps its href", async () => {
    render(<RetailLinkButton bookId="b1" href="https://shopee.vn/x?utm_source=infinitybooks" label="Shopee" locale="vi" retailer="shopee" />);
    const link = screen.getByRole("link", { name: "Shopee" });
    expect(link).toHaveAttribute("href", "https://shopee.vn/x?utm_source=infinitybooks");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "nofollow noopener sponsored");
    await userEvent.setup().click(link);
    expect(sendAnalyticsEvent).toHaveBeenCalledWith({ eventName: "click_external_store", bookId: "b1", retailer: "shopee", locale: "vi" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run components/catalog/retail-link-button.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the button**

```tsx
"use client";

import { type Retailer, sendAnalyticsEvent } from "@/lib/analytics/browser";
import type { Locale } from "@/lib/i18n/config";

// The click is reported and the navigation proceeds: no preventDefault, no redirect route. A
// blocked beacon costs a data point, never a sale.
export function RetailLinkButton({ bookId, locale, retailer, href, label }: { bookId: string; locale: Locale; retailer: Retailer; href: string; label: string }) {
  return (
    <a
      className="inline-flex min-h-11 items-center rounded-md border border-ink px-4 text-sm font-medium text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
      href={href}
      onClick={() => sendAnalyticsEvent({ eventName: "click_external_store", bookId, retailer, locale })}
      rel="nofollow noopener sponsored"
      target="_blank"
    >
      {label}
    </a>
  );
}
```

- [ ] **Step 4: Add dictionary keys**

`en.json` under `catalog`:

```json
"retail": {
  "title": "Paperback",
  "intro": "Buy the printed book at:",
  "listPrice": "List price {price}",
  "labels": { "shopee": "Shopee", "fahasa": "Fahasa", "tiki": "Tiki" }
}
```

`vi.json`:

```json
"retail": {
  "title": "Sách giấy",
  "intro": "Mua bản in tại:",
  "listPrice": "Giá niêm yết {price}",
  "labels": { "shopee": "Shopee", "fahasa": "Fahasa", "tiki": "Tiki" }
}
```

- [ ] **Step 5: Render the block on the book page**

In `app/[lang]/(public)/books/[slug]/page.tsx`, directly after the `</div>` that closes the price row (`border-y border-hairline py-6`) and before the `ActionErrorBanner` Suspense:

```tsx
{book.retailLinks.length > 0 ? (
  <section aria-labelledby="book-retail" className="mt-6">
    <h2 className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase" id="book-retail">
      {copy.retail.title}
    </h2>
    <p className="mt-1 text-[0.9375rem] text-ink-soft">{copy.retail.intro}</p>
    <ul className="mt-3 flex flex-wrap gap-3">
      {book.retailLinks.map((link) => (
        <li className="space-y-1" key={link.id}>
          <RetailLinkButton
            bookId={book.bookId}
            href={withRetailUtm(link.url, locale)}
            label={retailerLabel(link, copy.retail.labels)}
            locale={locale}
            retailer={link.retailer}
          />
          {link.priceMinor !== null && link.currency !== null ? (
            <span className="block text-xs text-sage-text">
              {fillTemplate(copy.retail.listPrice, { price: formatPrice(link.priceMinor, link.currency, locale) })}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  </section>
) : null}
```

Use the price formatter `PriceLabel` already uses (grep `components/catalog/price-label.tsx` for the function it imports from `lib/catalog/price.ts` or `lib/i18n/format.ts`) instead of `formatPrice` if the name differs. Import `RetailLinkButton`, `withRetailUtm`, `retailerLabel`.

- [ ] **Step 6: Run checks**

Run: `npx vitest run components/catalog lib/i18n && npm run typecheck && npm run lint`
Expected: PASS, including dictionary parity.

- [ ] **Step 7: Commit**

```bash
git add components/catalog/retail-link-button.tsx components/catalog/retail-link-button.test.tsx 'app/[lang]/(public)/books/[slug]/page.tsx' lib/i18n/dictionaries
git commit -m "feat(s14): paperback retailer block on the book page"
```

---

### Task 6: Admin "Paperback retailers" section

**Files:**
- Modify: `lib/data/books.ts` (`AdminBookDTO.retailLinks`, `bookSelect`, `setBookRetailLinks`)
- Modify: `app/admin/books/[bookId]/editor-actions.ts` (`saveRetailLinksAction`)
- Modify: `app/admin/books/[bookId]/editor-actions.test.ts`
- Create: `components/admin/book-editor/retail-links-form.tsx`
- Create: `components/admin/book-editor/retail-links-form.test.tsx`
- Modify: `app/admin/books/[bookId]/page.tsx`

**Interfaces:**
- Produces `AdminBookDTO.retailLinks: AdminRetailLinkDTO[]` where `AdminRetailLinkDTO = { id: string; retailer: Retailer; label: string | null; url: string; priceMinor: number | null; currency: string | null; active: boolean }` in position order.
- Produces `setBookRetailLinks(bookId: string, links: RetailLinkInput[]): Promise<void>`.
- Produces `saveRetailLinksAction(bookId: string, previous: AdminFormState, formData: FormData): Promise<AdminFormState>`. Form fields are indexed: `links[0].retailer`, `links[0].label`, `links[0].url`, `links[0].priceMinor`, `links[0].currency`, `links[0].active`; `linkCount` holds the row count.

- [ ] **Step 1: Write the failing action test**

In `editor-actions.test.ts`, following the file's existing mocking of `@/lib/auth/admin` and `@/lib/data/books`:

```ts
describe("saveRetailLinksAction", () => {
  it("parses indexed rows in order and replaces the set", async () => {
    const form = new FormData();
    form.set("linkCount", "2");
    form.set("links[0].retailer", "tiki"); form.set("links[0].url", "https://tiki.vn/x"); form.set("links[0].active", "on");
    form.set("links[1].retailer", "other"); form.set("links[1].label", "ABC"); form.set("links[1].url", "https://abc.example/x");
    form.set("links[1].priceMinor", "129000"); form.set("links[1].currency", "VND");
    const state = await saveRetailLinksAction("b1", initialAdminFormState, form);
    expect(state.formError).toBeNull();
    expect(setBookRetailLinks).toHaveBeenCalledWith("b1", [
      { retailer: "tiki", label: null, url: "https://tiki.vn/x", priceMinor: null, currency: null, active: true },
      { retailer: "other", label: "ABC", url: "https://abc.example/x", priceMinor: 129000, currency: "VND", active: false },
    ]);
  });
  it("reports a field error on a bad url without calling the DAL", async () => {
    const form = new FormData();
    form.set("linkCount", "1");
    form.set("links[0].retailer", "shopee"); form.set("links[0].url", "http://shopee.vn/x"); form.set("links[0].active", "on");
    const state = await saveRetailLinksAction("b1", initialAdminFormState, form);
    expect(state.fieldErrors["links.0.url"]).toBeDefined();
    expect(setBookRetailLinks).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run 'app/admin/books/[bookId]/editor-actions.test.ts'`
Expected: FAIL, `saveRetailLinksAction` is not exported.

- [ ] **Step 3: Implement the DAL**

In `lib/data/books.ts`:

```ts
export type AdminRetailLinkDTO = {
  id: string;
  retailer: Retailer;
  label: string | null;
  url: string;
  priceMinor: number | null;
  currency: string | null;
  active: boolean;
};
```

Add `retailLinks: AdminRetailLinkDTO[]` to `AdminBookDTO`. In `bookSelect` add `retail_links:book_retail_links ( id, retailer, label, url, price_minor, currency, position, active )`, and in the DTO mapper:

```ts
retailLinks: [...row.retail_links]
  .sort((a, b) => a.position - b.position)
  .map((link) => ({ id: link.id, retailer: link.retailer as Retailer, label: link.label, url: link.url, priceMinor: link.price_minor === null ? null : Number(link.price_minor), currency: link.currency, active: link.active })),
```

Admins read every row through the "admin reads retail links" policy, so inactive links appear in the editor.

```ts
export async function setBookRetailLinks(bookId: string, links: RetailLinkInput[]): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_book_retail_links", { p_book_id: bookId, p_links: links });
  if (error) throw failure("setBookRetailLinks", error);
}
```

`failure` already maps `P0002` to `BookNotFoundError`; a `22023` surfaces as a generic error, which `knownFailure` turns into the generic form error.

- [ ] **Step 4: Implement the action**

In `editor-actions.ts`:

```ts
function readRetailLinks(formData: FormData) {
  const count = Math.min(Math.max(readInteger(formData, "linkCount") ?? 0, 0), 10);
  return Array.from({ length: count }, (_, index) => {
    const field = (name: string) => readOptionalText(formData, `links[${index}].${name}`);
    const priceMinor = readOptionalInteger(formData, `links[${index}].priceMinor`);
    return {
      retailer: field("retailer") ?? "",
      label: field("label") ?? null,
      url: field("url") ?? "",
      priceMinor: priceMinor ?? null,
      currency: field("currency") ?? null,
      active: readBoolean(formData, `links[${index}].active`),
    };
  });
}

export async function saveRetailLinksAction(bookId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = retailLinksSchema.safeParse({ links: readRetailLinks(formData) });
  if (!parsed.success) return invalid(parsed.error);
  try {
    await setBookRetailLinks(bookId, parsed.data.links);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}
```

Check `lib/catalog/form.ts` for the exact signatures of `readInteger`, `readOptionalInteger`, `readOptionalText`, and `readBoolean`; if `readBoolean` treats `"on"` as true (checkbox), the test above holds. `fieldErrorsFrom` joins paths with `.`, so a bad `links[0].url` is keyed `links.0.url`.

- [ ] **Step 5: Write the failing form test**

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RetailLinksForm } from "@/components/admin/book-editor/retail-links-form";
import { initialAdminFormState } from "@/lib/catalog/form";

afterEach(cleanup);

describe("RetailLinksForm", () => {
  it("renders existing rows, adds a row, and posts an indexed form", async () => {
    const action = vi.fn().mockResolvedValue(initialAdminFormState);
    render(<RetailLinksForm action={action} links={[{ id: "l1", retailer: "shopee", label: null, url: "https://shopee.vn/x", priceMinor: null, currency: null, active: true }]} />);
    expect(screen.getByDisplayValue("https://shopee.vn/x")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Add retailer" }));
    expect(screen.getAllByLabelText("Retailer")).toHaveLength(2);
    expect(screen.getByDisplayValue("2")).toHaveAttribute("name", "linkCount");
  });
  it("shows the label field only for Other", async () => {
    render(<RetailLinksForm action={vi.fn()} links={[]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add retailer" }));
    expect(screen.queryByLabelText("Label")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Retailer"), "other");
    expect(screen.getByLabelText("Label")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Implement the form**

`components/admin/book-editor/retail-links-form.tsx` (`"use client"`), modelled on `related-books-picker.tsx` but with editable rows. State is `rows: Array<{ key: string } & RetailLinkDraft>` where `RetailLinkDraft = { retailer: Retailer; label: string; url: string; priceMinor: string; currency: string; active: boolean }`. Render per row: `NativeSelect` "Retailer" (options from `retailers`), `Input` "Label" only when `retailer === "other"`, `Input` "URL", `Input` "Price (minor units)", `Input` "Currency", a checkbox "Active", and ghost buttons "Move up", "Move down", "Remove" with the same accessible-name and focus rules as the picker. Each input's `name` is `links[${index}].${field}`; a hidden `linkCount` input holds `rows.length`. "Add retailer" appends `{ retailer: "shopee", label: "", url: "", priceMinor: "", currency: "VND", active: true }`. Show `FieldError` for `state.fieldErrors[`links.${index}.${field}`]` under each input, `FormStatus`, and `SubmitButton pendingLabel="Saving…">Save paperback retailers</SubmitButton>`.

- [ ] **Step 7: Mount the section**

In `app/admin/books/[bookId]/page.tsx`, add `{ id: "retail", label: "Paperback retailers" }` to `sections` after `offer`, and after the `offer` `AdminSection`:

```tsx
<AdminSection id="retail" title="Paperback retailers">
  <p className="mb-4 text-sm text-sage-text">Where the printed book is sold. Links open in a new tab from the book page and carry UTM parameters; paste the plain marketplace URL.</p>
  <RetailLinksForm action={saveRetailLinksAction.bind(null, book.id)} links={book.retailLinks} />
</AdminSection>
```

- [ ] **Step 8: Run checks**

Run: `npx vitest run components/admin/book-editor 'app/admin/books/[bookId]' lib/data/books.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/data/books.ts 'app/admin/books/[bookId]' components/admin/book-editor/retail-links-form.tsx components/admin/book-editor/retail-links-form.test.tsx
git commit -m "feat(s14): admin paperback retailers section"
```

---

### Task 7: `/llms.txt`

**Files:**
- Create: `lib/seo/llms.ts`
- Create: `lib/seo/llms.test.ts`
- Create: `app/llms.txt/route.ts`
- Create: `app/llms.txt/route.test.ts`
- Modify: `lib/catalog/revalidate.ts`
- Modify: `lib/i18n/dictionaries/en.json`, `vi.json` (`llms.intro`)
- Modify: `scripts/assert-prerendered-routes.ts` only if `npm run check:prerender` flags the new route; the route is dynamic with `revalidate = 300` like the sitemap.

**Interfaces:**
- Produces `buildLlmsText(input: { siteUrl: string; sections: LlmsLocaleSection[] }): string` where `LlmsLocaleSection = { locale: Locale; heading: string; intro: string; groups: { heading: string; entries: { title: string; path: string; description: string | null }[] }[] }`.
- Produces `truncateDescription(text: string | null, max = 200): string | null`.
- Produces `GET` at `/llms.txt` returning `text/plain; charset=utf-8`.

- [ ] **Step 1: Write the failing builder tests**

```ts
import { describe, expect, it } from "vitest";
import { buildLlmsText, truncateDescription } from "@/lib/seo/llms";

describe("truncateDescription", () => {
  it("collapses newlines and cuts at a word boundary with an ellipsis", () => {
    const long = "Một câu rất dài\nvới xuống dòng ".repeat(20);
    const out = truncateDescription(long)!;
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1).endsWith(" ")).toBe(false);
  });
  it("returns null for blank input", () => {
    expect(truncateDescription("  \n ")).toBeNull();
    expect(truncateDescription(null)).toBeNull();
  });
});

describe("buildLlmsText", () => {
  it("renders the locale sections, groups, and entry lines", () => {
    const text = buildLlmsText({
      siteUrl: "https://books.example",
      sections: [
        { locale: "vi", heading: "Infinity Books", intro: "Sách của Phương Bùi.", groups: [
          { heading: "Books", entries: [{ title: "Sách một", path: "/vi/books/sach-mot", description: "Mô tả\nhai dòng" }] },
          { heading: "Ideas", entries: [] },
        ] },
        { locale: "en", heading: "English", intro: "Books by Phuong Bui.", groups: [
          { heading: "Books", entries: [{ title: "Book one", path: "/en/books/book-one", description: null }] },
        ] },
      ],
    });
    expect(text).toBe([
      "# Infinity Books",
      "",
      "> Sách của Phương Bùi.",
      "",
      "## Books",
      "- [Sách một](https://books.example/vi/books/sach-mot): Mô tả hai dòng",
      "",
      "## English",
      "",
      "> Books by Phuong Bui.",
      "",
      "### Books",
      "- [Book one](https://books.example/en/books/book-one)",
      "",
    ].join("\n"));
  });
});
```

Empty groups are skipped. The first section uses `#`/`##`; later sections use `##`/`###`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/seo/llms.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/seo/llms.ts`**

```ts
import type { Locale } from "@/lib/i18n/config";
import { absoluteUrl } from "@/lib/seo/metadata";

export type LlmsEntry = { title: string; path: string; description: string | null };
export type LlmsLocaleSection = { locale: Locale; heading: string; intro: string; groups: { heading: string; entries: LlmsEntry[] }[] };

const MAX_DESCRIPTION = 200;

export function truncateDescription(text: string | null, max = MAX_DESCRIPTION): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

function line(siteUrl: string, entry: LlmsEntry): string {
  const description = truncateDescription(entry.description);
  const title = entry.title.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
  return `- [${title}](${absoluteUrl(siteUrl, entry.path)})${description ? `: ${description}` : ""}`;
}

export function buildLlmsText({ siteUrl, sections }: { siteUrl: string; sections: LlmsLocaleSection[] }): string {
  const out: string[] = [];
  sections.forEach((section, index) => {
    const h = index === 0 ? "#" : "##";
    const g = index === 0 ? "##" : "###";
    out.push(`${h} ${section.heading}`, "", `> ${section.intro}`, "");
    for (const group of section.groups) {
      if (group.entries.length === 0) continue;
      out.push(`${g} ${group.heading}`, ...group.entries.map((entry) => line(siteUrl, entry)), "");
    }
  });
  return out.join("\n");
}
```

- [ ] **Step 4: Write the failing route test**

`app/llms.txt/route.test.ts`, with the same `vi.mock` set as `app/sitemap.test.ts` for `@/lib/config/server-env`, `@/lib/config/build-environment`, `@/lib/data/catalog`, `@/lib/data/knowledge`, `@/lib/data/public-bundles`, plus `@/lib/i18n/dictionary`:

```ts
// @vitest-environment node
it("lists the published book, author, idea, and article for both locales as text", async () => {
  const response = await GET();
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const text = await response.text();
  expect(text).toContain("- [Sách một](https://books.example/vi/books/sach-mot)");
  expect(text).toContain("- [Mai Tran](https://books.example/vi/authors/mai-tran)");
  expect(text).toContain("https://books.example/vi/ideas/");
  expect(text).toContain("https://books.example/en/books/");
  expect(text.indexOf("# Infinity Books")).toBeLessThan(text.indexOf("## English"));
});
```

Build the mocked cards the way `sitemap.test.ts` does; mock `getPublishedIdeas` and `getArticleIndex` to return one summary each; mock `getEntityPage` only if the route needs it (it does not: author, series, and topic names come from the cards).

- [ ] **Step 5: Implement the route**

```ts
import { catalogStaticParams } from "@/lib/catalog/static-params";
import { deferPrerenderWithoutServerEnv } from "@/lib/config/build-environment";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { getArticleIndex, getPublishedIdeas } from "@/lib/data/knowledge";
import { locales } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes, getKnowledgeRoutes } from "@/lib/i18n/routes";
import { buildLlmsText, type LlmsEntry, type LlmsLocaleSection } from "@/lib/seo/llms";
import { SITE_NAME } from "@/lib/seo/metadata";

// Optional LLM index (PRD 5.1, S14 spec 8). The same published-only reads as app/sitemap.ts, so
// this list and the sitemap cannot disagree. Same cache model as the sitemap.
export const revalidate = 300;

export async function GET(): Promise<Response> {
  await deferPrerenderWithoutServerEnv();
  const { siteUrl } = getServerEnv();
  const sections: LlmsLocaleSection[] = [];

  for (const locale of locales) {
    const [cards, ideas, articles, dictionary] = await Promise.all([
      getBookCards(locale), getPublishedIdeas(locale), getArticleIndex(locale), getDictionary(locale),
    ]);
    const catalog = getCatalogRoutes(locale);
    const hub = getKnowledgeRoutes(locale);
    const unique = (entries: LlmsEntry[]) => [...new Map(entries.map((entry) => [entry.path, entry])).values()];

    sections.push({
      locale,
      heading: locale === "vi" ? SITE_NAME : dictionary.llms.heading,
      intro: dictionary.llms.intro,
      groups: [
        { heading: dictionary.navigation.books, entries: cards.map((card) => ({ title: card.title, path: catalog.book(card.slug), description: card.shortDescription })) },
        { heading: dictionary.llms.authors, entries: unique(cards.flatMap((card) => (card.author.slug ? [{ title: card.author.name, path: catalog.entity("author", card.author.slug), description: null }] : []))) },
        { heading: dictionary.llms.series, entries: unique(cards.flatMap((card) => (card.series ? [{ title: card.series.name, path: catalog.entity("series", card.series.slug), description: null }] : []))) },
        { heading: dictionary.llms.topics, entries: unique(cards.flatMap((card) => card.topics.map((topic) => ({ title: topic.name, path: catalog.entity("topic", topic.slug), description: null })))) },
        { heading: dictionary.navigation.ideas, entries: ideas.map((idea) => ({ title: idea.question, path: hub.idea(idea.slug), description: idea.shortAnswer })) },
        { heading: dictionary.navigation.articles, entries: articles.map((article) => ({ title: article.title, path: hub.article(article.slug), description: article.excerpt })) },
      ],
    });
  }

  return new Response(buildLlmsText({ siteUrl, sections }), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
```

`catalogStaticParams` is not needed; remove the import if unused. Check `dictionary.navigation` for the exact keys `books`, `ideas`, `articles` (the sitemap-era book page uses `dictionary.navigation.books`).

Dictionary `llms` block, `en.json`:

```json
"llms": {
  "heading": "English",
  "intro": "Infinity Books publishes Phuong Bui's books on awareness, love, family, money and action. Ebooks are read in the browser on this site; printed books are sold on Shopee, Fahasa and Tiki.",
  "authors": "Authors",
  "series": "Series",
  "topics": "Topics"
}
```

`vi.json`:

```json
"llms": {
  "heading": "Tiếng Việt",
  "intro": "Infinity Books xuất bản sách của Phương Bùi về tỉnh biết, tình yêu, gia đình, tiền bạc và hành động. Ebook đọc ngay trên trình duyệt tại đây; sách giấy bán tại Shopee, Fahasa và Tiki.",
  "authors": "Tác giả",
  "series": "Bộ sách",
  "topics": "Chủ đề"
}
```

`lib/catalog/revalidate.ts`: add `revalidatePath("/llms.txt");` inside `revalidateStorefront()`.

- [ ] **Step 6: Run checks**

Run: `npx vitest run lib/seo app/llms.txt lib/i18n lib/catalog/revalidate.test.ts && npm run build && npm run check:prerender`
Expected: PASS; the route appears as dynamic/ISR like `/sitemap.xml` and the prerender check still passes. If `check:prerender` enumerates expected routes, add `/llms.txt` beside `/sitemap.xml` there.

- [ ] **Step 7: Commit**

```bash
git add lib/seo/llms.ts lib/seo/llms.test.ts app/llms.txt lib/catalog/revalidate.ts lib/i18n/dictionaries scripts/assert-prerendered-routes.ts
git commit -m "feat(s14): /llms.txt index of published entities"
```

---

### Task 8: Visible "Updated" date on article pages

**Files:**
- Modify: `app/[lang]/(public)/articles/[slug]/page.tsx`
- Modify: `app/[lang]/(public)/articles/[slug]/page.test.tsx`
- Modify: dictionaries (`knowledge.article.updated`)

- [ ] **Step 1: Write the failing test**

In the page test, following its existing render helper and article fixture:

```ts
it("shows an updated date only when the localization changed on a later day than publication", async () => {
  const html = await renderArticle({ ...article, publishedAt: "2026-09-01T10:00:00+00:00", updatedAt: "2026-09-15T08:00:00+00:00" });
  expect(html).toContain('datetime="2026-09-15T08:00:00+00:00"');
  const same = await renderArticle({ ...article, publishedAt: "2026-09-01T10:00:00+00:00", updatedAt: "2026-09-01T23:00:00+00:00" });
  expect(same).not.toContain("Updated");
});
```

- [ ] **Step 2: Implement**

After the `<time dateTime={publishedAt}>` element:

```tsx
{isLaterDay(article.updatedAt, article.publishedAt) ? (
  <span className="ml-3 text-sage-text">
    {copy.updated}{" "}
    <time dateTime={article.updatedAt}>{formatDate(article.updatedAt, locale)}</time>
  </span>
) : null}
```

with a local helper:

```ts
function isLaterDay(updated: string, published: string | null): boolean {
  if (!published) return false;
  return new Date(updated).toISOString().slice(0, 10) > new Date(published).toISOString().slice(0, 10);
}
```

Dictionary `knowledge.article.updated`: en `"Updated"`, vi `"Cập nhật"`.

- [ ] **Step 3: Run and commit**

Run: `npx vitest run 'app/[lang]/(public)/articles' lib/i18n`
Expected: PASS.

```bash
git add 'app/[lang]/(public)/articles/[slug]' lib/i18n/dictionaries
git commit -m "feat(s14): show article updated date to match dateModified"
```

---

### Task 9: End-to-end, runbooks, and final gates

**Files:**
- Create: `e2e/paperback-upsell.spec.ts`
- Modify: `docs/runbooks/catalog-admin.md`
- Modify: `docs/runbooks/seo-and-operations.md`

- [ ] **Step 1: Write the E2E spec**

```ts
import { expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { createReader, signInAs } from "./support/commerce";
import { revalidateStorefront } from "./support/revalidate";
import { createServiceRoleClient } from "./support/supabase";

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("an admin adds a Shopee link and the book page shows it with UTM and two Offers", async ({ page, request }) => {
  const suffix = unique();
  const slug = `paperback-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { vi: { slug, title: `Sách giấy ${suffix}` } }, priceMinor: 50000 });
  const admin = await createReader(`paperback-admin-${suffix}`, { admin: true });
  await signInAs(page, admin.email, `/admin/books/${bookId}`);

  await page.getByRole("button", { name: "Add retailer" }).click();
  await page.getByLabel("Retailer").selectOption("shopee");
  await page.getByLabel("URL").fill("https://shopee.vn/e2e-paperback");
  await page.getByRole("button", { name: "Save paperback retailers" }).click();
  await expect(page.getByText(/Saved/)).toBeVisible();
  await revalidateStorefront(request);

  await page.goto(`/vi/books/${slug}`);
  const link = page.getByRole("link", { name: "Shopee" });
  await expect(link).toHaveAttribute("href", /^https:\/\/shopee\.vn\/e2e-paperback\?utm_source=infinitybooks&utm_medium=book_page&utm_campaign=paperback&utm_content=vi$/);
  await expect(link).toHaveAttribute("rel", "nofollow noopener sponsored");

  const jsonLd = await page.locator('script[type="application/ld+json"]').first().textContent();
  const [book] = JSON.parse(jsonLd ?? "[]");
  expect(book.offers).toHaveLength(2);
  expect(book.offers[1].seller.name).toBe("Shopee");
  expect(book.offers[1].itemOffered.bookFormat).toBe("https://schema.org/Paperback");

  const [row] = await Promise.all([
    page.waitForRequest((req) => req.url().endsWith("/api/analytics/events") && req.postData()?.includes("click_external_store") === true),
    link.click(),
  ]);
  expect(row.postDataJSON().retailer).toBe("shopee");

  await expect
    .poll(async () => {
      const { count } = await createServiceRoleClient().from("analytics_events").select("id", { count: "exact", head: true }).eq("event_name", "click_external_store").eq("book_id", bookId);
      return count ?? 0;
    })
    .toBeGreaterThan(0);
});

test("/llms.txt lists a published book", async ({ request }) => {
  const suffix = unique();
  const slug = `llms-${suffix}`;
  await seedCatalogBook({ suffix, localizations: { vi: { slug, title: `LLMS ${suffix}` } } });
  await revalidateStorefront(request);
  const response = await request.get("/llms.txt");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/plain");
  expect(await response.text()).toContain(`/vi/books/${slug}`);
});
```

Match the JSON-LD extraction to how `e2e/seo-operations.spec.ts` reads the script element (the page emits one `<script>` with an array). The "Saved" text should be whatever `FormStatus` renders on success; copy it from `components/admin/form-feedback.tsx`.

- [ ] **Step 2: Runbooks**

`docs/runbooks/catalog-admin.md`: add a section "Paperback retailers" explaining: paste the plain marketplace URL (https only), the label is only for Other, price is optional and only shown as "list price", deactivate rather than delete to hide temporarily, and that a save replaces the whole set. Note that the analytics event `click_external_store` with `retailer` records outbound clicks.

`docs/runbooks/seo-and-operations.md`: add a subsection on `/llms.txt` (what it lists, that it is revalidated with the storefront, that Google ignores it per PRD 5.1) and on the Book `offers` array shape (ebook Offer with site seller; one paperback Offer per active link; validate at the Schema.org validator after a change).

- [ ] **Step 3: Final gates**

Run, against an owned local stack per `docs/runbooks/testing-environments.md`:

```bash
npm run check
npm run db:reset && npm run db:test
npm run check:full
```

Expected: all green. Paste the summary lines of each into the PR description.

- [ ] **Step 4: Commit**

```bash
git add e2e/paperback-upsell.spec.ts docs/runbooks/catalog-admin.md docs/runbooks/seo-and-operations.md
git commit -m "test(s14): paperback upsell and llms.txt acceptance; runbooks"
```
