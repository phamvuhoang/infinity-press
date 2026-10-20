begin;
select plan(46);

-- Fixed fixtures, inserted with elevated privileges before switching roles.
insert into public.authors (id, canonical_slug, display_name, status) values
  ('00000000-0000-0000-0000-000000000001', 'author-published', 'Published Author', 'published'),
  ('00000000-0000-0000-0000-000000000011', 'author-draft', 'Draft Author', 'draft');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('00000000-0000-0000-0000-000000000002', 'book-published', 'en', '00000000-0000-0000-0000-000000000001', 'published'),
  ('00000000-0000-0000-0000-000000000009', 'book-draft', 'en', '00000000-0000-0000-0000-000000000001', 'draft');

insert into public.book_localizations (id, book_id, locale, slug, title) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'en', 'book-published-slug', 'Published Book'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000009', 'en', 'book-draft-slug', 'Draft Book');

insert into public.editions (id, book_id, language_code, edition_number) values
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000002', 'en', 1),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000009', 'en', 1);

insert into public.skus (id, edition_id, sku_code, active) values
  ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004', 'SKU-PUBLISHED-ACTIVE', true),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000b', 'SKU-DRAFT-ACTIVE', true),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000004', 'SKU-PUBLISHED-INACTIVE', false);

insert into public.offers (id, sku_id, market_code, currency, price_minor, active, starts_at, ends_at) values
  ('00000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000005', 'US', 'USD', 999, true, now() - interval '1 day', now() + interval '1 day'),
  ('00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000005', 'GB', 'GBP', 999, false, null, null),
  ('00000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000005', 'CA', 'CAD', 999, true, now() - interval '2 day', now() - interval '1 day'),
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000c', 'AU', 'AUD', 999, true, null, null),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000012', 'US', 'USD', 999, true, null, null),
  ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000005', 'DE', 'EUR', 999, true, now() + interval '1 day', null);

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000004', 'assets/book-published-v1.epub', 1, 'published');

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('00000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-00000000000e', 1, 'manifests/book-published-v1.json', 'published');

insert into public.processing_jobs (id, target_id, status, correlation_id) values
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-00000000000e', 'completed', 'corr-1');

-- Pin the grant/revoke posture itself (run as the elevated connecting role, which can see all
-- grants): anon/authenticated must hold SELECT, and none of the revoked write privileges, on
-- the six public catalog tables. REFERENCES/TRIGGER are pre-existing default-ACL privileges
-- this migration never touches, so they are excluded rather than asserted away. If a grant or
-- revoke statement in the migration is changed or dropped, one of these four assertions fails.
select is_empty(
  $$select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('authors', 'books', 'book_localizations', 'editions', 'skus', 'offers')
      and grantee = 'anon'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')$$,
  'anon holds none of the revoked write privileges on the public catalog tables'
);
select is_empty(
  $$select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('authors', 'books', 'book_localizations', 'editions', 'skus', 'offers')
      and grantee = 'authenticated'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')$$,
  'authenticated holds none of the revoked write privileges on the public catalog tables'
);
select is(
  (select count(distinct table_name) from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in ('authors', 'books', 'book_localizations', 'editions', 'skus', 'offers')
       and grantee = 'anon'
       and privilege_type = 'SELECT')::int,
  6,
  'anon holds SELECT on all six public catalog tables'
);
select is(
  (select count(distinct table_name) from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in ('authors', 'books', 'book_localizations', 'editions', 'skus', 'offers')
       and grantee = 'authenticated'
       and privilege_type = 'SELECT')::int,
  6,
  'authenticated holds SELECT on all six public catalog tables'
);

-- Assertions as anon
set local role anon;

select ok(
  exists(select 1 from public.authors where id = '00000000-0000-0000-0000-000000000001'),
  'anon: published author is visible'
);
select ok(
  exists(select 1 from public.books where id = '00000000-0000-0000-0000-000000000002'),
  'anon: published book is visible'
);
select ok(
  exists(select 1 from public.book_localizations where id = '00000000-0000-0000-0000-000000000003'),
  'anon: localization of published book is visible'
);
select ok(
  exists(select 1 from public.editions where id = '00000000-0000-0000-0000-000000000004'),
  'anon: edition of published book is visible'
);
select ok(
  exists(select 1 from public.skus where id = '00000000-0000-0000-0000-000000000005'),
  'anon: active sku of published book is visible'
);
select ok(
  exists(select 1 from public.offers where id = '00000000-0000-0000-0000-000000000006'),
  'anon: active in-window offer is visible'
);

select ok(
  not exists(select 1 from public.books where id = '00000000-0000-0000-0000-000000000009'),
  'anon: draft book is not visible'
);
select ok(
  not exists(select 1 from public.book_localizations where id = '00000000-0000-0000-0000-00000000000a'),
  'anon: localization of draft book is not visible'
);
select ok(
  not exists(select 1 from public.editions where id = '00000000-0000-0000-0000-00000000000b'),
  'anon: edition of draft book is not visible'
);
select ok(
  not exists(select 1 from public.offers where id = '00000000-0000-0000-0000-000000000007'),
  'anon: inactive offer is not visible'
);
select ok(
  not exists(select 1 from public.offers where id = '00000000-0000-0000-0000-000000000008'),
  'anon: expired offer is not visible'
);
select ok(
  not exists(select 1 from public.offers where id = '00000000-0000-0000-0000-00000000000d'),
  'anon: active offer on draft book is not visible'
);

select ok(
  not exists(select 1 from public.authors where id = '00000000-0000-0000-0000-000000000011'),
  'anon: draft author is not visible'
);
select ok(
  not exists(select 1 from public.skus where id = '00000000-0000-0000-0000-00000000000c'),
  'anon: sku of draft book is not visible'
);
select ok(
  not exists(select 1 from public.skus where id = '00000000-0000-0000-0000-000000000012'),
  'anon: inactive sku of published book is not visible'
);
select ok(
  not exists(select 1 from public.offers where id = '00000000-0000-0000-0000-000000000013'),
  'anon: offer on an inactive sku is not visible'
);
select ok(
  not exists(select 1 from public.offers where id = '00000000-0000-0000-0000-000000000014'),
  'anon: future-dated offer is not visible'
);

select throws_ok(
  $$select * from public.ebook_assets$$,
  '42501',
  null,
  'anon: select from ebook_assets is rejected'
);
select throws_ok(
  $$select * from public.ebook_publications$$,
  '42501',
  null,
  'anon: select from ebook_publications is rejected'
);
select throws_ok(
  $$select * from public.processing_jobs$$,
  '42501',
  null,
  'anon: select from processing_jobs is rejected'
);
select throws_ok(
  $$select * from public.ebook_resources$$,
  '42501',
  null,
  'anon: select from ebook_resources is rejected'
);
select throws_ok(
  $$select * from public.book_samples$$,
  '42501',
  null,
  'anon: select from book_samples is rejected'
);

select throws_ok(
  $$insert into public.books (canonical_key, original_language, primary_author_id, status) values ('anon-insert', 'en', '00000000-0000-0000-0000-000000000001', 'draft')$$,
  '42501',
  null,
  'anon: insert into books is rejected'
);
select throws_ok(
  $$insert into public.processing_jobs (target_id, status, correlation_id) values ('00000000-0000-0000-0000-00000000000e', 'queued', 'corr-anon')$$,
  '42501',
  null,
  'anon: insert into processing_jobs is rejected'
);

reset role;

-- Assertions as authenticated
set local role authenticated;

select ok(
  exists(select 1 from public.authors where id = '00000000-0000-0000-0000-000000000001'),
  'authenticated: published author is visible'
);
select ok(
  exists(select 1 from public.books where id = '00000000-0000-0000-0000-000000000002'),
  'authenticated: published book is visible'
);
select ok(
  exists(select 1 from public.book_localizations where id = '00000000-0000-0000-0000-000000000003'),
  'authenticated: localization of published book is visible'
);
select ok(
  exists(select 1 from public.editions where id = '00000000-0000-0000-0000-000000000004'),
  'authenticated: edition of published book is visible'
);
select ok(
  exists(select 1 from public.skus where id = '00000000-0000-0000-0000-000000000005'),
  'authenticated: active sku of published book is visible'
);
select ok(
  exists(select 1 from public.offers where id = '00000000-0000-0000-0000-000000000006'),
  'authenticated: active in-window offer is visible'
);

select ok(
  not exists(select 1 from public.books where id = '00000000-0000-0000-0000-000000000009'),
  'authenticated: draft book is not visible'
);
select ok(
  not exists(select 1 from public.offers where id = '00000000-0000-0000-0000-000000000007'),
  'authenticated: inactive offer is not visible'
);
select ok(
  not exists(select 1 from public.offers where id = '00000000-0000-0000-0000-000000000008'),
  'authenticated: expired offer is not visible'
);
select ok(
  not exists(select 1 from public.offers where id = '00000000-0000-0000-0000-00000000000d'),
  'authenticated: active offer on draft book is not visible'
);

select ok(
  not exists(select 1 from public.skus where id = '00000000-0000-0000-0000-00000000000c'),
  'authenticated: sku of draft book is not visible'
);
select ok(
  not exists(select 1 from public.skus where id = '00000000-0000-0000-0000-000000000012'),
  'authenticated: inactive sku of published book is not visible'
);

-- 20260911180000_publication_transition_rpcs.sql (Task 6) grants `authenticated` table-level
-- SELECT on these four tables, so an admin can read a book's publishing history through the
-- is_admin()-gated policies it also adds - a signed-in *non-admin* like this session (no
-- user_roles row, no jwt claim set) now passes that grant but is still filtered to zero rows by
-- RLS, rather than being rejected outright with 42501 the way it was before that migration
-- existed. is_empty(), not throws_ok(): the query itself no longer raises.
select is_empty($$select * from public.ebook_assets$$, 'authenticated non-admin: no ebook_assets rows are visible');
select is_empty($$select * from public.ebook_publications$$, 'authenticated non-admin: no ebook_publications rows are visible');
select is_empty($$select * from public.processing_jobs$$, 'authenticated non-admin: no processing_jobs rows are visible');
select is_empty($$select * from public.ebook_resources$$, 'authenticated non-admin: no ebook_resources rows are visible');

-- book_samples is deliberately excluded from that grant (fix round 1, Important #1) - nothing in
-- the repository yet reads it, so it stays exactly where Task 2 left it: no table-level grant to
-- authenticated at all, still rejected with 42501 rather than filtered to empty by RLS.
select throws_ok(
  $$select * from public.book_samples$$,
  '42501',
  null,
  'authenticated: select from book_samples is rejected'
);

select throws_ok(
  $$insert into public.books (canonical_key, original_language, primary_author_id, status) values ('authenticated-insert', 'en', '00000000-0000-0000-0000-000000000001', 'draft')$$,
  '42501',
  null,
  'authenticated: insert into books is rejected'
);

reset role;

select * from finish();
rollback;
