begin;
select plan(23);

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
