# S2 Public Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Readers find, browse, search, and evaluate published books on locale-prefixed public pages.

**Architecture:** Public pages read the catalog through four `security definer` read functions. Each function filters to published rows itself. Pages call them with a cookie-less Supabase client. Filtering, sorting, and the book action are pure TypeScript functions. Only the book action reads the signed-in reader's entitlements.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase Postgres (`unaccent`, `pg_trgm`), pgTAP, Zod 4, Vitest, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-09-15-s2-public-discovery-design.md` (parent: `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md`, section S2)

## Global Constraints

- MVP is ebook-only. Add no physical products, cart, or shipping.
- Customer routes stay under `/{locale}`. Locales are `vi` and `en`.
- Public pages never create a service-role client.
- Public read functions filter to `published` rows explicitly. Admin callers get the same public view.
- A missing localization returns 404. Never render another locale's copy.
- Do not build the Get or Buy Server Actions. S3 builds them.
- Do not build `/read-sample/[slug]`. S4 builds it. S2 only links to it.
- Do not add canonical, `hreflang`, Open Graph, JSON-LD, sitemap, robots files, or proxy redirects. S5 adds them.
- Read the local Next.js guide in `node_modules/next/dist/docs/` before you change Next.js code. `priority` on `next/image` is deprecated; use `preload`.
- Add new migrations only. Name them after `20260913150000`.
- Update `lib/supabase/database.types.ts` after every migration.
- Run database and Playwright tests only against a local Supabase stack. If another stack owns the default ports, use a scratch `--workdir` stack. See `docs/runbooks/testing-environments.md`.
- Never return raw Supabase or Postgres error text to a page.
- Touch targets are at least 44px (`min-h-11`).
- Run `npm run check` at the end of every task.
- Never stage `cmd.txt` or `docs/ref/`.
- Work on branch `feat/s2-public-discovery`.

## Decisions This Plan Locks In

1. **Read functions, not new RLS policies.** Admins can read drafts under RLS. One function per page shape filters drafts in one place.
2. **Cards are the shared unit.** `catalog_book_cards(locale)` returns every visible book with everything a card needs. The book page, entity pages, catalog, search, and home all reuse cards.
3. **Filtering is in TypeScript.** `/books` loads all cards once. Revisit near 500 books.
4. **Entity pages need books.** An author, series, or topic with no visible book in the locale returns 404.
5. **Signed-in Get and Buy buttons are disabled in S2.** S3 replaces them.
6. **Covers in cards are decorative** (`alt=""`), because the title sits next to them. The book page cover uses the stored alt text.
7. **Search scores:** `3` exact, `2` prefix, `1` contains or trigram word similarity ≥ 0.4. A book scores `3` when its author name equals the query.

## File Map

| Path | Responsibility |
| --- | --- |
| `supabase/migrations/20260915100000_public_catalog_reads.sql` | `catalog_has_visible_book`, `catalog_book_cards`, `catalog_book_page`, `catalog_entity_page` |
| `supabase/migrations/20260915110000_catalog_search.sql` | `pg_trgm`, `catalog_normalize`, `catalog_match_score`, `search_catalog` |
| `supabase/tests/016_public_catalog_reads.sql` | Visibility, fields, grants |
| `supabase/tests/017_catalog_search.sql` | Diacritics, ranking, visibility |
| `lib/catalog/book-action.ts` | `resolveBookAction` |
| `lib/catalog/price.ts` | `formatPrice` |
| `lib/catalog/public-types.ts` | Public DTO types |
| `lib/catalog/browse.ts` | Filter parsing, filter and sort, entity books, home shelves, filter options |
| `lib/catalog/search.ts` | Query normalization and hit grouping |
| `lib/i18n/format.ts` | `fillTemplate` |
| `lib/i18n/routes.ts` | Catalog route builders and `otherLocale` |
| `lib/config/url.ts` | `isLoopbackUrl` |
| `lib/supabase/public.ts` | Cookie-less public client |
| `lib/data/catalog.ts` | Public catalog data access |
| `components/catalog/*.tsx` | Cover, card, grid, price, action control, filter form, entity page |
| `components/site-header.tsx` | Books and Search links, `alternates` prop |
| `app/[locale]/(public)/page.tsx` | Home with featured book and shelf |
| `app/[locale]/(public)/books/page.tsx` | Catalog |
| `app/[locale]/(public)/books/[slug]/page.tsx` | Book page |
| `app/[locale]/(public)/{authors,series,topics}/[slug]/page.tsx` | Entity pages |
| `app/[locale]/(public)/search/page.tsx` | Search |
| `lib/catalog/revalidate.ts` | `revalidateStorefront` |
| `e2e/support/catalog.ts` | Service-role seeding for public pages |
| `e2e/public-discovery.spec.ts` | S2 journeys |
| `docs/runbooks/storefront.md` | What readers see and why |

---

### Task 1: Public catalog read functions

**Files:**
- Create: `supabase/migrations/20260915100000_public_catalog_reads.sql`
- Create: `supabase/tests/016_public_catalog_reads.sql`
- Modify: `lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: S1 tables `series`, `book_series`, `author_localizations`, `series_localizations`, `topic_localizations`, `merchandising_slots`, `media_assets`, and `book_localizations` content columns.
- Produces:
  - `public.catalog_book_cards(p_locale text)` returns table `(book_id uuid, slug text, title text, subtitle text, short_description text, author_name text, author_slug text, cover_path text, cover_alt text, price_minor bigint, currency text, has_active_publication boolean, has_sample boolean, series_slug text, series_name text, series_position integer, topics jsonb, featured boolean, shelf_position integer, created_at timestamptz)`. `topics` is `[{slug, name}]`.
  - `public.catalog_book_page(p_locale text, p_slug text)` returns `jsonb` `{bookId, description, audience, keyIdeas, faq, seoTitle, seoDescription, alternateSlug}` or `null`.
  - `public.catalog_entity_page(p_kind text, p_locale text, p_slug text)` returns `jsonb` `{id, name, description, alternateSlug}` or `null`. `p_kind` is `author`, `series`, or `topic`.
  - Internal `public.catalog_has_visible_book(p_kind text, p_entity_id uuid, p_locale text)`, not executable by browser roles.

- [ ] **Step 1: Create the branch**

```bash
git switch -c feat/s2-public-discovery
```

- [ ] **Step 2: Write the failing pgTAP test**

Create `supabase/tests/016_public_catalog_reads.sql`:

```sql
begin;
select plan(30);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's2-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status) values
  ('d2000000-0000-0000-0000-000000000001', 's2-author', 'S2 Author', 'published'),
  ('d2000000-0000-0000-0000-000000000002', 's2-draft-author', 'S2 Draft Author', 'draft');
insert into public.author_localizations (author_id, locale, slug, name, description) values
  ('d2000000-0000-0000-0000-000000000001', 'vi', 's2-tac-gia', 'Tác giả S2', 'Mô tả tác giả'),
  ('d2000000-0000-0000-0000-000000000001', 'en', 's2-author-en', 'S2 Author', 'Author bio'),
  ('d2000000-0000-0000-0000-000000000002', 'vi', 's2-tac-gia-nhap', 'Tác giả nháp', null);

insert into public.books (id, canonical_key, original_language, primary_author_id, status, created_at) values
  ('d3000000-0000-0000-0000-000000000001', 's2-free', 'vi', 'd2000000-0000-0000-0000-000000000001', 'published', '2026-09-01'),
  ('d3000000-0000-0000-0000-000000000002', 's2-paid', 'vi', 'd2000000-0000-0000-0000-000000000001', 'published', '2026-09-02'),
  ('d3000000-0000-0000-0000-000000000003', 's2-draft', 'vi', 'd2000000-0000-0000-0000-000000000002', 'draft', '2026-09-03');
insert into public.book_localizations (book_id, locale, slug, title, short_description, description, audience, key_ideas) values
  ('d3000000-0000-0000-0000-000000000001', 'vi', 's2-sach-mien-phi', 'Sách miễn phí S2', 'Ngắn', 'Dài', 'Người mới', '[{"title":"Ý chính","summary":"Tóm tắt"}]'),
  ('d3000000-0000-0000-0000-000000000001', 'en', 's2-free-book', 'S2 Free Book', 'Short', 'Long', null, '[]'),
  ('d3000000-0000-0000-0000-000000000002', 'vi', 's2-sach-tra-phi', 'Sách trả phí S2', null, 'Dài', null, '[]'),
  ('d3000000-0000-0000-0000-000000000003', 'vi', 's2-sach-nhap', 'Sách nháp S2', null, 'Dài', null, '[]');

insert into public.editions (id, book_id, language_code) values
  ('d6000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000001', 'vi'),
  ('d6000000-0000-0000-0000-000000000002', 'd3000000-0000-0000-0000-000000000002', 'vi');
insert into public.skus (id, edition_id, sku_code) values
  ('d7000000-0000-0000-0000-000000000001', 'd6000000-0000-0000-0000-000000000001', 's2-free-ebook'),
  ('d7000000-0000-0000-0000-000000000002', 'd6000000-0000-0000-0000-000000000002', 's2-paid-ebook');
insert into public.offers (sku_id, market_code, currency, price_minor) values
  ('d7000000-0000-0000-0000-000000000001', 'VN', 'VND', 0),
  ('d7000000-0000-0000-0000-000000000002', 'VN', 'VND', 129000);

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('d8000000-0000-0000-0000-000000000001', 'd6000000-0000-0000-0000-000000000001', 's2/source.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('d9000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-000000000001', 1, 's2/manifest.json', 'published');
update public.books set active_publication_id = 'd9000000-0000-0000-0000-000000000001'
where id = 'd3000000-0000-0000-0000-000000000001';
insert into public.book_samples (publication_id, allowed_hrefs)
values ('d9000000-0000-0000-0000-000000000001', '["OEBPS/text/chapter1.xhtml"]');
insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
values ('book', 'd3000000-0000-0000-0000-000000000001', 'cover',
        'books/d3000000-0000-0000-0000-000000000001/dddddddd-dddd-dddd-dddd-dddddddddddd.png', 'Bìa sách S2');

insert into public.series (id, canonical_slug, display_name, status)
values ('d4000000-0000-0000-0000-000000000001', 's2-series', 'S2 Series', 'published');
insert into public.series_localizations (series_id, locale, slug, name)
values ('d4000000-0000-0000-0000-000000000001', 'vi', 's2-bo-sach', 'Bộ sách S2');
insert into public.book_series (book_id, series_id, position)
values ('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001', 1);

insert into public.topics (id, canonical_slug, name, status) values
  ('d5000000-0000-0000-0000-000000000001', 's2-topic', 'S2 Topic', 'published'),
  ('d5000000-0000-0000-0000-000000000002', 's2-draft-topic', 'S2 Draft Topic', 'draft');
insert into public.topic_localizations (topic_id, locale, slug, name) values
  ('d5000000-0000-0000-0000-000000000001', 'vi', 's2-chu-de', 'Chủ đề S2'),
  ('d5000000-0000-0000-0000-000000000002', 'vi', 's2-chu-de-nhap', 'Chủ đề nháp');
insert into public.book_topics (book_id, topic_id) values
  ('d3000000-0000-0000-0000-000000000001', 'd5000000-0000-0000-0000-000000000001'),
  ('d3000000-0000-0000-0000-000000000001', 'd5000000-0000-0000-0000-000000000002');

delete from public.merchandising_slots;
insert into public.merchandising_slots (slot_key, book_id, position) values
  ('home_featured', 'd3000000-0000-0000-0000-000000000001', 1),
  ('home_shelf', 'd3000000-0000-0000-0000-000000000002', 1);

-- (1)-(5) Grants.
select is(has_function_privilege('anon', 'public.catalog_book_cards(text)', 'EXECUTE'), true, 'anon can read book cards');
select is(has_function_privilege('anon', 'public.catalog_book_page(text, text)', 'EXECUTE'), true, 'anon can read a book page');
select is(has_function_privilege('anon', 'public.catalog_entity_page(text, text, text)', 'EXECUTE'), true, 'anon can read an entity page');
select is(has_function_privilege('authenticated', 'public.catalog_has_visible_book(text, uuid, text)', 'EXECUTE'), false, 'the visibility helper is internal');
select is(has_table_privilege('anon', 'public.author_localizations', 'SELECT'), false, 'anon still cannot select author localizations');

set local role anon;

-- (6)-(8) Only published, localized books.
select is((select count(*)::bigint from public.catalog_book_cards('vi') where book_id in ('d3000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000002')), 2::bigint, 'vi lists both published books');
select is((select count(*)::bigint from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000003'), 0::bigint, 'a draft book is not listed');
select is((select count(*)::bigint from public.catalog_book_cards('en') where book_id in ('d3000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000002')), 1::bigint, 'en lists only the translated book');

-- (9)-(17) Card fields.
select is((select has_sample from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), true, 'the free book has a sample');
select is((select has_active_publication from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000002'), false, 'the paid book has no active publication');
select is((select cover_path from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), 'books/d3000000-0000-0000-0000-000000000001/dddddddd-dddd-dddd-dddd-dddddddddddd.png', 'the cover path is returned');
select is((select topics from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), '[{"slug": "s2-chu-de", "name": "Chủ đề S2"}]'::jsonb, 'draft topics are hidden');
select is((select series_slug from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), 's2-bo-sach', 'the series slug is returned');
select is((select featured from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), true, 'the featured flag is returned');
select is((select shelf_position from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000002'), 1, 'the shelf position is returned');
select is((select price_minor from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000002'), 129000::bigint, 'the active offer price is returned');
select is((select author_slug from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), 's2-tac-gia', 'the localized author slug is returned');

-- (18)-(21) Book page.
select is(public.catalog_book_page('vi', 's2-sach-mien-phi') ->> 'alternateSlug', 's2-free-book', 'the book page names the other locale slug');
select is(public.catalog_book_page('vi', 's2-sach-tra-phi') ->> 'alternateSlug', null, 'no alternate slug without a translation');
select is(public.catalog_book_page('vi', 's2-sach-nhap'), null::jsonb, 'a draft book page is null');
select is(public.catalog_book_page('vi', 's2-free-book'), null::jsonb, 'an en slug does not resolve under vi');

-- (22)-(28) Entity pages.
select is(public.catalog_entity_page('author', 'vi', 's2-tac-gia') ->> 'name', 'Tác giả S2', 'a published author page resolves');
select is(public.catalog_entity_page('author', 'vi', 's2-tac-gia') ->> 'alternateSlug', 's2-author-en', 'the author page names the en slug');
select is(public.catalog_entity_page('series', 'en', 's2-bo-sach'), null::jsonb, 'a series without en copy has no en page');
select is(public.catalog_entity_page('author', 'vi', 's2-tac-gia-nhap'), null::jsonb, 'a draft author page is null');
select is(public.catalog_entity_page('topic', 'vi', 's2-chu-de-nhap'), null::jsonb, 'a draft topic page is null');
select is(public.catalog_entity_page('publisher', 'vi', 's2-tac-gia'), null::jsonb, 'an unknown kind is null');
select is((select count(*)::bigint from public.catalog_book_cards('ja')), 0::bigint, 'an unsupported locale returns nothing');

reset role;

-- (29)-(30) An admin caller still gets the public view.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is((select count(*)::bigint from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000003'), 0::bigint, 'an admin does not see draft cards');
select is(public.catalog_entity_page('author', 'vi', 's2-tac-gia-nhap'), null::jsonb, 'an admin does not see a draft author page');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `supabase test db` (add `--workdir <scratch>` on a scratch stack)
Expected: FAIL in `016_public_catalog_reads.sql`: function `public.catalog_book_cards(text)` does not exist.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20260915100000_public_catalog_reads.sql`:

```sql
-- S2 public catalog reads. See docs/superpowers/specs/2026-09-15-s2-public-discovery-design.md (4.1, 4.2).
--
-- Public pages read the catalog only through these functions. Each one filters to published rows
-- itself. Admins can read drafts under RLS, so an explicit filter is the only way an admin sees the
-- same storefront as everyone else.

-- True when the author, series, or topic has at least one published book localized in p_locale.
create function public.catalog_has_visible_book(p_kind text, p_entity_id uuid, p_locale text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.books b
    join public.book_localizations bl on bl.book_id = b.id and bl.locale = p_locale
    where b.status = 'published'
      and case p_kind
        when 'author' then b.primary_author_id = p_entity_id
        when 'series' then exists (
          select 1 from public.book_series bs where bs.book_id = b.id and bs.series_id = p_entity_id
        )
        when 'topic' then exists (
          select 1 from public.book_topics bt where bt.book_id = b.id and bt.topic_id = p_entity_id
        )
        else false
      end
  );
$$;

create function public.catalog_book_cards(p_locale text)
returns table (
  book_id uuid,
  slug text,
  title text,
  subtitle text,
  short_description text,
  author_name text,
  author_slug text,
  cover_path text,
  cover_alt text,
  price_minor bigint,
  currency text,
  has_active_publication boolean,
  has_sample boolean,
  series_slug text,
  series_name text,
  series_position integer,
  topics jsonb,
  featured boolean,
  shelf_position integer,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    bl.slug,
    bl.title,
    bl.subtitle,
    bl.short_description,
    coalesce(al.name, a.display_name),
    al.slug,
    cover.storage_key,
    cover.alt_text,
    offer.price_minor,
    offer.currency,
    exists (
      select 1 from public.ebook_publications p
      where p.id = b.active_publication_id and p.status = 'published'
    ),
    exists (
      select 1 from public.book_samples s
      join public.ebook_publications p on p.id = s.publication_id
      where p.id = b.active_publication_id
        and p.status = 'published'
        and jsonb_array_length(s.allowed_hrefs) > 0
    ),
    series.slug,
    series.name,
    series.position,
    coalesce((
      select jsonb_agg(jsonb_build_object('slug', tl.slug, 'name', tl.name) order by tl.name)
      from public.book_topics bt
      join public.topics t on t.id = bt.topic_id and t.status = 'published'
      join public.topic_localizations tl on tl.topic_id = t.id and tl.locale = p_locale
      where bt.book_id = b.id
    ), '[]'::jsonb),
    exists (
      select 1 from public.merchandising_slots ms
      where ms.book_id = b.id and ms.slot_key = 'home_featured' and ms.active
    ),
    (
      select ms.position from public.merchandising_slots ms
      where ms.book_id = b.id and ms.slot_key = 'home_shelf' and ms.active
    ),
    b.created_at
  from public.books b
  join public.book_localizations bl on bl.book_id = b.id and bl.locale = p_locale
  join public.authors a on a.id = b.primary_author_id
  left join public.author_localizations al
    on al.author_id = a.id and al.locale = p_locale and a.status = 'published'
  left join lateral (
    select m.storage_key, m.alt_text
    from public.media_assets m
    where m.owner_type = 'book' and m.owner_id = b.id and m.kind = 'cover'
    limit 1
  ) cover on true
  left join lateral (
    -- MVP books have one ebook offer. If there are more, the cheapest wins.
    select o.price_minor, o.currency
    from public.offers o
    join public.skus sk on sk.id = o.sku_id
    join public.editions e on e.id = sk.edition_id
    where e.book_id = b.id
      and o.active and sk.active
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at is null or o.ends_at > now())
    order by o.price_minor, o.currency
    limit 1
  ) offer on true
  left join lateral (
    select sl.slug, sl.name, bs.position
    from public.book_series bs
    join public.series sr on sr.id = bs.series_id and sr.status = 'published'
    join public.series_localizations sl on sl.series_id = sr.id and sl.locale = p_locale
    where bs.book_id = b.id
  ) series on true
  where b.status = 'published';
$$;

create function public.catalog_book_page(p_locale text, p_slug text)
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
    )
  )
  from public.book_localizations bl
  join public.books b on b.id = bl.book_id
  where bl.locale = p_locale and bl.slug = p_slug and b.status = 'published';
$$;

create function public.catalog_entity_page(p_kind text, p_locale text, p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_other_locale text := case p_locale when 'vi' then 'en' when 'en' then 'vi' end;
  v_id uuid;
  v_name text;
  v_description text;
  v_alternate_slug text;
begin
  if v_other_locale is null then
    return null;
  end if;

  if p_kind = 'author' then
    select a.id, l.name, l.description into v_id, v_name, v_description
    from public.author_localizations l
    join public.authors a on a.id = l.author_id
    where l.locale = p_locale and l.slug = p_slug and a.status = 'published';
    select l.slug into v_alternate_slug
    from public.author_localizations l
    where l.author_id = v_id and l.locale = v_other_locale;
  elsif p_kind = 'series' then
    select s.id, l.name, l.description into v_id, v_name, v_description
    from public.series_localizations l
    join public.series s on s.id = l.series_id
    where l.locale = p_locale and l.slug = p_slug and s.status = 'published';
    select l.slug into v_alternate_slug
    from public.series_localizations l
    where l.series_id = v_id and l.locale = v_other_locale;
  elsif p_kind = 'topic' then
    select t.id, l.name, l.description into v_id, v_name, v_description
    from public.topic_localizations l
    join public.topics t on t.id = l.topic_id
    where l.locale = p_locale and l.slug = p_slug and t.status = 'published';
    select l.slug into v_alternate_slug
    from public.topic_localizations l
    where l.topic_id = v_id and l.locale = v_other_locale;
  else
    return null;
  end if;

  if v_id is null or not public.catalog_has_visible_book(p_kind, v_id, p_locale) then
    return null;
  end if;

  -- The other-locale page only exists when it also has a visible book.
  if v_alternate_slug is not null and not public.catalog_has_visible_book(p_kind, v_id, v_other_locale) then
    v_alternate_slug := null;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'name', v_name,
    'description', v_description,
    'alternateSlug', v_alternate_slug
  );
end;
$$;

revoke execute on function public.catalog_has_visible_book(text, uuid, text) from public, anon, authenticated;

revoke execute on function public.catalog_book_cards(text) from public;
grant execute on function public.catalog_book_cards(text) to anon, authenticated;
revoke execute on function public.catalog_book_page(text, text) from public;
grant execute on function public.catalog_book_page(text, text) to anon, authenticated;
revoke execute on function public.catalog_entity_page(text, text, text) from public;
grant execute on function public.catalog_entity_page(text, text, text) to anon, authenticated;
```

- [ ] **Step 5: Apply, run the tests, and verify they pass**

Run:

```bash
supabase db reset
supabase test db
```

Expected: every file passes, including `016_public_catalog_reads.sql` (30 tests).

- [ ] **Step 6: Regenerate the types**

Run: `supabase gen types --local --lang typescript > lib/supabase/database.types.ts`
Expected: the `Functions` section now lists `catalog_book_cards`, `catalog_book_page`, and `catalog_entity_page`.

- [ ] **Step 7: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add supabase/migrations/20260915100000_public_catalog_reads.sql supabase/tests/016_public_catalog_reads.sql lib/supabase/database.types.ts
git commit -m "feat(db): add public catalog read functions"
```

---

### Task 2: Catalog search function

**Files:**
- Create: `supabase/migrations/20260915110000_catalog_search.sql`
- Create: `supabase/tests/017_catalog_search.sql`
- Modify: `lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: `public.catalog_has_visible_book` from Task 1; `extensions.unaccent`.
- Produces: `public.search_catalog(p_locale text, p_query text)` returns table `(kind text, slug text, name text, score integer)`. `kind` is `book`, `author`, `series`, or `topic`. `score` is 1–3. At most 20 rows per kind. Empty for a query shorter than 2 or longer than 100 characters after trimming, or an unsupported locale.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/017_catalog_search.sql`:

```sql
begin;
select plan(17);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's2-search-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e2000000-0000-0000-0000-000000000001', 's2s-author', 'Nguyễn Nhật Ánh S2S', 'published');
insert into public.author_localizations (author_id, locale, slug, name)
values ('e2000000-0000-0000-0000-000000000001', 'vi', 's2s-nguyen-nhat-anh', 'Nguyễn Nhật Ánh S2S');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e3000000-0000-0000-0000-000000000001', 's2s-exact', 'vi', 'e2000000-0000-0000-0000-000000000001', 'published'),
  ('e3000000-0000-0000-0000-000000000002', 's2s-partial', 'vi', 'e2000000-0000-0000-0000-000000000001', 'published'),
  ('e3000000-0000-0000-0000-000000000003', 's2s-draft', 'vi', 'e2000000-0000-0000-0000-000000000001', 'draft');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e3000000-0000-0000-0000-000000000001', 'vi', 's2s-nhan-tam', 'Nhân Tâm S2S'),
  ('e3000000-0000-0000-0000-000000000002', 'vi', 's2s-dac-nhan-tam', 'Đắc Nhân Tâm S2S'),
  ('e3000000-0000-0000-0000-000000000003', 'vi', 's2s-sach-nhap', 'Nhân Tâm S2S Nháp');

insert into public.topics (id, canonical_slug, name, status) values
  ('e5000000-0000-0000-0000-000000000001', 's2s-topic', 'Tâm Lý S2S', 'published'),
  ('e5000000-0000-0000-0000-000000000002', 's2s-draft-topic', 'Tâm Lý Nháp S2S', 'draft');
insert into public.topic_localizations (topic_id, locale, slug, name) values
  ('e5000000-0000-0000-0000-000000000001', 'vi', 's2s-tam-ly', 'Tâm Lý S2S'),
  ('e5000000-0000-0000-0000-000000000002', 'vi', 's2s-tam-ly-nhap', 'Tâm Lý Nháp S2S');
insert into public.book_topics (book_id, topic_id) values
  ('e3000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001'),
  ('e3000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000002');

-- (1)-(2) Grants.
select is(has_function_privilege('anon', 'public.search_catalog(text, text)', 'EXECUTE'), true, 'anon can search');
select is(has_function_privilege('authenticated', 'public.catalog_match_score(text, text)', 'EXECUTE'), false, 'the score helper is internal');

set local role anon;

-- (3)-(6) Diacritics and case do not matter.
select is((select score from public.search_catalog('vi', 'dac nhan tam s2s') where slug = 's2s-dac-nhan-tam'), 3, 'a query without diacritics matches exactly');
select is((select score from public.search_catalog('vi', 'Đắc Nhân Tâm S2S') where slug = 's2s-dac-nhan-tam'), 3, 'a query with diacritics matches exactly');
select is((select score from public.search_catalog('vi', 'ĐẮC NHÂN TÂM S2S') where slug = 's2s-dac-nhan-tam'), 3, 'an upper-case query matches exactly');
select is((select score from public.search_catalog('vi', 'dac nhan') where slug = 's2s-dac-nhan-tam'), 2, 'a prefix scores 2');

-- (7)-(8) An exact title outranks a partial one.
select is((select score from public.search_catalog('vi', 'nhan tam s2s') where slug = 's2s-nhan-tam'), 3, 'the exact title scores 3');
select is((select score from public.search_catalog('vi', 'nhan tam s2s') where slug = 's2s-dac-nhan-tam'), 1, 'the containing title scores 1');

-- (9) Drafts never match.
select is((select count(*)::bigint from public.search_catalog('vi', 'nhan tam s2s') where slug = 's2s-sach-nhap'), 0::bigint, 'a draft book never matches');

-- (10)-(11) An exact author name lifts their books and returns the author.
select is((select score from public.search_catalog('vi', 'nguyen nhat anh s2s') where kind = 'book' and slug = 's2s-dac-nhan-tam'), 3, 'an exact author name scores their book 3');
select is((select count(*)::bigint from public.search_catalog('vi', 'nguyen nhat anh s2s') where kind = 'author'), 1::bigint, 'the author is returned');

-- (12)-(13) Topics follow visibility.
select is((select count(*)::bigint from public.search_catalog('vi', 'tam ly s2s') where kind = 'topic' and slug = 's2s-tam-ly'), 1::bigint, 'a published topic matches');
select is((select count(*)::bigint from public.search_catalog('vi', 'tam ly nhap s2s') where kind = 'topic' and slug = 's2s-tam-ly-nhap'), 0::bigint, 'a draft topic never matches');

-- (14) A small typo still matches through trigram word similarity.
select cmp_ok((select count(*)::bigint from public.search_catalog('vi', 'nhan tamm s2s') where kind = 'book'), '>=', 1::bigint, 'a small typo still matches');

-- (15)-(16) Guard rails.
select is((select count(*)::bigint from public.search_catalog('vi', ' a ')), 0::bigint, 'a one-character query returns nothing');
select is((select count(*)::bigint from public.search_catalog('en', 'nhan tam s2s')), 0::bigint, 'vi-only books do not match in en');

reset role;

-- (17) An admin caller still gets the public view.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);
select is((select count(*)::bigint from public.search_catalog('vi', 'nhan tam s2s') where slug = 's2s-sach-nhap'), 0::bigint, 'an admin search does not return drafts');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `supabase test db`
Expected: FAIL in `017_catalog_search.sql`: function `public.search_catalog(text, text)` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260915110000_catalog_search.sql`:

```sql
-- S2 catalog search. See docs/superpowers/specs/2026-09-15-s2-public-discovery-design.md (4.5).
--
-- The catalog is small, so there is no index. unaccent() is not immutable, so an expression index
-- would need a wrapper anyway. Revisit when search shows up in slow query logs.

create extension if not exists pg_trgm with schema extensions;

-- "Đắc Nhân Tâm" -> "dac nhan tam". Same unaccent call as admin_create_book (20260913150000).
create function public.catalog_normalize(p_value text)
returns text
language sql
stable
set search_path = ''
as $$
  select lower(extensions.unaccent(coalesce(p_value, '')));
$$;

-- p_query must already be normalized. 3 = exact, 2 = prefix, 1 = contains or close, 0 = no match.
create function public.catalog_match_score(p_name text, p_query text)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when n.name = p_query then 3
    when starts_with(n.name, p_query) then 2
    when strpos(n.name, p_query) > 0 or extensions.word_similarity(p_query, n.name) >= 0.4 then 1
    else 0
  end
  from (select public.catalog_normalize(p_name) as name) n;
$$;

create function public.search_catalog(p_locale text, p_query text)
returns table (kind text, slug text, name text, score integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_trimmed text := btrim(coalesce(p_query, ''));
  v_query text;
begin
  if p_locale not in ('vi', 'en') or char_length(v_trimmed) < 2 or char_length(v_trimmed) > 100 then
    return;
  end if;
  v_query := public.catalog_normalize(v_trimmed);

  return query
  with scored as (
    select
      'book'::text as kind,
      bl.slug,
      bl.title as name,
      greatest(
        public.catalog_match_score(bl.title, v_query),
        case when public.catalog_normalize(coalesce(al.name, a.display_name)) = v_query then 3 else 0 end
      ) as score
    from public.books b
    join public.book_localizations bl on bl.book_id = b.id and bl.locale = p_locale
    join public.authors a on a.id = b.primary_author_id
    left join public.author_localizations al on al.author_id = a.id and al.locale = p_locale
    where b.status = 'published'

    union all

    select 'author'::text, l.slug, l.name, public.catalog_match_score(l.name, v_query)
    from public.author_localizations l
    join public.authors a on a.id = l.author_id
    where l.locale = p_locale
      and a.status = 'published'
      and public.catalog_has_visible_book('author', a.id, p_locale)

    union all

    select 'series'::text, l.slug, l.name, public.catalog_match_score(l.name, v_query)
    from public.series_localizations l
    join public.series s on s.id = l.series_id
    where l.locale = p_locale
      and s.status = 'published'
      and public.catalog_has_visible_book('series', s.id, p_locale)

    union all

    select 'topic'::text, l.slug, l.name, public.catalog_match_score(l.name, v_query)
    from public.topic_localizations l
    join public.topics t on t.id = l.topic_id
    where l.locale = p_locale
      and t.status = 'published'
      and public.catalog_has_visible_book('topic', t.id, p_locale)
  ),
  ranked as (
    select
      s.kind,
      s.slug,
      s.name,
      s.score,
      row_number() over (partition by s.kind order by s.score desc, s.name) as kind_rank
    from scored s
    where s.score > 0
  )
  select r.kind, r.slug, r.name, r.score
  from ranked r
  where r.kind_rank <= 20
  order by r.score desc, r.kind, r.name;
end;
$$;

revoke execute on function public.catalog_normalize(text) from public, anon, authenticated;
revoke execute on function public.catalog_match_score(text, text) from public, anon, authenticated;

revoke execute on function public.search_catalog(text, text) from public;
grant execute on function public.search_catalog(text, text) to anon, authenticated;
```

- [ ] **Step 4: Apply, run the tests, and verify they pass**

Run:

```bash
supabase db reset
supabase test db
```

Expected: every file passes, including `017_catalog_search.sql` (17 tests).

If test 14 (typo) fails, run `select extensions.word_similarity('nhan tamm s2s', 'dac nhan tam s2s');` and report the value. Do not lower the threshold below `0.4` without a spec change.

- [ ] **Step 5: Regenerate the types, run the checks, and commit**

```bash
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
npm run check
git add supabase/migrations/20260915110000_catalog_search.sql supabase/tests/017_catalog_search.sql lib/supabase/database.types.ts
git commit -m "feat(db): add diacritic-insensitive catalog search"
```

Expected: `npm run check` passes.

---
### Task 3: Catalog pure logic

**Files:**
- Create: `lib/catalog/book-action.ts`, `lib/catalog/book-action.test.ts`
- Create: `lib/catalog/price.ts`, `lib/catalog/price.test.ts`
- Create: `lib/catalog/public-types.ts`
- Create: `lib/catalog/browse.ts`, `lib/catalog/browse.test.ts`
- Create: `lib/catalog/search.ts`, `lib/catalog/search.test.ts`
- Create: `lib/i18n/format.ts`, `lib/i18n/format.test.ts`

**Interfaces:**
- Consumes: `Locale` from `lib/i18n/config.ts`.
- Produces:
  - `type BookAction = "read" | "get_free" | "buy" | "coming_soon" | "unavailable"`
  - `resolveBookAction(input: BookActionInput): BookAction`
  - `formatPrice(priceMinor: number, currency: string, locale: Locale): string`
  - `type CatalogBookCard`, `type CatalogTopicRef`, `type CatalogEntityKind = "author" | "series" | "topic"`
  - `type CatalogFilters`, `parseCatalogFilters(params)`, `hasActiveFilters(filters)`
  - `filterAndSortBooks(cards, filters, locale)`, `sortBooks(cards, sort, locale)`
  - `booksForEntity(cards, kind, slug, locale)`, `homeShelves(cards)`, `catalogFilterOptions(cards, locale)`
  - `type SearchHit`, `normalizeSearchQuery(value)`, `groupSearchHits(hits, locale)`
  - `fillTemplate(template, values)`

- [ ] **Step 1: Write the failing tests**

Create `lib/catalog/book-action.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { type BookActionInput, resolveBookAction } from "@/lib/catalog/book-action";

const base: BookActionInput = {
  hasActiveEntitlement: false,
  offer: { priceMinor: 0, active: true },
  hasActivePublication: true,
  paymentsEnabled: true,
};

describe("resolveBookAction", () => {
  it.each([
    ["an entitled reader reads", { hasActiveEntitlement: true }, "read"],
    ["an entitled reader reads even without an offer", { hasActiveEntitlement: true, offer: null }, "read"],
    ["no publication is unavailable, even when entitled", { hasActiveEntitlement: true, hasActivePublication: false }, "unavailable"],
    ["no offer is unavailable", { offer: null }, "unavailable"],
    ["an inactive offer is unavailable", { offer: { priceMinor: 0, active: false } }, "unavailable"],
    ["a free offer is get_free", {}, "get_free"],
    ["a paid offer with payments is buy", { offer: { priceMinor: 129000, active: true } }, "buy"],
    ["a paid offer without payments is coming_soon", { offer: { priceMinor: 129000, active: true }, paymentsEnabled: false }, "coming_soon"],
    ["a free offer ignores disabled payments", { paymentsEnabled: false }, "get_free"],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(resolveBookAction({ ...base, ...overrides })).toBe(expected);
  });
});
```

Create `lib/catalog/price.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatPrice } from "@/lib/catalog/price";

// Intl uses non-breaking spaces. Compare with plain spaces.
const plain = (value: string) => value.replace(/\s/gu, " ");

describe("formatPrice", () => {
  it("formats VND, which has no minor digits", () => {
    expect(plain(formatPrice(129000, "VND", "vi"))).toBe("129.000 ₫");
  });

  it("formats USD minor units as cents", () => {
    expect(formatPrice(1299, "USD", "en")).toBe("$12.99");
  });
});
```

Create `lib/i18n/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { fillTemplate } from "@/lib/i18n/format";

describe("fillTemplate", () => {
  it("replaces known placeholders and keeps unknown ones", () => {
    expect(fillTemplate("Book {position} in {series} {missing}", { position: 2, series: "Harbour" })).toBe(
      "Book 2 in Harbour {missing}",
    );
  });
});
```

Create `lib/catalog/browse.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  booksForEntity,
  catalogFilterOptions,
  filterAndSortBooks,
  hasActiveFilters,
  homeShelves,
  parseCatalogFilters,
} from "@/lib/catalog/browse";
import type { CatalogBookCard } from "@/lib/catalog/public-types";

function card(overrides: Partial<CatalogBookCard> & { bookId: string }): CatalogBookCard {
  return {
    slug: overrides.bookId,
    title: overrides.bookId,
    subtitle: null,
    shortDescription: null,
    author: { name: "Author", slug: "author" },
    cover: null,
    offer: { priceMinor: 0, currency: "VND" },
    hasActivePublication: true,
    hasSample: false,
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00+00:00",
    ...overrides,
  };
}

const older = card({ bookId: "older", title: "Ánh trăng", createdAt: "2026-09-01T00:00:00+00:00" });
const newer = card({
  bookId: "newer",
  title: "Bến cảng",
  createdAt: "2026-09-05T00:00:00+00:00",
  offer: { priceMinor: 129000, currency: "VND" },
  topics: [{ slug: "habits", name: "Habits" }],
});
const shelved = card({
  bookId: "shelved",
  title: "Cánh đồng",
  shelfPosition: 1,
  author: { name: "Other", slug: "other" },
  series: { slug: "harbour", name: "Harbour", position: 2 },
});
const first = card({ bookId: "first", series: { slug: "harbour", name: "Harbour", position: 1 }, featured: true });

describe("parseCatalogFilters", () => {
  it("reads known values and ignores unknown ones", () => {
    expect(parseCatalogFilters({ topic: "habits", author: ["other", "x"], series: "Bad Slug", price: "cheap", sort: "title" })).toEqual({
      topic: "habits",
      author: "other",
      series: null,
      price: null,
      sort: "title",
    });
  });

  it("defaults to the featured sort with no filters", () => {
    const filters = parseCatalogFilters({});
    expect(filters.sort).toBe("featured");
    expect(hasActiveFilters(filters)).toBe(false);
    expect(hasActiveFilters({ ...filters, price: "free" })).toBe(true);
  });
});

describe("filterAndSortBooks", () => {
  const all = [older, newer, shelved];

  it("filters by topic, author, series, and price", () => {
    const none = parseCatalogFilters({});
    expect(filterAndSortBooks(all, { ...none, topic: "habits" }, "vi")).toEqual([newer]);
    expect(filterAndSortBooks(all, { ...none, author: "other" }, "vi")).toEqual([shelved]);
    expect(filterAndSortBooks(all, { ...none, series: "harbour" }, "vi")).toEqual([shelved]);
    expect(filterAndSortBooks(all, { ...none, price: "paid" }, "vi")).toEqual([newer]);
    expect(filterAndSortBooks(all, { ...none, price: "free" }, "vi").map((book) => book.bookId)).toEqual(["shelved", "older"]);
  });

  it("puts shelf books first, then newest, for the featured sort", () => {
    expect(filterAndSortBooks(all, parseCatalogFilters({}), "vi").map((book) => book.bookId)).toEqual(["shelved", "newer", "older"]);
  });

  it("sorts by newest and by title", () => {
    expect(filterAndSortBooks(all, parseCatalogFilters({ sort: "newest" }), "vi").map((book) => book.bookId)).toEqual(["newer", "older", "shelved"]);
    expect(filterAndSortBooks(all, parseCatalogFilters({ sort: "title" }), "vi").map((book) => book.title)).toEqual(["Ánh trăng", "Bến cảng", "Cánh đồng"]);
  });

  it("never mutates its input", () => {
    const input = [older, newer];
    filterAndSortBooks(input, parseCatalogFilters({ sort: "newest" }), "vi");
    expect(input).toEqual([older, newer]);
  });
});

describe("booksForEntity", () => {
  it("orders series books by position", () => {
    expect(booksForEntity([shelved, first, older], "series", "harbour", "vi")).toEqual([first, shelved]);
  });

  it("finds author and topic books", () => {
    expect(booksForEntity([older, shelved], "author", "other", "vi")).toEqual([shelved]);
    expect(booksForEntity([older, newer], "topic", "habits", "vi")).toEqual([newer]);
  });
});

describe("homeShelves", () => {
  it("returns the featured book and the shelf in order", () => {
    const second = card({ bookId: "second", shelfPosition: 2 });
    expect(homeShelves([second, first, shelved, older])).toEqual({ featured: first, shelf: [shelved, second] });
    expect(homeShelves([older])).toEqual({ featured: null, shelf: [] });
  });
});

describe("catalogFilterOptions", () => {
  it("lists each topic, author, and series once, sorted by name", () => {
    expect(catalogFilterOptions([older, newer, shelved, first], "vi")).toEqual({
      topics: [{ slug: "habits", name: "Habits" }],
      authors: [
        { slug: "author", name: "Author" },
        { slug: "other", name: "Other" },
      ],
      series: [{ slug: "harbour", name: "Harbour" }],
    });
  });
});
```

Create `lib/catalog/search.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { groupSearchHits, normalizeSearchQuery } from "@/lib/catalog/search";

describe("normalizeSearchQuery", () => {
  it("trims and keeps queries of 2 to 100 characters", () => {
    expect(normalizeSearchQuery("  nhân tâm ")).toBe("nhân tâm");
    expect(normalizeSearchQuery(["ab", "cd"])).toBe("ab");
    expect(normalizeSearchQuery(" a ")).toBeNull();
    expect(normalizeSearchQuery("x".repeat(101))).toBeNull();
    expect(normalizeSearchQuery(undefined)).toBeNull();
  });
});

describe("groupSearchHits", () => {
  it("groups by kind and orders by score, then name", () => {
    const grouped = groupSearchHits(
      [
        { kind: "book", slug: "b", name: "Bến", score: 1 },
        { kind: "author", slug: "a", name: "An", score: 2 },
        { kind: "book", slug: "a", name: "Ánh", score: 1 },
        { kind: "book", slug: "c", name: "Cảng", score: 3 },
        { kind: "topic", slug: "t", name: "Tâm", score: 1 },
      ],
      "vi",
    );
    expect(grouped.books.map((hit) => hit.slug)).toEqual(["c", "a", "b"]);
    expect(grouped.authors.map((hit) => hit.slug)).toEqual(["a"]);
    expect(grouped.series).toEqual([]);
    expect(grouped.topics.map((hit) => hit.slug)).toEqual(["t"]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run lib/catalog/book-action.test.ts lib/catalog/price.test.ts lib/catalog/browse.test.ts lib/catalog/search.test.ts lib/i18n/format.test.ts`
Expected: FAIL. The modules do not exist.

- [ ] **Step 3: Write the implementation**

Create `lib/catalog/book-action.ts`:

```ts
// What a reader can do with a book. Parent spec 3.3. The book page, search, sample reader, and
// library all use this. Server actions and RPCs re-check the same rules; this never grants access.
export type BookAction = "read" | "get_free" | "buy" | "coming_soon" | "unavailable";

export type BookActionInput = {
  hasActiveEntitlement: boolean;
  offer: { priceMinor: number; active: boolean } | null;
  hasActivePublication: boolean;
  paymentsEnabled: boolean;
};

export function resolveBookAction(input: BookActionInput): BookAction {
  if (!input.hasActivePublication) return "unavailable";
  if (input.hasActiveEntitlement) return "read";
  if (!input.offer?.active) return "unavailable";
  if (input.offer.priceMinor === 0) return "get_free";
  return input.paymentsEnabled ? "buy" : "coming_soon";
}
```

Create `lib/catalog/price.ts`:

```ts
import type { Locale } from "@/lib/i18n/config";

const localeTags: Record<Locale, string> = { vi: "vi-VN", en: "en-US" };

// offers.price_minor is in the currency's minor unit. VND has none, so 129000 is 129.000 ₫.
export function formatPrice(priceMinor: number, currency: string, locale: Locale): string {
  const formatter = new Intl.NumberFormat(localeTags[locale], { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
  return formatter.format(priceMinor / 10 ** digits);
}
```

Create `lib/i18n/format.ts`:

```ts
// Fills "{name}" placeholders in dictionary copy.
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
```

Create `lib/catalog/public-types.ts`:

```ts
// Shapes that public pages render. They hold no storage keys except the public cover URL, no
// publication IDs, and no entitlement data.

export type CatalogEntityKind = "author" | "series" | "topic";

export type CatalogTopicRef = { slug: string; name: string };

export type CatalogBookCard = {
  bookId: string;
  slug: string;
  title: string;
  subtitle: string | null;
  shortDescription: string | null;
  // slug is null when the author has no public page in this locale.
  author: { name: string; slug: string | null };
  cover: { url: string; alt: string } | null;
  // Only active, in-window offers reach this type.
  offer: { priceMinor: number; currency: string } | null;
  hasActivePublication: boolean;
  hasSample: boolean;
  series: { slug: string; name: string; position: number } | null;
  topics: CatalogTopicRef[];
  featured: boolean;
  shelfPosition: number | null;
  createdAt: string;
};

export type CatalogBookPage = CatalogBookCard & {
  description: string | null;
  audience: string | null;
  keyIdeas: { title: string; summary: string }[];
  faq: { question: string; answer: string }[];
  seoTitle: string | null;
  seoDescription: string | null;
  alternateSlug: string | null;
};

export type CatalogEntityPage = {
  kind: CatalogEntityKind;
  id: string;
  name: string;
  description: string | null;
  alternateSlug: string | null;
  books: CatalogBookCard[];
};
```

Create `lib/catalog/browse.ts`:

```ts
import type { CatalogBookCard, CatalogEntityKind, CatalogTopicRef } from "@/lib/catalog/public-types";
import type { Locale } from "@/lib/i18n/config";

export const catalogSorts = ["featured", "newest", "title"] as const;
export type CatalogSort = (typeof catalogSorts)[number];

export type CatalogFilters = {
  topic: string | null;
  author: string | null;
  series: string | null;
  price: "free" | "paid" | null;
  sort: CatalogSort;
};

export type CatalogSearchParams = Record<string, string | string[] | undefined>;

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function slugParam(params: CatalogSearchParams, key: string): string | null {
  const value = firstValue(params[key])?.trim();
  return value && slugPattern.test(value) ? value : null;
}

// Unknown or malformed values are ignored, never an error: these come straight from the URL.
export function parseCatalogFilters(params: CatalogSearchParams): CatalogFilters {
  const price = firstValue(params.price);
  const sort = firstValue(params.sort);
  return {
    topic: slugParam(params, "topic"),
    author: slugParam(params, "author"),
    series: slugParam(params, "series"),
    price: price === "free" || price === "paid" ? price : null,
    sort: catalogSorts.find((candidate) => candidate === sort) ?? "featured",
  };
}

export function hasActiveFilters(filters: CatalogFilters): boolean {
  return Boolean(filters.topic || filters.author || filters.series || filters.price) || filters.sort !== "featured";
}

function newestFirst(left: CatalogBookCard, right: CatalogBookCard): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.bookId.localeCompare(right.bookId);
}

export function sortBooks(cards: CatalogBookCard[], sort: CatalogSort, locale: Locale): CatalogBookCard[] {
  const sorted = [...cards];
  if (sort === "title") {
    const collator = new Intl.Collator(locale);
    return sorted.sort((left, right) => collator.compare(left.title, right.title));
  }
  if (sort === "newest") return sorted.sort(newestFirst);
  return sorted.sort((left, right) => {
    if (left.shelfPosition !== null && right.shelfPosition !== null) return left.shelfPosition - right.shelfPosition;
    if (left.shelfPosition !== null) return -1;
    if (right.shelfPosition !== null) return 1;
    return newestFirst(left, right);
  });
}

export function filterAndSortBooks(cards: CatalogBookCard[], filters: CatalogFilters, locale: Locale): CatalogBookCard[] {
  const matches = cards.filter(
    (card) =>
      (!filters.topic || card.topics.some((topic) => topic.slug === filters.topic)) &&
      (!filters.author || card.author.slug === filters.author) &&
      (!filters.series || card.series?.slug === filters.series) &&
      (!filters.price ||
        (card.offer !== null && (filters.price === "free" ? card.offer.priceMinor === 0 : card.offer.priceMinor > 0))),
  );
  return sortBooks(matches, filters.sort, locale);
}

export function booksForEntity(
  cards: CatalogBookCard[],
  kind: CatalogEntityKind,
  slug: string,
  locale: Locale,
): CatalogBookCard[] {
  if (kind === "series") {
    return cards
      .filter((card) => card.series?.slug === slug)
      .sort((left, right) => (left.series?.position ?? 0) - (right.series?.position ?? 0));
  }
  const matches =
    kind === "author"
      ? cards.filter((card) => card.author.slug === slug)
      : cards.filter((card) => card.topics.some((topic) => topic.slug === slug));
  return sortBooks(matches, "newest", locale);
}

export function homeShelves(cards: CatalogBookCard[]): { featured: CatalogBookCard | null; shelf: CatalogBookCard[] } {
  return {
    featured: cards.find((card) => card.featured) ?? null,
    shelf: cards
      .filter((card) => card.shelfPosition !== null)
      .sort((left, right) => (left.shelfPosition ?? 0) - (right.shelfPosition ?? 0)),
  };
}

export type CatalogFilterOptions = {
  topics: CatalogTopicRef[];
  authors: CatalogTopicRef[];
  series: CatalogTopicRef[];
};

function uniqueSorted(entries: CatalogTopicRef[], collator: Intl.Collator): CatalogTopicRef[] {
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  return [...bySlug.values()].sort((left, right) => collator.compare(left.name, right.name));
}

// Options come from visible books only, so every option returns at least one book.
export function catalogFilterOptions(cards: CatalogBookCard[], locale: Locale): CatalogFilterOptions {
  const collator = new Intl.Collator(locale);
  return {
    topics: uniqueSorted(cards.flatMap((card) => card.topics), collator),
    authors: uniqueSorted(
      cards.flatMap((card) => (card.author.slug ? [{ slug: card.author.slug, name: card.author.name }] : [])),
      collator,
    ),
    series: uniqueSorted(
      cards.flatMap((card) => (card.series ? [{ slug: card.series.slug, name: card.series.name }] : [])),
      collator,
    ),
  };
}
```

Create `lib/catalog/search.ts`:

```ts
import type { Locale } from "@/lib/i18n/config";

export type SearchHitKind = "book" | "author" | "series" | "topic";
export type SearchHit = { kind: SearchHitKind; slug: string; name: string; score: number };

export type GroupedSearchHits = {
  books: SearchHit[];
  authors: SearchHit[];
  series: SearchHit[];
  topics: SearchHit[];
};

// Same bounds as search_catalog (20260915110000). Outside them the page shows the prompt state.
export function normalizeSearchQuery(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim() ?? "";
  return trimmed.length >= 2 && trimmed.length <= 100 ? trimmed : null;
}

export function groupSearchHits(hits: SearchHit[], locale: Locale): GroupedSearchHits {
  const collator = new Intl.Collator(locale);
  const ordered = [...hits].sort((left, right) => right.score - left.score || collator.compare(left.name, right.name));
  const ofKind = (kind: SearchHitKind) => ordered.filter((hit) => hit.kind === kind);
  return { books: ofKind("book"), authors: ofKind("author"), series: ofKind("series"), topics: ofKind("topic") };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run lib/catalog/book-action.test.ts lib/catalog/price.test.ts lib/catalog/browse.test.ts lib/catalog/search.test.ts lib/i18n/format.test.ts`
Expected: PASS.

Note: the `vi` collator sorts "Ánh", "Bến", "Cánh" in that order. If the local ICU sorts differently, check `node -p "process.versions.icu"` and report it. Do not change the expected order.

- [ ] **Step 5: Run the checks and commit**

```bash
npm run check
git add lib/catalog/book-action.ts lib/catalog/book-action.test.ts lib/catalog/price.ts lib/catalog/price.test.ts lib/catalog/public-types.ts lib/catalog/browse.ts lib/catalog/browse.test.ts lib/catalog/search.ts lib/catalog/search.test.ts lib/i18n/format.ts lib/i18n/format.test.ts
git commit -m "feat(catalog): add book action, price, browse, and search logic"
```

---

### Task 4: Public catalog data layer

**Files:**
- Create: `lib/supabase/public.ts`
- Create: `lib/data/catalog.ts`, `lib/data/catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 functions; Task 3 types and helpers; `getCurrentProfile()` from `lib/data/profiles.ts`; `getServerEnv()` from `lib/config/server-env.ts`; `coverPublicUrl()` from `lib/catalog/covers.ts`.
- Produces:
  - `createPublicClient()`: a cookie-less, typed Supabase client.
  - `getBookCards(locale: Locale): Promise<CatalogBookCard[]>` (per-request cached)
  - `getBookPage(locale: Locale, slug: string): Promise<CatalogBookPage | null>` (per-request cached)
  - `getEntityPage(kind: CatalogEntityKind, locale: Locale, slug: string): Promise<CatalogEntityPage | null>` (per-request cached)
  - `getActiveEntitlementBookIds(profileId: string): Promise<Set<string>>`
  - `getBookActionState(card: Pick<CatalogBookCard, "bookId" | "offer" | "hasActivePublication">): Promise<{ action: BookAction; signedIn: boolean }>`
  - `searchCatalog(locale: Locale, query: string): Promise<CatalogSearchResults>` where `CatalogSearchResults = { books: CatalogBookCard[]; authors: SearchHit[]; series: SearchHit[]; topics: SearchHit[] }`

- [ ] **Step 1: Write the failing tests**

Create `lib/data/catalog.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getServerEnv } from "@/lib/config/server-env";
import {
  getActiveEntitlementBookIds,
  getBookActionState,
  getBookCards,
  getBookPage,
  getEntityPage,
  searchCatalog,
} from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/public", () => ({ createPublicClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/data/profiles", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_ID = "30000000-0000-4000-8000-000000000002";
const PROFILE_ID = "10000000-0000-4000-8000-000000000001";

function cardRow(overrides: Record<string, unknown> = {}) {
  return {
    book_id: BOOK_ID,
    slug: "a-book",
    title: "A Book",
    subtitle: null,
    short_description: "Short",
    author_name: "An Author",
    author_slug: "an-author",
    cover_path: `books/${BOOK_ID}/cover.png`,
    cover_alt: "Cover of A Book",
    price_minor: 0,
    currency: "VND",
    has_active_publication: true,
    has_sample: true,
    series_slug: "harbour",
    series_name: "Harbour",
    series_position: 2,
    topics: [{ slug: "habits", name: "Habits" }],
    featured: false,
    shelf_position: null,
    created_at: "2026-09-01T00:00:00+00:00",
    ...overrides,
  };
}

function mockRpc(results: Record<string, { data: unknown; error: unknown }>) {
  const rpc = vi.fn((name: string) => Promise.resolve(results[name] ?? { data: null, error: null }));
  vi.mocked(createPublicClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createPublicClient>);
  return rpc;
}

function mockEntitlements(rows: { book_id: string }[]) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
  const from = vi.fn(() => builder);
  vi.mocked(createClient).mockResolvedValue({ from } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { from, builder };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.mocked(getServerEnv).mockReturnValue({ paymentProvider: "simulator" } as ReturnType<typeof getServerEnv>);
  vi.mocked(getCurrentProfile).mockResolvedValue(null);
});

describe("getBookCards", () => {
  it("maps a row to a public card", async () => {
    const rpc = mockRpc({ catalog_book_cards: { data: [cardRow()], error: null } });
    const [book] = await getBookCards("en");
    expect(rpc).toHaveBeenCalledWith("catalog_book_cards", { p_locale: "en" });
    expect(book).toEqual({
      bookId: BOOK_ID,
      slug: "a-book",
      title: "A Book",
      subtitle: null,
      shortDescription: "Short",
      author: { name: "An Author", slug: "an-author" },
      cover: { url: `http://127.0.0.1:54321/storage/v1/object/public/covers/books/${BOOK_ID}/cover.png`, alt: "Cover of A Book" },
      offer: { priceMinor: 0, currency: "VND" },
      hasActivePublication: true,
      hasSample: true,
      series: { slug: "harbour", name: "Harbour", position: 2 },
      topics: [{ slug: "habits", name: "Habits" }],
      featured: false,
      shelfPosition: null,
      createdAt: "2026-09-01T00:00:00+00:00",
    });
  });

  it("drops a missing offer, cover, series, and malformed topics", async () => {
    mockRpc({
      catalog_book_cards: {
        data: [cardRow({ price_minor: null, currency: null, cover_path: null, series_slug: null, topics: "oops" })],
        error: null,
      },
    });
    const [book] = await getBookCards("en");
    expect(book.offer).toBeNull();
    expect(book.cover).toBeNull();
    expect(book.series).toBeNull();
    expect(book.topics).toEqual([]);
  });

  it("hides database error text", async () => {
    mockRpc({ catalog_book_cards: { data: null, error: { message: "relation secret_table does not exist" } } });
    await expect(getBookCards("en")).rejects.toThrow("getBookCards failed.");
  });
});

describe("getBookPage", () => {
  it("returns null for a malformed slug without a query", async () => {
    const rpc = mockRpc({});
    expect(await getBookPage("en", "Not A Slug")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns null when the book is not visible", async () => {
    mockRpc({ catalog_book_cards: { data: [cardRow()], error: null }, catalog_book_page: { data: null, error: null } });
    expect(await getBookPage("en", "a-book")).toBeNull();
  });

  it("merges the card with the page content and drops invalid key ideas", async () => {
    mockRpc({
      catalog_book_cards: { data: [cardRow()], error: null },
      catalog_book_page: {
        data: {
          bookId: BOOK_ID,
          description: "Long",
          audience: null,
          keyIdeas: [{ nope: true }],
          faq: [{ question: "Why?", answer: "Because." }],
          seoTitle: null,
          seoDescription: null,
          alternateSlug: "mot-cuon-sach",
        },
        error: null,
      },
    });
    const page = await getBookPage("en", "a-book");
    expect(page?.title).toBe("A Book");
    expect(page?.description).toBe("Long");
    expect(page?.keyIdeas).toEqual([]);
    expect(page?.faq).toEqual([{ question: "Why?", answer: "Because." }]);
    expect(page?.alternateSlug).toBe("mot-cuon-sach");
  });
});

describe("getEntityPage", () => {
  const entity = { id: "40000000-0000-4000-8000-000000000001", name: "Harbour", description: null, alternateSlug: null };

  it("returns the series with its books in order", async () => {
    mockRpc({
      catalog_book_cards: {
        data: [cardRow(), cardRow({ book_id: OTHER_ID, slug: "first", series_position: 1 })],
        error: null,
      },
      catalog_entity_page: { data: entity, error: null },
    });
    const page = await getEntityPage("series", "en", "harbour");
    expect(page?.name).toBe("Harbour");
    expect(page?.books.map((book) => book.slug)).toEqual(["first", "a-book"]);
  });

  it("returns null when the entity has no visible books", async () => {
    mockRpc({ catalog_book_cards: { data: [], error: null }, catalog_entity_page: { data: entity, error: null } });
    expect(await getEntityPage("series", "en", "harbour")).toBeNull();
  });
});

describe("book actions", () => {
  it("reads only the caller's own entitlements", async () => {
    const { from, builder } = mockEntitlements([{ book_id: BOOK_ID }]);
    expect(await getActiveEntitlementBookIds(PROFILE_ID)).toEqual(new Set([BOOK_ID]));
    expect(from).toHaveBeenCalledWith("entitlements");
    expect(builder.eq).toHaveBeenCalledWith("profile_id", PROFILE_ID);
    expect(builder.eq).toHaveBeenCalledWith("status", "active");
  });

  const free = { bookId: BOOK_ID, offer: { priceMinor: 0, currency: "VND" }, hasActivePublication: true };

  it("offers a signed-out reader get_free without reading entitlements", async () => {
    expect(await getBookActionState(free)).toEqual({ action: "get_free", signedIn: false });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("lets an entitled reader read", async () => {
    vi.mocked(getCurrentProfile).mockResolvedValue({ id: PROFILE_ID } as Awaited<ReturnType<typeof getCurrentProfile>>);
    mockEntitlements([{ book_id: BOOK_ID }]);
    expect(await getBookActionState(free)).toEqual({ action: "read", signedIn: true });
  });

  it("shows coming_soon for a paid book when payments are disabled", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ paymentProvider: "disabled" } as ReturnType<typeof getServerEnv>);
    expect(await getBookActionState({ ...free, offer: { priceMinor: 129000, currency: "VND" } })).toEqual({
      action: "coming_soon",
      signedIn: false,
    });
  });
});

describe("searchCatalog", () => {
  it("maps book hits to cards in rank order and keeps grouped hits", async () => {
    const rpc = mockRpc({
      catalog_book_cards: { data: [cardRow(), cardRow({ book_id: OTHER_ID, slug: "exact" })], error: null },
      search_catalog: {
        data: [
          { kind: "book", slug: "a-book", name: "A Book", score: 1 },
          { kind: "book", slug: "exact", name: "Exact", score: 3 },
          { kind: "author", slug: "an-author", name: "An Author", score: 2 },
          { kind: "book", slug: "gone", name: "Gone", score: 3 },
        ],
        error: null,
      },
    });
    const results = await searchCatalog("en", "exact");
    expect(rpc).toHaveBeenCalledWith("search_catalog", { p_locale: "en", p_query: "exact" });
    expect(results.books.map((book) => book.slug)).toEqual(["exact", "a-book"]);
    expect(results.authors.map((hit) => hit.slug)).toEqual(["an-author"]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run lib/data/catalog.test.ts`
Expected: FAIL. `@/lib/data/catalog` does not exist.

- [ ] **Step 3: Write the public client**

Create `lib/supabase/public.ts`:

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { getSupabaseEnv } from "@/lib/supabase/env";

// A cookie-less client for public catalog reads. It always runs as anon, so a public page is the
// same for every visitor. Never use it for user data; use lib/supabase/server.ts for that.
export function createPublicClient() {
  const { url, publishableKey } = getSupabaseEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });

  return createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
```

- [ ] **Step 4: Write the data layer**

Create `lib/data/catalog.ts`:

```ts
import "server-only";

import { cache } from "react";
import { z } from "zod";

import { type BookAction, resolveBookAction } from "@/lib/catalog/book-action";
import { booksForEntity } from "@/lib/catalog/browse";
import { coverPublicUrl } from "@/lib/catalog/covers";
import type {
  CatalogBookCard,
  CatalogBookPage,
  CatalogEntityKind,
  CatalogEntityPage,
} from "@/lib/catalog/public-types";
import { groupSearchHits, type SearchHit } from "@/lib/catalog/search";
import { getServerEnv } from "@/lib/config/server-env";
import { getCurrentProfile } from "@/lib/data/profiles";
import type { Locale } from "@/lib/i18n/config";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

// Public catalog reads. Everything except entitlements goes through the read functions in
// 20260915100000 and 20260915110000 with the cookie-less public client. Those functions filter to
// published rows themselves. Entitlements use the session client and an explicit profile filter,
// because admins can read every entitlement under RLS.

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function failure(operation: string): Error {
  return new Error(`${operation} failed.`);
}

// Generated types mark every returned column as non-null. These are the real shapes.
type CardRow = {
  book_id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  short_description: string | null;
  author_name: string;
  author_slug: string | null;
  cover_path: string | null;
  cover_alt: string | null;
  price_minor: number | null;
  currency: string | null;
  has_active_publication: boolean;
  has_sample: boolean;
  series_slug: string | null;
  series_name: string | null;
  series_position: number | null;
  topics: unknown;
  featured: boolean;
  shelf_position: number | null;
  created_at: string;
};

const topicsSchema = z.array(z.object({ slug: z.string(), name: z.string() })).catch([]);

function toCard(row: CardRow): CatalogBookCard {
  return {
    bookId: row.book_id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    shortDescription: row.short_description,
    author: { name: row.author_name, slug: row.author_slug },
    cover: row.cover_path ? { url: coverPublicUrl(row.cover_path), alt: row.cover_alt ?? row.title } : null,
    offer:
      row.price_minor === null || row.currency === null
        ? null
        : { priceMinor: Number(row.price_minor), currency: row.currency },
    hasActivePublication: row.has_active_publication,
    hasSample: row.has_sample,
    series:
      row.series_slug && row.series_name && row.series_position !== null
        ? { slug: row.series_slug, name: row.series_name, position: row.series_position }
        : null,
    topics: topicsSchema.parse(row.topics),
    featured: row.featured,
    shelfPosition: row.shelf_position,
    createdAt: row.created_at,
  };
}

export const getBookCards = cache(async (locale: Locale): Promise<CatalogBookCard[]> => {
  const { data, error } = await createPublicClient().rpc("catalog_book_cards", { p_locale: locale });
  if (error) throw failure("getBookCards");
  return ((data ?? []) as unknown as CardRow[]).map(toCard);
});

// Invalid JSON content is dropped, not rendered. Admin writes validate it with the same shapes.
const bookPageSchema = z.object({
  bookId: z.string(),
  description: z.string().nullable(),
  audience: z.string().nullable(),
  keyIdeas: z.array(z.object({ title: z.string(), summary: z.string() })).catch([]),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).catch([]),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  alternateSlug: z.string().nullable(),
});

export const getBookPage = cache(async (locale: Locale, slug: string): Promise<CatalogBookPage | null> => {
  if (!slugPattern.test(slug)) return null;

  const [cards, { data, error }] = await Promise.all([
    getBookCards(locale),
    createPublicClient().rpc("catalog_book_page", { p_locale: locale, p_slug: slug }),
  ]);
  if (error) throw failure("getBookPage");
  if (data === null) return null;

  const parsed = bookPageSchema.safeParse(data);
  if (!parsed.success) throw failure("getBookPage");

  const card = cards.find((candidate) => candidate.bookId === parsed.data.bookId);
  return card ? { ...card, ...parsed.data } : null;
});

const entityPageSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  alternateSlug: z.string().nullable(),
});

export const getEntityPage = cache(
  async (kind: CatalogEntityKind, locale: Locale, slug: string): Promise<CatalogEntityPage | null> => {
    if (!slugPattern.test(slug)) return null;

    const [cards, { data, error }] = await Promise.all([
      getBookCards(locale),
      createPublicClient().rpc("catalog_entity_page", { p_kind: kind, p_locale: locale, p_slug: slug }),
    ]);
    if (error) throw failure("getEntityPage");
    if (data === null) return null;

    const parsed = entityPageSchema.safeParse(data);
    if (!parsed.success) throw failure("getEntityPage");

    const books = booksForEntity(cards, kind, slug, locale);
    if (books.length === 0) return null;
    return { kind, ...parsed.data, books };
  },
);

export async function getActiveEntitlementBookIds(profileId: string): Promise<Set<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("entitlements")
    .select("book_id")
    .eq("profile_id", profileId)
    .eq("status", "active");
  if (error) throw failure("getActiveEntitlementBookIds");
  return new Set((data ?? []).map((row) => row.book_id));
}

export async function getBookActionState(
  card: Pick<CatalogBookCard, "bookId" | "offer" | "hasActivePublication">,
): Promise<{ action: BookAction; signedIn: boolean }> {
  const profile = await getCurrentProfile();
  const owned = profile ? await getActiveEntitlementBookIds(profile.id) : new Set<string>();

  const action = resolveBookAction({
    hasActiveEntitlement: owned.has(card.bookId),
    offer: card.offer ? { priceMinor: card.offer.priceMinor, active: true } : null,
    hasActivePublication: card.hasActivePublication,
    paymentsEnabled: getServerEnv().paymentProvider !== "disabled",
  });
  return { action, signedIn: profile !== null };
}

export type CatalogSearchResults = {
  books: CatalogBookCard[];
  authors: SearchHit[];
  series: SearchHit[];
  topics: SearchHit[];
};

const searchHitsSchema = z.array(
  z.object({
    kind: z.enum(["book", "author", "series", "topic"]),
    slug: z.string(),
    name: z.string(),
    score: z.number(),
  }),
);

// `query` must come from normalizeSearchQuery (lib/catalog/search.ts).
export async function searchCatalog(locale: Locale, query: string): Promise<CatalogSearchResults> {
  const [cards, { data, error }] = await Promise.all([
    getBookCards(locale),
    createPublicClient().rpc("search_catalog", { p_locale: locale, p_query: query }),
  ]);
  if (error) throw failure("searchCatalog");

  const parsed = searchHitsSchema.safeParse(data ?? []);
  if (!parsed.success) throw failure("searchCatalog");

  const grouped = groupSearchHits(parsed.data, locale);
  const bySlug = new Map(cards.map((card) => [card.slug, card]));
  return {
    books: grouped.books.flatMap((hit) => bySlug.get(hit.slug) ?? []),
    authors: grouped.authors,
    series: grouped.series,
    topics: grouped.topics,
  };
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run lib/data/catalog.test.ts`
Expected: PASS.

If `cache` memoizes across tests and a test sees another test's data, stop and report it. React's `cache` does not memoize outside a server render, so this should not happen.

- [ ] **Step 6: Run the checks and commit**

```bash
npm run check
git add lib/supabase/public.ts lib/data/catalog.ts lib/data/catalog.test.ts
git commit -m "feat(catalog): add the public catalog data layer"
```

---
### Task 5: Storefront building blocks

**Files:**
- Modify: `lib/i18n/routes.ts`, `lib/i18n/routes.test.ts`
- Modify: `lib/config/url.ts`
- Create: `lib/config/url.test.ts`
- Modify: `lib/i18n/dictionaries/en.json`, `lib/i18n/dictionaries/vi.json`
- Modify: `next.config.ts`
- Modify: `components/site-header.tsx`
- Create: `components/catalog/cover-image.tsx`
- Create: `components/catalog/price-label.tsx`
- Create: `components/catalog/book-card.tsx`
- Create: `components/catalog/book-action-control.tsx`
- Create: `components/catalog/book-action-control.test.tsx`
- Create: `components/catalog/book-card.test.tsx`

**Interfaces:**
- Consumes: Task 3 `BookAction`, `CatalogBookCard`, `formatPrice`; `Button` from `components/ui/button.tsx`; `BookCover` from `components/brand/book-cover.tsx`.
- Produces:
  - `getLocaleRoutes(locale)` gains `books` and `search`.
  - `getCatalogRoutes(locale)` returns `{ book(slug), entity(kind, slug), sample(slug), read(bookId), signInFor(path) }`.
  - `otherLocale(locale: Locale): Locale`.
  - `isLoopbackUrl(value: string): boolean`.
  - Dictionary keys `navigation.books`, `navigation.search`, and the `catalog` section below.
  - `SiteHeader` props: `{ locale; current?: "library" | "account" | "books" | "search"; alternates?: Partial<Record<Locale, string>> }`.
  - `<CoverImage card size? sizes decorative? preload? />`
  - `<PriceLabel offer locale copy />`
  - `<BookCard card locale copy />` and `<BookGrid books locale copy />`
  - `<BookActionControl action signedIn bookId bookPath locale copy />`

- [ ] **Step 1: Write the failing tests**

Replace `lib/i18n/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { getCatalogRoutes, getLocaleRoutes, otherLocale } from "@/lib/i18n/routes";

describe("localized route graph", () => {
  it("keeps primary navigation in the selected locale", () => {
    expect(getLocaleRoutes("en")).toEqual({
      account: "/en/account",
      books: "/en/books",
      home: "/en",
      library: "/en/library",
      search: "/en/search",
      signIn: "/en/sign-in",
    });
  });

  it("builds catalog URLs under the locale", () => {
    const routes = getCatalogRoutes("vi");
    expect(routes.book("dac-nhan-tam")).toBe("/vi/books/dac-nhan-tam");
    expect(routes.entity("author", "nguyen-nhat-anh")).toBe("/vi/authors/nguyen-nhat-anh");
    expect(routes.entity("series", "harbour")).toBe("/vi/series/harbour");
    expect(routes.entity("topic", "habits")).toBe("/vi/topics/habits");
    expect(routes.sample("dac-nhan-tam")).toBe("/vi/read-sample/dac-nhan-tam");
    expect(routes.read("30000000-0000-4000-8000-000000000001")).toBe("/vi/read/30000000-0000-4000-8000-000000000001");
    expect(routes.signInFor("/vi/books/dac-nhan-tam")).toBe("/vi/sign-in?next=%2Fvi%2Fbooks%2Fdac-nhan-tam");
  });

  it("names the other locale", () => {
    expect(otherLocale("vi")).toBe("en");
    expect(otherLocale("en")).toBe("vi");
  });
});
```

Create `lib/config/url.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { isLoopbackUrl } from "@/lib/config/url";

describe("isLoopbackUrl", () => {
  it("detects local hosts", () => {
    expect(isLoopbackUrl("http://127.0.0.1:54321/storage/v1/object/public/covers/a.png")).toBe(true);
    expect(isLoopbackUrl("http://localhost:54321/x")).toBe(true);
    expect(isLoopbackUrl("https://abc.supabase.co/x")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
```

Create `components/catalog/book-action-control.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BookActionControl } from "@/components/catalog/book-action-control";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const props = { bookId: BOOK_ID, bookPath: "/en/books/a-book", locale: "en" as const, copy: en.catalog.actions };

describe("BookActionControl", () => {
  it("links an entitled reader to the reader", () => {
    render(<BookActionControl {...props} action="read" signedIn />);
    expect(screen.getByRole("link", { name: "Read now" })).toHaveAttribute("href", `/en/read/${BOOK_ID}`);
  });

  it("sends a signed-out reader to sign-in and back to the book", () => {
    render(<BookActionControl {...props} action="get_free" signedIn={false} />);
    expect(screen.getByRole("link", { name: "Get free" })).toHaveAttribute("href", "/en/sign-in?next=%2Fen%2Fbooks%2Fa-book");
  });

  it("disables Get and Buy for a signed-in reader until S3", () => {
    const { rerender } = render(<BookActionControl {...props} action="get_free" signedIn />);
    expect(screen.getByRole("button", { name: "Get free" })).toBeDisabled();
    rerender(<BookActionControl {...props} action="buy" signedIn />);
    expect(screen.getByRole("button", { name: "Buy ebook" })).toBeDisabled();
  });

  it("shows coming soon and unavailable states without a link", () => {
    const { rerender } = render(<BookActionControl {...props} action="coming_soon" signedIn={false} />);
    expect(screen.getByRole("button", { name: "Coming soon" })).toBeDisabled();
    rerender(<BookActionControl {...props} action="unavailable" signedIn={false} />);
    expect(screen.getByText("Not available yet")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
```

Create `components/catalog/book-card.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { BookCard } from "@/components/catalog/book-card";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

const card: CatalogBookCard = {
  bookId: "30000000-0000-4000-8000-000000000001",
  slug: "harbour-lights",
  title: "Harbour Lights",
  subtitle: null,
  shortDescription: null,
  author: { name: "Mai Tran", slug: "mai-tran" },
  cover: { url: "http://127.0.0.1:54321/storage/v1/object/public/covers/books/x/cover.png", alt: "Cover of Harbour Lights" },
  offer: { priceMinor: 0, currency: "VND" },
  hasActivePublication: true,
  hasSample: false,
  series: null,
  topics: [],
  featured: false,
  shelfPosition: null,
  createdAt: "2026-09-01T00:00:00+00:00",
};

it("names the card link by the title alone and marks a free book", () => {
  render(<BookCard card={card} copy={en.catalog.book} locale="en" />);
  expect(screen.getByRole("link", { name: "Harbour Lights" })).toHaveAttribute("href", "/en/books/harbour-lights");
  expect(screen.getByText("Mai Tran")).toBeVisible();
  expect(screen.getByText("Free")).toBeVisible();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run lib/i18n/routes.test.ts lib/config/url.test.ts components/catalog`
Expected: FAIL. The new exports, dictionary keys, and components do not exist.

- [ ] **Step 3: Add the route builders**

Replace `lib/i18n/routes.ts`:

```ts
import type { CatalogEntityKind } from "@/lib/catalog/public-types";
import { type Locale, withLocale } from "@/lib/i18n/config";

export function getLocaleRoutes(locale: Locale) {
  return {
    account: withLocale(locale, "/account"),
    books: withLocale(locale, "/books"),
    home: withLocale(locale, "/"),
    library: withLocale(locale, "/library"),
    search: withLocale(locale, "/search"),
    signIn: withLocale(locale, "/sign-in"),
  };
}

const entitySegments: Record<CatalogEntityKind, string> = { author: "authors", series: "series", topic: "topics" };

export function getCatalogRoutes(locale: Locale) {
  return {
    book: (slug: string) => withLocale(locale, `/books/${slug}`),
    entity: (kind: CatalogEntityKind, slug: string) => withLocale(locale, `/${entitySegments[kind]}/${slug}`),
    // The sample reader page arrives in S4.
    sample: (slug: string) => withLocale(locale, `/read-sample/${slug}`),
    read: (bookId: string) => withLocale(locale, `/read/${bookId}`),
    signInFor: (path: string) => `${withLocale(locale, "/sign-in")}?${new URLSearchParams({ next: path })}`,
  };
}

export function otherLocale(locale: Locale): Locale {
  return locale === "vi" ? "en" : "vi";
}
```

- [ ] **Step 4: Add the loopback helper**

Replace `lib/config/url.ts`:

```ts
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isSecureOrLoopbackUrl(value: string) {
  const url = parse(value);
  return url !== null && (url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname)));
}

// next/image refuses to optimize images from loopback hosts, so local covers render unoptimized.
export function isLoopbackUrl(value: string) {
  const url = parse(value);
  return url !== null && loopbackHosts.has(url.hostname);
}
```

- [ ] **Step 5: Add the dictionary copy**

In `lib/i18n/dictionaries/en.json`, add two keys to `navigation`:

```json
    "books": "Books",
    "search": "Search"
```

Then add a top-level `catalog` section after `home`:

```json
  "catalog": {
    "browseAll": "Browse all books",
    "featuredEyebrow": "Featured",
    "shelfTitle": "On the shelf",
    "books": {
      "eyebrow": "Catalog",
      "title": "All books",
      "description": "Every book you can read on Infinity Books.",
      "filtersTitle": "Filter books",
      "topic": "Topic",
      "author": "Author",
      "series": "Series",
      "price": "Price",
      "any": "Any",
      "free": "Free",
      "paid": "Paid",
      "sort": "Sort by",
      "sortFeatured": "Featured",
      "sortNewest": "Newest",
      "sortTitle": "Title",
      "apply": "Apply",
      "clear": "Clear filters",
      "count": "{count} books",
      "emptyTitle": "No books match these filters."
    },
    "book": {
      "by": "By",
      "free": "Free",
      "sample": "Read a sample",
      "audience": "Who it is for",
      "keyIdeas": "Key ideas",
      "faq": "Questions and answers",
      "topics": "Topics",
      "seriesPosition": "Book {position} in {series}",
      "format": "Ebook (EPUB, read on the web)"
    },
    "actions": {
      "read": "Read now",
      "getFree": "Get free",
      "buy": "Buy ebook",
      "comingSoon": "Coming soon",
      "unavailable": "Not available yet",
      "signInHint": "You will sign in with your email first."
    },
    "entity": {
      "author": "Author",
      "series": "Series",
      "topic": "Topic",
      "booksTitle": "Books"
    },
    "search": {
      "title": "Search",
      "label": "Search books, authors, series, and topics",
      "placeholder": "Title, author, or topic",
      "submit": "Search",
      "resultsFor": "Results for “{query}”",
      "books": "Books",
      "authors": "Authors",
      "series": "Series",
      "topics": "Topics",
      "emptyTitle": "Nothing matched “{query}”.",
      "emptyHint": "Check the spelling, or try fewer words.",
      "promptTitle": "What are you looking for?",
      "promptHint": "Type at least 2 characters."
    }
  },
```

In `lib/i18n/dictionaries/vi.json`, add the same keys to `navigation`:

```json
    "books": "Sách",
    "search": "Tìm kiếm"
```

Then add the same `catalog` section after `home`:

```json
  "catalog": {
    "browseAll": "Xem tất cả sách",
    "featuredEyebrow": "Nổi bật",
    "shelfTitle": "Trên kệ sách",
    "books": {
      "eyebrow": "Danh mục",
      "title": "Tất cả sách",
      "description": "Mọi cuốn sách bạn có thể đọc trên Infinity Books.",
      "filtersTitle": "Lọc sách",
      "topic": "Chủ đề",
      "author": "Tác giả",
      "series": "Bộ sách",
      "price": "Giá",
      "any": "Tất cả",
      "free": "Miễn phí",
      "paid": "Trả phí",
      "sort": "Sắp xếp theo",
      "sortFeatured": "Nổi bật",
      "sortNewest": "Mới nhất",
      "sortTitle": "Tên sách",
      "apply": "Áp dụng",
      "clear": "Xóa bộ lọc",
      "count": "{count} cuốn sách",
      "emptyTitle": "Không có sách nào phù hợp với bộ lọc này."
    },
    "book": {
      "by": "Tác giả",
      "free": "Miễn phí",
      "sample": "Đọc thử",
      "audience": "Dành cho ai",
      "keyIdeas": "Ý chính",
      "faq": "Hỏi và đáp",
      "topics": "Chủ đề",
      "seriesPosition": "Cuốn {position} trong {series}",
      "format": "Sách điện tử (EPUB, đọc trên web)"
    },
    "actions": {
      "read": "Đọc ngay",
      "getFree": "Nhận miễn phí",
      "buy": "Mua sách điện tử",
      "comingSoon": "Sắp ra mắt",
      "unavailable": "Chưa có sẵn",
      "signInHint": "Bạn sẽ đăng nhập bằng email trước."
    },
    "entity": {
      "author": "Tác giả",
      "series": "Bộ sách",
      "topic": "Chủ đề",
      "booksTitle": "Sách"
    },
    "search": {
      "title": "Tìm kiếm",
      "label": "Tìm sách, tác giả, bộ sách và chủ đề",
      "placeholder": "Tên sách, tác giả hoặc chủ đề",
      "submit": "Tìm",
      "resultsFor": "Kết quả cho “{query}”",
      "books": "Sách",
      "authors": "Tác giả",
      "series": "Bộ sách",
      "topics": "Chủ đề",
      "emptyTitle": "Không tìm thấy kết quả cho “{query}”.",
      "emptyHint": "Hãy kiểm tra chính tả, hoặc thử ít từ hơn.",
      "promptTitle": "Bạn đang tìm gì?",
      "promptHint": "Nhập ít nhất 2 ký tự."
    }
  },
```

- [ ] **Step 6: Allow cover images**

Replace `next.config.ts`:

```ts
import type { NextConfig } from "next";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");

const nextConfig: NextConfig = {
  experimental: {
    // Enables `forbidden()` so admin-only server code can deny non-admins
    // with a real 403 instead of a manual redirect. See lib/auth/admin.ts.
    authInterrupts: true,
  },
  images: {
    // Only the public covers bucket. EPUB buckets are private and never go through next/image.
    remotePatterns: supabaseUrl ? [new URL(`${supabaseUrl}/storage/v1/object/public/covers/**`)] : [],
  },
};

export default nextConfig;
```

- [ ] **Step 7: Write the catalog components**

Create `components/catalog/cover-image.tsx`:

```tsx
import Image from "next/image";

import { BookCover } from "@/components/brand/book-cover";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { isLoopbackUrl } from "@/lib/config/url";

// A fixed 2:3 box, so covers never shift the layout. Books without a cover fall back to the
// typographic cover. `decorative` covers sit next to their title, so they carry no alt text.
export function CoverImage({
  card,
  sizes,
  size = "md",
  decorative = false,
  preload = false,
}: {
  card: Pick<CatalogBookCard, "bookId" | "title" | "author" | "cover">;
  sizes: string;
  size?: "sm" | "md" | "lg";
  decorative?: boolean;
  preload?: boolean;
}) {
  if (!card.cover) {
    return (
      <BookCover
        byline={card.author.name}
        colorKey={card.bookId}
        label={decorative ? null : card.title}
        size={size}
        title={card.title}
      />
    );
  }

  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface shadow-cover">
      <Image
        alt={decorative ? "" : card.cover.alt}
        className="object-cover"
        fill
        preload={preload}
        sizes={sizes}
        src={card.cover.url}
        unoptimized={isLoopbackUrl(card.cover.url)}
      />
    </div>
  );
}
```

Create `components/catalog/price-label.tsx`:

```tsx
import { formatPrice } from "@/lib/catalog/price";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import type { Dictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/config";

export function PriceLabel({
  offer,
  locale,
  copy,
  className,
}: {
  offer: CatalogBookCard["offer"];
  locale: Locale;
  copy: Dictionary["catalog"]["book"];
  className?: string;
}) {
  if (!offer) return null;
  return <span className={className}>{offer.priceMinor === 0 ? copy.free : formatPrice(offer.priceMinor, offer.currency, locale)}</span>;
}
```

Create `components/catalog/book-card.tsx`:

```tsx
import Link from "next/link";

import { CoverImage } from "@/components/catalog/cover-image";
import { PriceLabel } from "@/components/catalog/price-label";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

type CardCopy = Dictionary["catalog"]["book"];

// One link per card, named by the title. The author and price sit outside the link so the
// accessible name stays short.
export function BookCard({ card, locale, copy }: { card: CatalogBookCard; locale: Locale; copy: CardCopy }) {
  return (
    <article className="flex flex-col gap-3">
      <Link
        className="group flex flex-col gap-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
        href={getCatalogRoutes(locale).book(card.slug)}
      >
        <CoverImage card={card} decorative sizes="(min-width: 1024px) 14rem, (min-width: 640px) 30vw, 45vw" size="sm" />
        <span className="font-serif text-lg leading-snug text-ink group-hover:underline">{card.title}</span>
      </Link>
      <p className="text-sm text-ink-soft">{card.author.name}</p>
      <PriceLabel className="text-sm font-medium text-forest" copy={copy} locale={locale} offer={card.offer} />
    </article>
  );
}

export function BookGrid({ books, locale, copy }: { books: CatalogBookCard[]; locale: Locale; copy: CardCopy }) {
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {books.map((book) => (
        <li key={book.bookId}>
          <BookCard card={book} copy={copy} locale={locale} />
        </li>
      ))}
    </ul>
  );
}
```

Create `components/catalog/book-action-control.tsx`:

```tsx
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { BookAction } from "@/lib/catalog/book-action";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

// Renders the result of resolveBookAction. It never grants access; the reader route, Server
// Actions, and RPCs check again.
export function BookActionControl({
  action,
  signedIn,
  bookId,
  bookPath,
  locale,
  copy,
}: {
  action: BookAction;
  signedIn: boolean;
  bookId: string;
  bookPath: string;
  locale: Locale;
  copy: Dictionary["catalog"]["actions"];
}) {
  const routes = getCatalogRoutes(locale);

  switch (action) {
    case "read":
      return (
        <Button render={<Link href={routes.read(bookId)} />} size="lg">
          {copy.read}
        </Button>
      );
    case "get_free":
    case "buy": {
      const label = action === "get_free" ? copy.getFree : copy.buy;
      if (!signedIn) {
        return (
          <div className="space-y-2">
            <Button render={<Link href={routes.signInFor(bookPath)} />} size="lg">
              {label}
            </Button>
            <p className="text-sm text-ink-soft">{copy.signInHint}</p>
          </div>
        );
      }
      // S3 replaces this disabled button with the Get and Buy Server Actions.
      return (
        <Button disabled size="lg">
          {label}
        </Button>
      );
    }
    case "coming_soon":
      return (
        <Button disabled size="lg" variant="outline">
          {copy.comingSoon}
        </Button>
      );
    case "unavailable":
      return <p className="text-sm text-ink-soft">{copy.unavailable}</p>;
  }
}
```

- [ ] **Step 8: Update the site header**

In `components/site-header.tsx`, change the props and the switcher link, and add the Books and Search links.

Replace the function signature line:

```tsx
export async function SiteHeader({ locale, current }: { locale: Locale; current?: "library" | "account" }) {
```

with:

```tsx
// `alternates` holds this page's URL in the other locale, when that page exists (spec 4.6).
// Without it, the switcher goes to the other locale's home.
export async function SiteHeader({
  locale,
  current,
  alternates,
}: {
  locale: Locale;
  current?: "library" | "account" | "books" | "search";
  alternates?: Partial<Record<Locale, string>>;
}) {
```

Replace the switcher `href`:

```tsx
            href={getLocaleRoutes(otherLocale).home}
```

with:

```tsx
            href={alternates?.[otherLocale] ?? getLocaleRoutes(otherLocale).home}
```

Insert these two links right after the switcher `</Link>` and before `{user ? (`:

```tsx
          <Link
            aria-current={current === "books" ? "page" : undefined}
            className={cn(navLink, current === "books" && "underline")}
            href={routes.books}
          >
            {copy.books}
          </Link>
          <Link
            aria-current={current === "search" ? "page" : undefined}
            className={cn(navLink, current === "search" && "underline")}
            href={routes.search}
          >
            {copy.search}
          </Link>
```

- [ ] **Step 9: Run the tests and verify they pass**

Run: `npx vitest run lib/i18n lib/config components/catalog`
Expected: PASS, including `lib/i18n/dictionary.test.ts` (same keys in both locales, no empty strings).

- [ ] **Step 10: Run the checks and commit**

```bash
npm run check
git add lib/i18n/routes.ts lib/i18n/routes.test.ts lib/config/url.ts lib/config/url.test.ts lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json next.config.ts components/site-header.tsx components/catalog
git commit -m "feat(storefront): add catalog routes, copy, and book components"
```

---
### Task 6: Book page

**Files:**
- Create: `app/[locale]/(public)/books/[slug]/page.tsx`

**Interfaces:**
- Consumes: `getBookPage`, `getBookActionState` (Task 4); `CoverImage`, `PriceLabel`, `BookActionControl`, `SiteHeader` (Task 5); `getCatalogRoutes`, `otherLocale`, `fillTemplate`.
- Produces: `/{locale}/books/[slug]`. 404 for a draft, unknown, or untranslated book. The existing `actions.ts` in the same folder stays untouched; S3 wires it.

Pages are covered by the Playwright journeys in Task 12. Before you write this page, read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md` and `not-found.md`.

- [ ] **Step 1: Write the page**

Create `app/[locale]/(public)/books/[slug]/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BookActionControl } from "@/components/catalog/book-action-control";
import { CoverImage } from "@/components/catalog/cover-image";
import { PriceLabel } from "@/components/catalog/price-label";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getBookActionState, getBookPage } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes, otherLocale } from "@/lib/i18n/routes";

type Props = { params: Promise<{ locale: string; slug: string }> };

const sectionTitle = "mb-4 font-serif text-2xl font-normal";
const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const book = await getBookPage(locale, slug);
  if (!book) return {};
  return {
    title: book.seoTitle ?? book.title,
    description: book.seoDescription ?? book.shortDescription ?? undefined,
  };
}

export default async function BookPage({ params }: Props) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const book = await getBookPage(locale, slug);
  if (!book) notFound();

  const [dictionary, actionState] = await Promise.all([getDictionary(locale), getBookActionState(book)]);
  const copy = dictionary.catalog;
  const routes = getCatalogRoutes(locale);
  const other = otherLocale(locale);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader
        alternates={book.alternateSlug ? { [other]: getCatalogRoutes(other).book(book.alternateSlug) } : undefined}
        current="books"
        locale={locale}
      />
      <main className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-20" id="main-content">
        <article className="grid gap-12 lg:grid-cols-[22rem_1fr] lg:gap-20">
          <div className="mx-auto w-full max-w-[16rem] lg:max-w-none">
            <CoverImage card={book} preload size="lg" sizes="(min-width: 1024px) 22rem, 16rem" />
          </div>

          <div className="max-w-[40rem]">
            <h1 className="font-serif text-4xl leading-[1.08] font-normal tracking-[-0.01em] sm:text-5xl">{book.title}</h1>
            {book.subtitle ? <p className="mt-3 font-serif text-xl text-ink-soft">{book.subtitle}</p> : null}
            <p className="mt-4 text-[0.9375rem] text-ink-soft">
              {copy.book.by}{" "}
              {book.author.slug ? (
                <Link className={textLink} href={routes.entity("author", book.author.slug)}>
                  {book.author.name}
                </Link>
              ) : (
                book.author.name
              )}
            </p>

            <div className="mt-8 flex flex-wrap items-start gap-x-6 gap-y-4 border-y border-hairline py-6">
              <div className="min-h-11 space-y-1">
                <PriceLabel className="block text-2xl font-medium text-ink" copy={copy.book} locale={locale} offer={book.offer} />
                <span className="block text-xs text-sage-text">{copy.book.format}</span>
              </div>
              <BookActionControl
                action={actionState.action}
                bookId={book.bookId}
                bookPath={routes.book(book.slug)}
                copy={copy.actions}
                locale={locale}
                signedIn={actionState.signedIn}
              />
            </div>

            {book.hasSample ? (
              <p className="mt-4">
                <Link className={textLink} href={routes.sample(book.slug)}>
                  {copy.book.sample}
                </Link>
              </p>
            ) : null}

            {book.shortDescription ? <p className="mt-10 font-serif text-xl leading-normal">{book.shortDescription}</p> : null}
            {book.description ? (
              <p className="mt-6 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{book.description}</p>
            ) : null}

            {book.audience ? (
              <section className="mt-12">
                <h2 className={sectionTitle}>{copy.book.audience}</h2>
                <p className="text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{book.audience}</p>
              </section>
            ) : null}

            {book.keyIdeas.length > 0 ? (
              <section className="mt-12">
                <h2 className={sectionTitle}>{copy.book.keyIdeas}</h2>
                <ol className="space-y-5">
                  {book.keyIdeas.map((idea, index) => (
                    <li className="grid grid-cols-[2rem_1fr] gap-2" key={`${index}-${idea.title}`}>
                      <span className="text-xs font-medium text-sage-text">{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <p className="font-medium">{idea.title}</p>
                        {idea.summary ? <p className="mt-1 text-[0.9375rem] leading-relaxed text-ink-soft">{idea.summary}</p> : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {book.series || book.topics.length > 0 ? (
              <section className="mt-12 space-y-4">
                {book.series ? (
                  <p>
                    <Link className={textLink} href={routes.entity("series", book.series.slug)}>
                      {fillTemplate(copy.book.seriesPosition, { position: book.series.position, series: book.series.name })}
                    </Link>
                  </p>
                ) : null}
                {book.topics.length > 0 ? (
                  <div>
                    <h2 className={sectionTitle}>{copy.book.topics}</h2>
                    <ul className="flex flex-wrap gap-x-5">
                      {book.topics.map((topic) => (
                        <li key={topic.slug}>
                          <Link className={textLink} href={routes.entity("topic", topic.slug)}>
                            {topic.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : null}

            {book.faq.length > 0 ? (
              <section className="mt-12">
                <h2 className={sectionTitle}>{copy.book.faq}</h2>
                <div className="divide-y divide-hairline border-y border-hairline">
                  {book.faq.map((item, index) => (
                    <details className="group" key={`${index}-${item.question}`}>
                      <summary className="flex min-h-11 cursor-pointer items-center py-3 font-medium">{item.question}</summary>
                      <p className="pb-4 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{item.answer}</p>
                    </details>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </article>
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
```

- [ ] **Step 2: Check the page by hand**

Run the app against the local stack (`npm run dev` on a free port; never let it point at the cloud project). Publish a book through `/admin`, then open `/{locale}/books/<slug>`.
Expected: the title, author link, price, and action show. An unknown slug shows the 404 page. An English URL for a Vietnamese-only book shows the 404 page.

- [ ] **Step 3: Run the checks and commit**

```bash
npm run check
git add "app/[locale]/(public)/books/[slug]/page.tsx"
git commit -m "feat(storefront): add the public book page"
```

---

### Task 7: Catalog page with filters

**Files:**
- Create: `components/catalog/catalog-filter-form.tsx`
- Create: `components/catalog/catalog-filter-form.test.tsx`
- Create: `app/[locale]/(public)/books/page.tsx`

**Interfaces:**
- Consumes: `getBookCards` (Task 4); `parseCatalogFilters`, `hasActiveFilters`, `filterAndSortBooks`, `catalogFilterOptions` (Task 3); `BookGrid` (Task 5); `NativeSelect`, `Label`, `Button`.
- Produces: `/{locale}/books`. `<CatalogFilterForm action filters options copy clearHref />`. Filtered views set `robots: { index: false, follow: true }`.

- [ ] **Step 1: Write the failing test**

Create `components/catalog/catalog-filter-form.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { CatalogFilterForm } from "@/components/catalog/catalog-filter-form";
import { parseCatalogFilters } from "@/lib/catalog/browse";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

it("is a plain GET form that keeps the current filters selected", () => {
  render(
    <CatalogFilterForm
      action="/en/books"
      clearHref="/en/books"
      copy={en.catalog.books}
      filters={parseCatalogFilters({ topic: "habits", price: "free", sort: "title" })}
      options={{ topics: [{ slug: "habits", name: "Habits" }], authors: [], series: [] }}
    />,
  );

  const form = screen.getByRole("button", { name: "Apply" }).closest("form");
  expect(form).toHaveAttribute("method", "get");
  expect(form).toHaveAttribute("action", "/en/books");
  expect(screen.getByLabelText("Topic")).toHaveValue("habits");
  expect(screen.getByLabelText("Price")).toHaveValue("free");
  expect(screen.getByLabelText("Sort by")).toHaveValue("title");
  expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/en/books");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run components/catalog/catalog-filter-form.test.tsx`
Expected: FAIL. The component does not exist.

- [ ] **Step 3: Write the filter form**

Create `components/catalog/catalog-filter-form.tsx`:

```tsx
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { CatalogFilterOptions, CatalogFilters } from "@/lib/catalog/browse";
import type { Dictionary } from "@/lib/i18n/dictionary";

type Copy = Dictionary["catalog"]["books"];

// A plain GET form. It needs no client JavaScript, and filters live in the URL.
export function CatalogFilterForm({
  action,
  clearHref,
  filters,
  options,
  copy,
}: {
  action: string;
  clearHref: string;
  filters: CatalogFilters;
  options: CatalogFilterOptions;
  copy: Copy;
}) {
  const selects = [
    { name: "topic", label: copy.topic, value: filters.topic, entries: options.topics },
    { name: "author", label: copy.author, value: filters.author, entries: options.authors },
    { name: "series", label: copy.series, value: filters.series, entries: options.series },
  ] as const;

  return (
    <form action={action} aria-label={copy.filtersTitle} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end" method="get">
      {selects.map((select) => (
        <div className="space-y-2" key={select.name}>
          <Label htmlFor={`filter-${select.name}`}>{select.label}</Label>
          <NativeSelect defaultValue={select.value ?? ""} id={`filter-${select.name}`} name={select.name}>
            <option value="">{copy.any}</option>
            {select.entries.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      ))}
      <div className="space-y-2">
        <Label htmlFor="filter-price">{copy.price}</Label>
        <NativeSelect defaultValue={filters.price ?? ""} id="filter-price" name="price">
          <option value="">{copy.any}</option>
          <option value="free">{copy.free}</option>
          <option value="paid">{copy.paid}</option>
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="filter-sort">{copy.sort}</Label>
        <NativeSelect defaultValue={filters.sort} id="filter-sort" name="sort">
          <option value="featured">{copy.sortFeatured}</option>
          <option value="newest">{copy.sortNewest}</option>
          <option value="title">{copy.sortTitle}</option>
        </NativeSelect>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit">{copy.apply}</Button>
        <Link className="inline-flex min-h-11 items-center text-sm text-forest underline underline-offset-4" href={clearHref}>
          {copy.clear}
        </Link>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run components/catalog/catalog-filter-form.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the catalog page**

Create `app/[locale]/(public)/books/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BookGrid } from "@/components/catalog/book-card";
import { CatalogFilterForm } from "@/components/catalog/catalog-filter-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import {
  type CatalogSearchParams,
  catalogFilterOptions,
  filterAndSortBooks,
  hasActiveFilters,
  parseCatalogFilters,
} from "@/lib/catalog/browse";
import { getBookCards } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getLocaleRoutes } from "@/lib/i18n/routes";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<CatalogSearchParams> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) return {};
  const copy = (await getDictionary(locale)).catalog.books;
  return {
    title: copy.title,
    description: copy.description,
    ...(hasActiveFilters(parseCatalogFilters(query)) ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function BooksPage({ params, searchParams }: Props) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const [dictionary, cards] = await Promise.all([getDictionary(locale), getBookCards(locale)]);
  const copy = dictionary.catalog;
  const routes = getLocaleRoutes(locale);
  const filters = parseCatalogFilters(query);
  const books = filterAndSortBooks(cards, filters, locale);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="books" locale={locale} />
      <main className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-16" id="main-content">
        <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.books.eyebrow}</p>
        <h1 className="mb-4 font-serif text-4xl font-normal sm:text-5xl">{copy.books.title}</h1>
        <p className="mb-10 max-w-[35rem] text-[0.9375rem] text-ink-soft">{copy.books.description}</p>

        <CatalogFilterForm
          action={routes.books}
          clearHref={routes.books}
          copy={copy.books}
          filters={filters}
          options={catalogFilterOptions(cards, locale)}
        />

        <p aria-live="polite" className="mt-10 mb-6 text-sm text-sage-text">
          {fillTemplate(copy.books.count, { count: books.length })}
        </p>
        {books.length > 0 ? (
          <BookGrid books={books} copy={copy.book} locale={locale} />
        ) : (
          <div className="border-t border-hairline py-12">
            <p className="mb-4 font-serif text-2xl">{copy.books.emptyTitle}</p>
            <Link className="inline-flex min-h-11 items-center text-forest underline underline-offset-4" href={routes.books}>
              {copy.books.clear}
            </Link>
          </div>
        )}
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
```

- [ ] **Step 6: Run the checks and commit**

```bash
npm run check
git add components/catalog/catalog-filter-form.tsx components/catalog/catalog-filter-form.test.tsx "app/[locale]/(public)/books/page.tsx"
git commit -m "feat(storefront): add the filtered catalog page"
```

---

### Task 8: Author, series, and topic pages

**Files:**
- Create: `components/catalog/entity-page.tsx`
- Create: `app/[locale]/(public)/authors/[slug]/page.tsx`
- Create: `app/[locale]/(public)/series/[slug]/page.tsx`
- Create: `app/[locale]/(public)/topics/[slug]/page.tsx`

**Interfaces:**
- Consumes: `getEntityPage` (Task 4); `BookGrid`, `SiteHeader`, `getCatalogRoutes`, `otherLocale` (Task 5).
- Produces: `entityMetadata(kind, params): Promise<Metadata>` and `<EntityPage kind params />`. Each route file is a thin wrapper.

- [ ] **Step 1: Write the shared page body**

Create `components/catalog/entity-page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookGrid } from "@/components/catalog/book-card";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import type { CatalogEntityKind } from "@/lib/catalog/public-types";
import { getEntityPage } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes, otherLocale } from "@/lib/i18n/routes";

type EntityParams = Promise<{ locale: string; slug: string }>;

export async function entityMetadata(kind: CatalogEntityKind, params: EntityParams): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const entity = await getEntityPage(kind, locale, slug);
  if (!entity) return {};
  return { title: entity.name, description: entity.description ?? undefined };
}

// Authors, series, and topics share one layout: boards 1u, 1v, and 1s.
export async function EntityPage({ kind, params }: { kind: CatalogEntityKind; params: EntityParams }) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const entity = await getEntityPage(kind, locale, slug);
  if (!entity) notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.catalog;
  const other = otherLocale(locale);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader
        alternates={entity.alternateSlug ? { [other]: getCatalogRoutes(other).entity(kind, entity.alternateSlug) } : undefined}
        locale={locale}
      />
      <main className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-20" id="main-content">
        <header className="mb-14 max-w-[40rem]">
          <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.entity[kind]}</p>
          <h1 className="font-serif text-4xl leading-[1.08] font-normal sm:text-5xl">{entity.name}</h1>
          {entity.description ? (
            <p className="mt-6 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{entity.description}</p>
          ) : null}
        </header>
        <section aria-labelledby="entity-books">
          <h2 className="mb-8 font-serif text-2xl font-normal" id="entity-books">
            {copy.entity.booksTitle}
          </h2>
          <BookGrid books={entity.books} copy={copy.book} locale={locale} />
        </section>
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
```

- [ ] **Step 2: Write the three route files**

Create `app/[locale]/(public)/authors/[slug]/page.tsx`:

```tsx
import { EntityPage, entityMetadata } from "@/components/catalog/entity-page";

type Props = { params: Promise<{ locale: string; slug: string }> };

export function generateMetadata({ params }: Props) {
  return entityMetadata("author", params);
}

export default function AuthorPage({ params }: Props) {
  return <EntityPage kind="author" params={params} />;
}
```

Create `app/[locale]/(public)/series/[slug]/page.tsx`:

```tsx
import { EntityPage, entityMetadata } from "@/components/catalog/entity-page";

type Props = { params: Promise<{ locale: string; slug: string }> };

export function generateMetadata({ params }: Props) {
  return entityMetadata("series", params);
}

export default function SeriesPage({ params }: Props) {
  return <EntityPage kind="series" params={params} />;
}
```

Create `app/[locale]/(public)/topics/[slug]/page.tsx`:

```tsx
import { EntityPage, entityMetadata } from "@/components/catalog/entity-page";

type Props = { params: Promise<{ locale: string; slug: string }> };

export function generateMetadata({ params }: Props) {
  return entityMetadata("topic", params);
}

export default function TopicPage({ params }: Props) {
  return <EntityPage kind="topic" params={params} />;
}
```

- [ ] **Step 3: Run the checks and commit**

Run: `npm run check`
Expected: PASS. If the build reports that a page must return a React element from an async component, keep the wrappers `async` and `return <EntityPage … />`; the behavior is the same.

```bash
git add components/catalog/entity-page.tsx "app/[locale]/(public)/authors" "app/[locale]/(public)/series" "app/[locale]/(public)/topics"
git commit -m "feat(storefront): add author, series, and topic pages"
```

---

### Task 9: Search page

**Files:**
- Create: `app/[locale]/(public)/search/page.tsx`

**Interfaces:**
- Consumes: `normalizeSearchQuery` (Task 3); `searchCatalog` (Task 4); `BookGrid`, `SiteHeader`, `getCatalogRoutes`, `fillTemplate` (Task 5).
- Produces: `/{locale}/search?q=`. Always `robots: { index: false, follow: true }`.

- [ ] **Step 1: Write the page**

Create `app/[locale]/(public)/search/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BookGrid } from "@/components/catalog/book-card";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CatalogEntityKind } from "@/lib/catalog/public-types";
import type { SearchHit } from "@/lib/catalog/search";
import { normalizeSearchQuery } from "@/lib/catalog/search";
import { searchCatalog } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const copy = (await getDictionary(locale)).catalog.search;
  return { title: copy.title, robots: { index: false, follow: true } };
}

export default async function SearchPage({ params, searchParams }: Props) {
  const [{ locale }, { q }] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const query = normalizeSearchQuery(q);
  const [dictionary, results] = await Promise.all([getDictionary(locale), query ? searchCatalog(locale, query) : null]);
  const copy = dictionary.catalog;
  const catalogRoutes = getCatalogRoutes(locale);
  const rawQuery = (Array.isArray(q) ? q[0] : q) ?? "";

  const groups: { kind: CatalogEntityKind; title: string; hits: SearchHit[] }[] = results
    ? [
        { kind: "author", title: copy.search.authors, hits: results.authors },
        { kind: "series", title: copy.search.series, hits: results.series },
        { kind: "topic", title: copy.search.topics, hits: results.topics },
      ]
    : [];
  const total = results ? results.books.length + results.authors.length + results.series.length + results.topics.length : 0;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="search" locale={locale} />
      <main className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-16" id="main-content">
        <h1 className="mb-8 font-serif text-4xl font-normal sm:text-5xl">{copy.search.title}</h1>

        <form action={getLocaleRoutes(locale).search} className="mb-12 flex max-w-[40rem] flex-wrap items-end gap-3" method="get" role="search">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="search-q">{copy.search.label}</Label>
            <Input defaultValue={rawQuery} id="search-q" maxLength={100} name="q" placeholder={copy.search.placeholder} type="search" />
          </div>
          <Button type="submit">{copy.search.submit}</Button>
        </form>

        {!query ? (
          <div>
            <p className="font-serif text-2xl">{copy.search.promptTitle}</p>
            <p className="mt-2 text-sm text-ink-soft">{copy.search.promptHint}</p>
          </div>
        ) : total === 0 ? (
          <div>
            <p className="font-serif text-2xl">{fillTemplate(copy.search.emptyTitle, { query })}</p>
            <p className="mt-2 text-sm text-ink-soft">{copy.search.emptyHint}</p>
          </div>
        ) : (
          <div className="space-y-14">
            <p aria-live="polite" className="text-sm text-sage-text">
              {fillTemplate(copy.search.resultsFor, { query })}
            </p>
            {results && results.books.length > 0 ? (
              <section aria-labelledby="search-books">
                <h2 className="mb-6 font-serif text-2xl font-normal" id="search-books">
                  {copy.search.books}
                </h2>
                <BookGrid books={results.books} copy={copy.book} locale={locale} />
              </section>
            ) : null}
            {groups
              .filter((group) => group.hits.length > 0)
              .map((group) => (
                <section aria-labelledby={`search-${group.kind}`} key={group.kind}>
                  <h2 className="mb-4 font-serif text-2xl font-normal" id={`search-${group.kind}`}>
                    {group.title}
                  </h2>
                  <ul className="flex flex-wrap gap-x-6">
                    {group.hits.map((hit) => (
                      <li key={hit.slug}>
                        <Link
                          className="inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:text-ink"
                          href={catalogRoutes.entity(group.kind, hit.slug)}
                        >
                          {hit.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        )}
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
```

- [ ] **Step 2: Run the checks and commit**

```bash
npm run check
git add "app/[locale]/(public)/search/page.tsx"
git commit -m "feat(storefront): add grouped catalog search"
```

---

### Task 10: Home page from merchandising

**Files:**
- Modify: `app/[locale]/(public)/page.tsx`

**Interfaces:**
- Consumes: `getBookCards` (Task 4); `homeShelves` (Task 3); `CoverImage`, `BookGrid`, `getCatalogRoutes` (Task 5).
- Produces: the home page shows the featured book in the hero and the shelf below it. `e2e/public-home.spec.ts` and `e2e/localized-routing.spec.ts` keep passing.

- [ ] **Step 1: Load the shelves**

In `app/[locale]/(public)/page.tsx`, add these imports:

```tsx
import { BookGrid } from "@/components/catalog/book-card";
import { CoverImage } from "@/components/catalog/cover-image";
import { homeShelves } from "@/lib/catalog/browse";
import { getBookCards } from "@/lib/data/catalog";
```

Replace the existing routes import:

```tsx
import { getLocaleRoutes } from "@/lib/i18n/routes";
```

with:

```tsx
import { getCatalogRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
```

Replace:

```tsx
  const dictionary = await getDictionary(locale);
```

with:

```tsx
  const [dictionary, cards] = await Promise.all([getDictionary(locale), getBookCards(locale)]);
  const { featured, shelf } = homeShelves(cards);
  const catalogRoutes = getCatalogRoutes(locale);
```

- [ ] **Step 2: Add the Browse link to the hero**

Inside the hero's action row, after the Library `<Link>`, add:

```tsx
              <Link
                className="inline-flex min-h-12 items-center px-2 text-[0.9375rem] font-medium text-forest underline decoration-sand underline-offset-[5px] hover:text-ink hover:decoration-ink"
                href={routes.books}
              >
                {dictionary.catalog.browseAll}
              </Link>
```

- [ ] **Step 3: Show the featured book**

Replace the whole hero cover block, from the comment `{/* A Sand ground with a single cover set on it ...` through its closing `</div>`, with:

```tsx
          {/* Board 1e: a Sand ground with one cover set on it. The featured book fills it when an
              operator sets one in /admin/merchandising. */}
          <div className="relative h-[22rem] sm:h-[32.5rem]">
            <div aria-hidden="true" className="absolute inset-y-0 right-0 left-10 bg-surface">
              <div className="absolute inset-x-10 bottom-12 h-px bg-sand" />
            </div>
            {featured ? (
              <div className="absolute bottom-12 left-0 flex items-end gap-6">
                <Link className="block w-40 sm:w-52" aria-hidden="true" href={catalogRoutes.book(featured.slug)} tabIndex={-1}>
                  <CoverImage card={featured} decorative preload size="lg" sizes="13rem" />
                </Link>
                <div className="mb-2 max-w-[14rem]">
                  <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">
                    {dictionary.catalog.featuredEyebrow}
                  </p>
                  <Link className="font-serif text-2xl leading-tight text-ink hover:underline" href={catalogRoutes.book(featured.slug)}>
                    {featured.title}
                  </Link>
                  <p className="mt-1 text-sm text-ink-soft">{featured.author.name}</p>
                </div>
              </div>
            ) : (
              <div aria-hidden="true" className="absolute bottom-12 left-0 w-40 sm:w-52">
                <BookCover byline="Infinity Books" size="lg" title={copy.coverQuote} tone="forest" />
              </div>
            )}
          </div>
```

The cover link is `aria-hidden` with `tabIndex={-1}`, so keyboard and screen reader users meet one link per book: the title.

- [ ] **Step 4: Add the shelf**

Insert this section right after the hero `</section>` and before the `foundation-title` section:

```tsx
        {shelf.length > 0 ? (
          <section aria-labelledby="home-shelf-title" className="border-t border-hairline">
            <div className="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 lg:px-16 lg:py-20">
              <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
                <h2 className="font-serif text-3xl font-normal sm:text-4xl" id="home-shelf-title">
                  {dictionary.catalog.shelfTitle}
                </h2>
                <Link className="inline-flex min-h-11 items-center text-sm font-medium text-forest underline underline-offset-4" href={routes.books}>
                  {dictionary.catalog.browseAll}
                </Link>
              </div>
              <BookGrid books={shelf} copy={dictionary.catalog.book} locale={locale} />
            </div>
          </section>
        ) : null}
```

- [ ] **Step 5: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add "app/[locale]/(public)/page.tsx"
git commit -m "feat(storefront): show merchandising on the home page"
```

---
### Task 11: Refresh the storefront after admin changes

**Files:**
- Modify: `lib/catalog/revalidate.ts`
- Create: `lib/catalog/revalidate.test.ts`
- Modify: `app/admin/entities/actions.ts`
- Modify: `app/admin/merchandising/actions.ts`, `app/admin/merchandising/actions.test.ts`
- Modify: `app/admin/publications/[publicationId]/actions.ts`

**Interfaces:**
- Consumes: `revalidatePath` from `next/cache`.
- Produces: `revalidateStorefront(): void`, which calls `revalidatePath("/[locale]", "layout")`. `revalidateBookAdmin(bookId)` now also calls it.

Public pages render per request today, because `SiteHeader` reads cookies. This task keeps them correct if a page becomes cached later. Read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md` first.

- [ ] **Step 1: Write the failing tests**

Create `lib/catalog/revalidate.test.ts`:

```ts
// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, expect, it, vi } from "vitest";

import { revalidateBookAdmin, revalidateStorefront } from "@/lib/catalog/revalidate";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it("refreshes every public page under the locale layout", () => {
  revalidateStorefront();
  expect(revalidatePath).toHaveBeenCalledWith("/[locale]", "layout");
});

it("refreshes the storefront whenever a book changes in the admin", () => {
  revalidateBookAdmin("30000000-0000-4000-8000-000000000001");
  expect(revalidatePath).toHaveBeenCalledWith("/admin/books/30000000-0000-4000-8000-000000000001");
  expect(revalidatePath).toHaveBeenCalledWith("/[locale]", "layout");
});
```

In `app/admin/merchandising/actions.test.ts`, add `import { revalidatePath } from "next/cache";` to the imports, and extend the test `"saves the submitted order"` with:

```ts
    expect(revalidatePath).toHaveBeenCalledWith("/[locale]", "layout");
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run lib/catalog/revalidate.test.ts app/admin/merchandising/actions.test.ts`
Expected: FAIL. `revalidateStorefront` does not exist, and the merchandising action does not refresh the storefront.

- [ ] **Step 3: Write the implementation**

Replace `lib/catalog/revalidate.ts`:

```ts
import { revalidatePath } from "next/cache";

// Every public storefront page lives under /[locale]. Revalidating that layout refreshes the home,
// catalog, book, entity, and search pages together.
export function revalidateStorefront() {
  revalidatePath("/[locale]", "layout");
}

// Every page that shows a book's catalog data.
export function revalidateBookAdmin(bookId: string) {
  revalidatePath("/admin/books");
  revalidatePath(`/admin/books/${bookId}`);
  revalidateStorefront();
}
```

In `app/admin/merchandising/actions.ts`, add `import { revalidateStorefront } from "@/lib/catalog/revalidate";` and add this line right after `revalidatePath("/admin/merchandising");`:

```ts
  revalidateStorefront();
```

In `app/admin/entities/actions.ts`, add `import { revalidateStorefront } from "@/lib/catalog/revalidate";`. Then add `revalidateStorefront();` on the line right after each of the three `revalidatePath(config.adminPath);` calls (create, update, and localization save).

In `app/admin/publications/[publicationId]/actions.ts`, add `import { revalidateStorefront } from "@/lib/catalog/revalidate";`. Then add `revalidateStorefront();` right before `return { ok: true };` in `publishPublicationAction` and in `rollbackPublicationAction`. Both change the active publication, which changes `has_active_publication` and `has_sample`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run lib/catalog app/admin`
Expected: PASS. Existing assertions such as `expect(revalidatePath).not.toHaveBeenCalled()` on failed saves still pass, because failures return before any revalidation.

- [ ] **Step 5: Run the checks and commit**

```bash
npm run check
git add lib/catalog/revalidate.ts lib/catalog/revalidate.test.ts app/admin/entities/actions.ts app/admin/merchandising/actions.ts app/admin/merchandising/actions.test.ts "app/admin/publications/[publicationId]/actions.ts"
git commit -m "feat(admin): refresh the storefront after catalog changes"
```

---

### Task 12: Discovery E2E, runbook, and S2 gate

**Files:**
- Create: `e2e/support/catalog.ts`
- Create: `e2e/public-discovery.spec.ts`
- Create: `docs/runbooks/storefront.md`
- Modify: `docs/runbooks/catalog-admin.md`

**Interfaces:**
- Consumes: `createServiceRoleClient` from `e2e/support/supabase.ts`; `readLatestLink` from `e2e/support/mailpit.ts`; every S2 page.
- Produces:
  - `seedCatalogBook(options): Promise<{ bookId: string; topicSlug: string }>`
  - `setHomeFeatured(bookId: string): Promise<void>`

The seed writes rows directly with the service role. This is on purpose. S1's E2E already proves the admin path that makes a book publishable. S2 tests what readers see. The seed runs only against the local stack, because `createServiceRoleClient` refuses non-loopback URLs.

- [ ] **Step 1: Write the seed helper**

Create `e2e/support/catalog.ts`:

```ts
import { createServiceRoleClient } from "./supabase";

// Seeds a complete catalog book for public-page tests. Service role only; local stack only.
// S1's admin-catalog spec covers the operator path that produces the same rows.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

type Locale = "vi" | "en";

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function seedCatalogBook(options: {
  suffix: string;
  localizations: Partial<Record<Locale, { slug: string; title: string }>>;
  priceMinor?: number;
  status?: "published" | "draft";
  withSample?: boolean;
}): Promise<{ bookId: string; topicSlug: string }> {
  const service = createServiceRoleClient();
  const { suffix, localizations } = options;
  const locales = Object.keys(localizations) as Locale[];

  const author = check(
    await service
      .from("authors")
      .insert({ canonical_slug: `e2e-author-${suffix}`, display_name: `E2E Author ${suffix}`, status: "published" })
      .select("id")
      .single(),
  );
  check(
    await service.from("author_localizations").insert(
      locales.map((locale) => ({
        author_id: author.id,
        locale,
        slug: `e2e-author-${locale}-${suffix}`,
        name: `E2E Author ${suffix}`,
      })),
    ),
  );

  const book = check(
    await service
      .from("books")
      .insert({ canonical_key: `e2e-book-${suffix}`, original_language: locales[0], primary_author_id: author.id })
      .select("id")
      .single(),
  );
  check(
    await service.from("book_localizations").insert(
      locales.map((locale) => ({
        book_id: book.id,
        locale,
        slug: localizations[locale]!.slug,
        title: localizations[locale]!.title,
        short_description: `Short copy ${suffix}`,
        description: `Long copy ${suffix}`,
      })),
    ),
  );

  const edition = check(
    await service.from("editions").insert({ book_id: book.id, language_code: locales[0] }).select("id").single(),
  );
  const sku = check(
    await service.from("skus").insert({ edition_id: edition.id, sku_code: `e2e-sku-${suffix}` }).select("id").single(),
  );
  check(await service.from("offers").insert({ sku_id: sku.id, market_code: "VN", currency: "VND", price_minor: options.priceMinor ?? 0 }));

  const asset = check(
    await service
      .from("ebook_assets")
      .insert({ edition_id: edition.id, source_storage_key: `e2e/${suffix}/source.epub`, version: 1, status: "published" })
      .select("id")
      .single(),
  );
  const publication = check(
    await service
      .from("ebook_publications")
      .insert({ ebook_asset_id: asset.id, version: 1, manifest_key: `e2e/${suffix}/manifest.json`, status: "published" })
      .select("id")
      .single(),
  );
  if (options.withSample) {
    check(await service.from("book_samples").insert({ publication_id: publication.id, allowed_hrefs: ["OEBPS/text/chapter1.xhtml"] }));
  }

  const coverKey = `books/${book.id}/${crypto.randomUUID()}.png`;
  check(await service.storage.from("covers").upload(coverKey, PNG, { contentType: "image/png" }));
  check(
    await service
      .from("media_assets")
      .insert({ owner_type: "book", owner_id: book.id, kind: "cover", storage_key: coverKey, alt_text: `Cover ${suffix}` }),
  );

  const topic = check(
    await service
      .from("topics")
      .insert({ canonical_slug: `e2e-topic-${suffix}`, name: `E2E Topic ${suffix}`, status: "published" })
      .select("id")
      .single(),
  );
  const topicSlug = `e2e-topic-${locales[0]}-${suffix}`;
  check(
    await service.from("topic_localizations").insert(
      locales.map((locale) => ({ topic_id: topic.id, locale, slug: `e2e-topic-${locale}-${suffix}`, name: `E2E Topic ${suffix}` })),
    ),
  );
  check(await service.from("book_topics").insert({ book_id: book.id, topic_id: topic.id }));

  check(
    await service
      .from("books")
      .update({ active_publication_id: publication.id, status: options.status ?? "published" })
      .eq("id", book.id),
  );

  return { bookId: book.id, topicSlug };
}

export async function setHomeFeatured(bookId: string): Promise<void> {
  const service = createServiceRoleClient();
  check(await service.from("merchandising_slots").delete().eq("slot_key", "home_featured"));
  check(await service.from("merchandising_slots").insert({ slot_key: "home_featured", book_id: bookId, position: 1 }));
}
```

- [ ] **Step 2: Write the journeys**

Create `e2e/public-discovery.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { seedCatalogBook, setHomeFeatured } from "./support/catalog";
import { readLatestLink } from "./support/mailpit";

// S2 acceptance. Removing a published filter, the translation 404, the switcher alternate, the
// diacritic-insensitive search, or the sign-in return path must fail here.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("a reader goes from home to a book, signs in, and returns to the same book", async ({ page }) => {
  test.setTimeout(90_000);
  const suffix = unique();
  const title = `Harbour Notes ${suffix}`;
  const slug = `harbour-notes-${suffix}`;
  const viSlug = `ghi-chep-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title }, vi: { slug: viSlug, title: `Ghi chép ${suffix}` } },
    withSample: true,
  });
  await setHomeFeatured(bookId);

  await page.goto("/en");
  await page.getByRole("link", { name: title, exact: true }).first().click();

  await expect(page).toHaveURL(new RegExp(`/en/books/${slug}$`));
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read a sample" })).toHaveAttribute("href", `/en/read-sample/${slug}`);
  await expect(page.locator('a[hreflang="vi"]')).toHaveAttribute("href", `/vi/books/${viSlug}`);

  await page.getByRole("link", { name: "Get free" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/sign-in\\?next=%2Fen%2Fbooks%2F${slug}$`));

  const email = `discovery-${suffix}@example.test`;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send secure sign-in link" }).click();
  await expect(page.getByText("Check your email and follow the secure link to continue.")).toBeVisible();

  await page.goto(await readLatestLink(email));
  await expect(page).toHaveURL(new RegExp(`/en/books/${slug}$`));
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  // S3 enables this button.
  await expect(page.getByRole("button", { name: "Get free" })).toBeDisabled();
});

test("a book without a translation returns 404, and the switcher falls back to home", async ({ page }) => {
  const suffix = unique();
  const slug = `chi-tieng-viet-${suffix}`;
  const title = `Chỉ tiếng Việt ${suffix}`;
  await seedCatalogBook({ suffix, localizations: { vi: { slug, title } } });

  expect((await page.goto(`/en/books/${slug}`))?.status()).toBe(404);

  await page.goto(`/vi/books/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.locator('a[hreflang="en"]')).toHaveAttribute("href", "/en");
});

test("search and filters show only published books, with or without diacritics", async ({ page }) => {
  const suffix = unique();
  const title = `Đắc Nhân Tâm ${suffix}`;
  const draftTitle = `Đắc Nhân Tâm nháp ${suffix}`;
  const { topicSlug } = await seedCatalogBook({ suffix, localizations: { vi: { slug: `dac-nhan-tam-${suffix}`, title } } });
  await seedCatalogBook({
    suffix: `${suffix}-draft`,
    localizations: { vi: { slug: `nhap-${suffix}`, title: draftTitle } },
    status: "draft",
  });

  for (const query of [`dac nhan tam ${suffix}`, title]) {
    await page.goto(`/vi/search?${new URLSearchParams({ q: query })}`);
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText(draftTitle)).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  }

  expect((await page.goto(`/vi/books/nhap-${suffix}`))?.status()).toBe(404);

  await page.goto(`/vi/books?topic=${topicSlug}`);
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  await page.goto(`/vi/topics/${topicSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`E2E Topic ${suffix}`);
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
});
```

- [ ] **Step 3: Run the journeys**

Run the S2 spec against the local stack (export the variables as in Step 5 first):

```bash
npx playwright test e2e/public-discovery.spec.ts
```

Expected: 3 passed. If a test fails on the sign-in email, check the Mailpit and `[auth].site_url` notes in `docs/runbooks/testing-environments.md` before you debug the app.

- [ ] **Step 4: Write the runbook**

Create `docs/runbooks/storefront.md`:

```markdown
# Runbook: storefront

The storefront is every public page under `/vi` and `/en`. It shows only published catalog data.

## Pages

| Page | URL |
| --- | --- |
| Home | `/{locale}` |
| All books | `/{locale}/books` |
| Book | `/{locale}/books/<slug>` |
| Author | `/{locale}/authors/<slug>` |
| Series | `/{locale}/series/<slug>` |
| Topic | `/{locale}/topics/<slug>` |
| Search | `/{locale}/search?q=<words>` |

## When a page shows

- A **book** shows when it is published and has copy in that language.
- An **author**, **series**, or **topic** shows when it is published, has copy in that language, and
  has at least one visible book in that language.
- Anything else returns 404. A page never borrows copy from the other language.

## Common questions

- **"My book shows in Vietnamese but not English."** Add English copy in the book editor.
- **"The author page is 404."** Publish the author, add copy in that language, and check that one
  of their books is published in that language.
- **"The book says Not available yet."** The book has no active EPUB version, or no active offer.
- **"A paid book says Coming soon."** Payments are disabled in this environment. This is expected in
  production.
- **"The old book URL is 404 after a slug change."** Redirects are stored now. S5 serves them.
- **"Search does not find a book."** Search needs at least 2 characters. It ignores accents and
  case. It only finds published books with copy in the page language.

## Home page

`/admin/merchandising` sets the featured book and the home shelf. A book that is not visible in a
language is left out of that language's home page.

## Data access

Public pages call four read functions: `catalog_book_cards`, `catalog_book_page`,
`catalog_entity_page`, and `search_catalog`. They filter to published rows themselves, so an admin
sees the same storefront as a reader. Public pages never use the service-role key.
```

In `docs/runbooks/catalog-admin.md`, add this line at the end of the "Build a book" section:

```markdown
4. **Check the storefront.** Open `/vi/books/<slug>` and `/en/books/<slug>`. See
   `docs/runbooks/storefront.md` when a page is missing.
```

- [ ] **Step 5: Run the S2 gate against a local stack**

Run (add `--workdir <scratch>` to the `supabase` commands, and use a free app port, when the defaults are taken — see `docs/runbooks/testing-environments.md`):

```bash
supabase db reset
supabase test db
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
git diff --exit-code lib/supabase/database.types.ts
eval "$(supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" E2E_MAILPIT_URL="$MAILPIT_URL"
npm run check:full
```

Expected:
- every pgTAP file passes, including `016` and `017`;
- the regenerated types match the committed file;
- `npm run check` passes;
- Playwright runs every spec with none skipped, including the 3 new tests in `public-discovery.spec.ts`, `public-home.spec.ts`, and `localized-routing.spec.ts`.

If a pgTAP file fails after Playwright ran against the same stack, reset and rerun before you debug. Playwright leaves fixture rows behind.

- [ ] **Step 6: Commit**

```bash
git add e2e/support/catalog.ts e2e/public-discovery.spec.ts docs/runbooks/storefront.md docs/runbooks/catalog-admin.md
git commit -m "test: cover public discovery and document the storefront"
```

## S2 Completion Gate

- [ ] Only published entities render, at stable locale-prefixed URLs.
- [ ] An admin browsing the storefront sees no drafts.
- [ ] Search matches with and without Vietnamese diacritics, including `đ`.
- [ ] A missing translation returns 404, and the language switcher follows spec §4.6.
- [ ] `/books` filters by topic, author, series, and price, and filtered views are `noindex`.
- [ ] Home shows the featured book and the shelf from merchandising.
- [ ] Playwright: home → book → sign in → back on the same book.
- [ ] No public page creates a service-role client.
- [ ] `supabase test db`, `npm run check:full`, and the regenerated types all pass on a clean local stack.
