begin;
select plan(41);

-- Press Task 8 (acceptance A03-A05, A15 at the data layer): which edition and which copy a reader is
-- shown. The platform default content language and metadata locale are 'en' throughout.

insert into public.authors (id, canonical_slug, display_name, status)
values ('ea100000-0000-0000-0000-000000000001', 'res-author', 'Res Author', 'published');

-- One work per scenario. Each gets a title in the locales listed in its localizations.
insert into public.books (id, canonical_key, original_language, primary_author_id, status, default_content_language) values
  ('ea200000-0000-0000-0000-000000000001', 'res-all', 'en', 'ea100000-0000-0000-0000-000000000001', 'published', null),
  ('ea200000-0000-0000-0000-000000000002', 'res-en-vi', 'en', 'ea100000-0000-0000-0000-000000000001', 'published', null),
  ('ea200000-0000-0000-0000-000000000003', 'res-ja-no-offer', 'en', 'ea100000-0000-0000-0000-000000000001', 'published', null),
  ('ea200000-0000-0000-0000-000000000004', 'res-no-default', 'vi', 'ea100000-0000-0000-0000-000000000001', 'published', null),
  ('ea200000-0000-0000-0000-000000000005', 'res-book-default', 'vi', 'ea100000-0000-0000-0000-000000000001', 'published', 'vi'),
  ('ea200000-0000-0000-0000-000000000006', 'res-archived-ja', 'en', 'ea100000-0000-0000-0000-000000000001', 'published', null),
  ('ea200000-0000-0000-0000-000000000007', 'res-ja-en-copy', 'en', 'ea100000-0000-0000-0000-000000000001', 'published', null),
  ('ea200000-0000-0000-0000-000000000008', 'res-draft-ja', 'en', 'ea100000-0000-0000-0000-000000000001', 'published', null);

insert into public.book_localizations (book_id, locale, slug, title) values
  ('ea200000-0000-0000-0000-000000000001', 'en', 'res-all-en', 'All Three'),
  ('ea200000-0000-0000-0000-000000000001', 'ja', 'res-all-ja', 'すべての版'),
  ('ea200000-0000-0000-0000-000000000001', 'vi', 'res-all-vi', 'Cả ba bản'),
  ('ea200000-0000-0000-0000-000000000002', 'en', 'res-envi-en', 'English And Vietnamese'),
  ('ea200000-0000-0000-0000-000000000003', 'en', 'res-nooffer-en', 'Japanese Without Price'),
  ('ea200000-0000-0000-0000-000000000003', 'ja', 'res-nooffer-ja', 'こころのほしぞら'),
  ('ea200000-0000-0000-0000-000000000004', 'vi', 'res-nodefault-vi', 'Không có bản mặc định'),
  ('ea200000-0000-0000-0000-000000000005', 'vi', 'res-bookdefault-vi', 'Mặc định theo sách'),
  ('ea200000-0000-0000-0000-000000000006', 'en', 'res-archived-en', 'Archived Japanese'),
  ('ea200000-0000-0000-0000-000000000007', 'en', 'res-jaen-en', 'English Copy Only'),
  ('ea200000-0000-0000-0000-000000000008', 'en', 'res-draftja-en', 'Draft Japanese');

-- Editions: (book, language, status, price or null for no offer). Published ones get a live publication.
create temporary table t_ed (book int, lang text, status text, price bigint, currency text, edition_id uuid default gen_random_uuid());
grant select on t_ed to public;
insert into t_ed (book, lang, status, price, currency) values
  (1, 'en', 'published', 500, 'VND'), (1, 'ja', 'published', 500, 'JPY'), (1, 'vi', 'published', 50000, 'VND'),
  (2, 'en', 'published', 400, 'VND'), (2, 'vi', 'published', 40000, 'VND'),
  (3, 'en', 'published', 300, 'VND'), (3, 'ja', 'published', null, null),
  (4, 'vi', 'published', 30000, 'VND'), (4, 'ja', 'published', 400, 'JPY'),
  (5, 'vi', 'published', 20000, 'VND'),
  (6, 'en', 'published', 100, 'VND'), (6, 'ja', 'archived', 100, 'JPY'),
  (7, 'en', 'published', 200, 'VND'), (7, 'ja', 'published', 200, 'JPY'),
  (8, 'en', 'published', 300, 'VND'), (8, 'ja', 'draft', 300, 'JPY');

insert into public.editions (id, book_id, language_code)
select edition_id, ('ea200000-0000-0000-0000-00000000000' || book)::uuid, lang from t_ed;
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
select edition_id, edition_id, 'res/' || edition_id || '.epub', 1, 'published' from t_ed where status in ('published', 'archived');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language)
select edition_id, edition_id, 1, 'res/' || edition_id || '.json', 'published', lang from t_ed where status in ('published', 'archived');
insert into public.skus (id, edition_id, sku_code) select edition_id, edition_id, 'RES-' || edition_id from t_ed;
insert into public.offers (sku_id, market_code, currency, price_minor)
select edition_id, 'XX', currency, price from t_ed where price is not null;
-- Publish last, so each trigger sees a complete edition.
update public.editions e set active_publication_id = t.edition_id, status = t.status::public.content_status
from t_ed t where t.edition_id = e.id and t.status in ('published', 'archived');

create function pg_temp.ed(p_book int, p_lang text) returns uuid language sql as
  $$ select edition_id from t_ed where book = p_book and lang = p_lang $$;
create function pg_temp.bk(p_book int) returns uuid language sql as
  $$ select ('ea200000-0000-0000-0000-00000000000' || p_book)::uuid $$;
create function pg_temp.pick(p_locale text, p_book int) returns text language sql as
  $$ select coalesce(language_code, 'none') || ':' || is_language_fallback::text
     from public.catalog_book_cards(p_locale) where book_id = pg_temp.bk(p_book) $$;

-- A03/A04: one card per work, in the requested language when it exists.
select is(pg_temp.pick('ja', 1), 'ja:false', 'ja UI, JA edition exists: the JA edition');
select is(pg_temp.pick('en', 1), 'en:false', 'en UI: the EN edition');
select is(pg_temp.pick('vi', 1), 'vi:false', 'vi UI: the VI edition');
select is((select count(*) from public.catalog_book_cards('ja') where book_id = pg_temp.bk(1)), 1::bigint, 'one card per work');
select is(pg_temp.pick('ja', 2), 'en:true', 'ja UI, no JA edition, default EN: the EN edition, marked as a fallback');
select is((select price_minor || currency from public.catalog_book_cards('ja') where book_id = pg_temp.bk(2)), '400VND', 'and its price is the EN edition''s own');

-- A05: a JA edition with no offer is shown as JA, not swapped for the EN one that has a price.
select is(pg_temp.pick('ja', 3), 'ja:false', 'JA with no offer is still the JA edition');
select is((select offer_id from public.catalog_book_cards('ja') where book_id = pg_temp.bk(3)), null, 'it simply has no price yet');
select is(pg_temp.pick('en', 3), 'en:false', 'while EN readers are shown EN');

-- No default-language edition and none in the requested language: no third language by database order.
select is(pg_temp.pick('en', 4), null, 'default EN missing, UI EN: the work is not listed');
select is(pg_temp.pick('ja', 4), 'ja:false', 'but the JA edition shows for a JA reader');
select is(pg_temp.pick('vi', 4), 'vi:false', 'and the VI edition for a VI reader');

-- The work''s own default language beats the platform''s.
select is(pg_temp.pick('ja', 5), 'vi:true', 'a work whose default is VI falls back to VI, not to the platform''s EN');
select is(pg_temp.pick('en', 5), 'vi:true', 'for EN readers too');

-- Archived and draft editions are never offered.
select is(pg_temp.pick('ja', 6), 'en:true', 'an archived JA edition is not shown to new readers');
select is(pg_temp.pick('ja', 8), 'en:true', 'nor is a draft one');

-- Metadata and edition are chosen independently (A15 data layer): JA EPUB with only an EN copy.
select is(pg_temp.pick('ja', 7), 'ja:false', 'the JA edition is chosen although the work has no JA copy');
select is((select metadata_locale from public.catalog_book_cards('ja') where book_id = pg_temp.bk(7)), 'en', 'and its copy falls back to EN as a whole');
select is((select title from public.catalog_book_cards('ja') where book_id = pg_temp.bk(7)), 'English Copy Only', 'title and slug come from the same localization');

-- Single-work resolver: explicit edition wins, an invalid one answers nothing.
select is((select language_code from public.catalog_resolve_edition(pg_temp.bk(1), 'en', pg_temp.ed(1, 'ja'))), 'ja', 'an explicit JA edition is honoured under an EN UI');
select is((select count(*) from public.catalog_resolve_edition(pg_temp.bk(1), 'en', pg_temp.ed(2, 'en'))), 0::bigint, 'an edition of another work does not resolve');
select is((select count(*) from public.catalog_resolve_edition(pg_temp.bk(6), 'en', pg_temp.ed(6, 'ja'))), 0::bigint, 'an archived edition does not resolve explicitly');
select is((select count(*) from public.catalog_resolve_edition(pg_temp.bk(8), 'en', pg_temp.ed(8, 'ja'))), 0::bigint, 'a draft edition does not resolve explicitly');
select is((select count(*) from public.catalog_resolve_edition(pg_temp.bk(1), 'en', 'ea200000-0000-0000-0000-0000000000ff')), 0::bigint, 'an unknown edition does not fall through to the default');
select is((select edition_id from public.catalog_resolve_edition(pg_temp.bk(1), 'ja')), pg_temp.ed(1, 'ja'), 'without an explicit edition the language rule applies');
select is((select count(*) from public.catalog_resolve_edition(pg_temp.bk(4), 'en')), 0::bigint, 'and an unresolvable language rule yields nothing');

-- Set-wise and single-work resolution agree for every work and locale.
select is(
  (select count(*) from (
     select r.book_id, r.edition_id from public.catalog_resolved_editions('ja') r
     except
     select b.id, s.edition_id from public.books b cross join lateral public.catalog_resolve_edition(b.id, 'ja') s
   ) d),
  0::bigint, 'the list rule and the page rule agree (ja)');
select is(
  (select count(*) from (
     select b.id, s.edition_id from public.books b cross join lateral public.catalog_resolve_edition(b.id, 'en') s
     except
     select r.book_id, r.edition_id from public.catalog_resolved_editions('en') r
   ) d),
  0::bigint, 'and in the other direction (en)');

-- The page: the editions a reader may choose, with which one is the default.
select is((select jsonb_array_length(public.catalog_book_page('en', 'res-all-en') -> 'editions')), 3, 'the book page lists every readable edition');
select is((select e ->> 'languageCode' from jsonb_array_elements(public.catalog_book_page('ja', 'res-all-ja') -> 'editions') e where (e ->> 'isDefault')::boolean), 'ja', 'and marks the JA edition as the default under a JA UI');
select is((select (e ->> 'priceMinor') || (e ->> 'currency') from jsonb_array_elements(public.catalog_book_page('en', 'res-all-en') -> 'editions') e where e ->> 'languageCode' = 'ja'), '500JPY', 'each edition carries its own currency');
select is((select e -> 'priceMinor' from jsonb_array_elements(public.catalog_book_page('en', 'res-nooffer-en') -> 'editions') e where e ->> 'languageCode' = 'ja'), 'null'::jsonb, 'a JA edition without a default offer has no price');
select is((select count(*) from jsonb_array_elements(public.catalog_book_page('en', 'res-archived-en') -> 'editions')), 1::bigint, 'archived editions are not on the page');

-- Slugs: a work is reachable under the slug of the copy it is shown with, and no other.
select is(public.catalog_book_page('ja', 'res-all-ja') ->> 'bookId', pg_temp.bk(1)::text, 'the JA slug resolves under ja');
select is(public.catalog_book_page('ja', 'res-all-en'), null::jsonb, 'the EN slug does not alias the work under ja when a JA copy exists');
select is(public.catalog_book_page('ja', 'res-jaen-en') ->> 'metadataLocale', 'en', 'a work with no JA copy is reached under its EN slug, and says the copy is EN');

-- Japanese needs no spaces to be found.
select is((select count(*) from public.search_catalog('ja', 'ほしぞ') where kind = 'book' and slug = 'res-nooffer-ja'), 1::bigint, 'a kana fragment finds the book without word breaks');
select is((select score from public.search_catalog('ja', 'こころのほしぞら') where slug = 'res-nooffer-ja'), 3, 'the full title scores as an exact match');
select is((select count(*) from public.search_catalog('ja', 'draft japanese') where slug = 'res-draftja-en'), 1::bigint, 'search lists the work under the copy it would be shown with');
select is((select count(*) from public.search_catalog('en', 'does not exist anywhere')), 0::bigint, 'and nothing for an unknown phrase');
select is((select count(*) from public.search_catalog('en', 'no default')), 0::bigint, 'a work with nothing readable for EN is not searchable there');

select * from finish();
rollback;
