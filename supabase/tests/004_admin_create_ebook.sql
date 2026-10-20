begin;
select plan(16);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ace-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ace-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001';

-- (a) anon holds no EXECUTE on admin_create_ebook - checked directly against the grant rather
-- than by calling the function. The function's own is_admin() check also raises 42501 (see (b)
-- below), so a call that actually reached the function body would look identical, from
-- throws_ok's point of view, to one rejected at the grant - proving nothing about Ruling R's
-- revoke specifically. has_function_privilege() asks the one question that matters here (fix
-- carried back from Task 3's review, which found the same vacuous pattern copied into
-- 005_ebook_storage.sql from here).
select is(
  has_function_privilege(
    'anon',
    'public.admin_create_ebook(text, text, text, text, text, text, text, text, bigint)',
    'EXECUTE'
  ),
  false,
  'anon holds no EXECUTE on admin_create_ebook'
);

-- (b) a signed-in non-admin passes the grant but is rejected by the function's own is_admin()
-- check.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.admin_create_ebook('reader-book', 'Reader Author', 'vi', 'en', 'Reader Book', 'reader-book', 'VN', 'VND', 0)$$,
  '42501',
  'admin_create_ebook: caller is not an admin',
  'authenticated non-admin: admin_create_ebook is rejected'
);

-- (c) an admin succeeds and gets back a book id.
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select isnt(
  (select public.admin_create_ebook('the-golden-book', 'Phuong Bui', 'vi', 'en', 'The Golden Book', 'cuon-sach-vang', 'VN', 'VND', 0)),
  null,
  'admin: admin_create_ebook returns a book id'
);

-- (d) the graph landed: one row in each of the six tables, correctly linked and with locale,
-- language, market, and currency kept independent of one another. Back to the unrestricted
-- test-runner role for these reads, which sidesteps RLS entirely rather than exercising it - (g)
-- below is where the new admin-read policies (Ruling AP) actually get tested.
reset role;
select results_eq(
  $$select locale, slug, title from public.book_localizations bl
    join public.books b on b.id = bl.book_id
    where b.canonical_key = 'the-golden-book'$$,
  $$values ('vi'::text, 'cuon-sach-vang'::text, 'The Golden Book'::text)$$,
  'admin: localization recorded with the right locale, slug, and title'
);
select results_eq(
  $$select b.original_language, e.language_code from public.books b
    join public.editions e on e.book_id = b.id
    where b.canonical_key = 'the-golden-book'$$,
  $$values ('en'::text, 'en'::text)$$,
  'admin: book and edition carry the book''s own language, independent of locale'
);
select results_eq(
  $$select o.market_code, o.currency, o.price_minor from public.offers o
    join public.skus s on s.id = o.sku_id
    join public.editions e on e.id = s.edition_id
    join public.books b on b.id = e.book_id
    where b.canonical_key = 'the-golden-book'$$,
  $$values ('VN'::text, 'VND'::text, 0::bigint)$$,
  'admin: offer carries the requested market, currency, and price'
);

-- (e) a duplicate call with the same localized slug is rejected outright. Execute privilege on
-- admin_create_ebook belongs to `authenticated` only (Ruling R), so re-enter that role with the
-- admin's jwt claim before calling it again.
--
-- Ruling AL: this call uses a different author name ('Someone Else', not 'Phuong Bui') on
-- purpose. admin_create_ebook inserts authors before book_localizations, and authors.canonical_
-- slug is itself unique - reusing the same author name would let this call be rejected on THAT
-- constraint before book_localizations' unique(locale, slug) is ever evaluated, leaving the
-- constraint this test exists to exercise entirely uncovered while the test still stayed green
-- (same 23505, same "no partial graph" outcome, for the wrong reason - the E2E equivalent of
-- this exact mistake is documented in the golden-path plan's Task 2 report). Asserting the exact
-- error message, not just the SQLSTATE, pins down which constraint fired: 23505 alone can't tell
-- authors.canonical_slug apart from book_localizations_locale_slug_key.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.admin_create_ebook('the-golden-book-2', 'Someone Else', 'vi', 'en', 'The Golden Book', 'cuon-sach-vang', 'VN', 'VND', 0)$$,
  '23505',
  'duplicate key value violates unique constraint "book_localizations_locale_slug_key"',
  'admin: a duplicate localized slug is rejected on book_localizations, specifically'
);

-- (f) ...and leaves no partial graph: all six table counts are exactly what the one successful
-- call above produced, not doubled and not short a row from a half-applied insert. Unfiltered
-- table-wide counts, not scoped to 'the-golden-book'/'phuong-bui': the failed second call's
-- author insert ('Someone Else') and book insert ('the-golden-book-2') both succeed before the
-- book_localizations insert fails and rolls the whole call back, so a scoped-by-key count would
-- not even look at the rows that need to disappear. Back to the unrestricted role again, for the
-- same reason as (d).
reset role;
select is((select count(*) from public.authors), 1::bigint, 'admin: duplicate call left authors count unchanged');
select is((select count(*) from public.books), 1::bigint, 'admin: duplicate call left books count unchanged');
select is(
  (select count(*) from public.book_localizations),
  1::bigint,
  'admin: duplicate call left book_localizations count unchanged'
);
select is((select count(*) from public.editions), 1::bigint, 'admin: duplicate call left editions count unchanged');
select is((select count(*) from public.skus), 1::bigint, 'admin: duplicate call left skus count unchanged');
select is((select count(*) from public.offers), 1::bigint, 'admin: duplicate call left offers count unchanged');

-- (g) Ruling AP: an admin can read the draft book graph created in (c) - across all six catalog
-- tables - through the new is_admin()-gated "admin reads ..." policies added by this task's
-- migration; anon and a signed-in non-admin cannot, matching the "public read published ..."
-- policies these six tables already carried (this book is 'draft', so those policies alone would
-- hide it from everyone). By this point in the file the only surviving rows are the one-of-each
-- graph from (c) - the duplicate call in (e) rolled its own author/book rows back - so a plain
-- unfiltered sum across the six tables is exact: 0 for anon and the non-admin, 6 for the admin.
set local role anon;
select is(
  (
    (select count(*) from public.authors) +
    (select count(*) from public.books) +
    (select count(*) from public.book_localizations) +
    (select count(*) from public.editions) +
    (select count(*) from public.skus) +
    (select count(*) from public.offers)
  )::bigint,
  0::bigint,
  'anon: zero rows visible across the draft book graph'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select is(
  (
    (select count(*) from public.authors) +
    (select count(*) from public.books) +
    (select count(*) from public.book_localizations) +
    (select count(*) from public.editions) +
    (select count(*) from public.skus) +
    (select count(*) from public.offers)
  )::bigint,
  0::bigint,
  'authenticated non-admin: zero rows visible across the draft book graph'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select is(
  (
    (select count(*) from public.authors) +
    (select count(*) from public.books) +
    (select count(*) from public.book_localizations) +
    (select count(*) from public.editions) +
    (select count(*) from public.skus) +
    (select count(*) from public.offers)
  )::bigint,
  6::bigint,
  'authenticated admin: reads all six rows of the draft book graph'
);

reset role;
select * from finish();
rollback;
