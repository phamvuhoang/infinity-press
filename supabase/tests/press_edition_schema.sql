begin;
select plan(34);

-- Press Task 3: edition publication pointer, default mapping, default offer, edition-scoped access
-- columns and bundle membership. Constraints live in the database, not only in TypeScript.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e3100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'es-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e3100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'es-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e3100000-0000-0000-0000-000000000001';
create temporary table t_p as
select (select id from public.profiles where auth_user_id = 'e3100000-0000-0000-0000-000000000001') as admin_id,
       (select id from public.profiles where auth_user_id = 'e3100000-0000-0000-0000-000000000002') as reader_id;
grant select on t_p to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('e3200000-0000-0000-0000-000000000001', 'es-author', 'ES Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('e3300000-0000-0000-0000-000000000001', 'es-book-a', 'en', 'e3200000-0000-0000-0000-000000000001', 'published'),
  ('e3300000-0000-0000-0000-000000000002', 'es-book-b', 'en', 'e3200000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code, edition_number) values
  ('e3400000-0000-0000-0000-000000000001', 'e3300000-0000-0000-0000-000000000001', 'en', 1),
  ('e3400000-0000-0000-0000-000000000002', 'e3300000-0000-0000-0000-000000000001', 'ja', 1),
  ('e3400000-0000-0000-0000-000000000003', 'e3300000-0000-0000-0000-000000000002', 'en', 1);
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('e3500000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000001', 'es/en/source.epub', 1, 'published'),
  ('e3500000-0000-0000-0000-000000000002', 'e3400000-0000-0000-0000-000000000002', 'es/ja/source.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('e3600000-0000-0000-0000-000000000001', 'e3500000-0000-0000-0000-000000000001', 1, 'es/en/manifest.json', 'published'),
  ('e3600000-0000-0000-0000-000000000002', 'e3500000-0000-0000-0000-000000000002', 1, 'es/ja/manifest.json', 'published');
insert into public.skus (id, edition_id, sku_code) values
  ('e3700000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000001', 'ES-EN'),
  ('e3700000-0000-0000-0000-000000000002', 'e3400000-0000-0000-0000-000000000002', 'ES-JA');
insert into public.offers (id, sku_id, market_code, currency, price_minor) values
  ('e3800000-0000-0000-0000-000000000001', 'e3700000-0000-0000-0000-000000000001', 'VN', 'VND', 50000),
  ('e3800000-0000-0000-0000-000000000002', 'e3700000-0000-0000-0000-000000000002', 'VN', 'VND', 60000);

-- (1)-(4) New columns and their defaults.
select is((select status::text from public.editions where id = 'e3400000-0000-0000-0000-000000000001'), 'draft', 'a new edition starts as draft');
select is((select active_publication_id from public.editions where id = 'e3400000-0000-0000-0000-000000000001'), null, 'a new edition has no active publication');
select is((select contributors from public.editions where id = 'e3400000-0000-0000-0000-000000000001'), '[]'::jsonb, 'contributors default to an empty list');
select throws_ok(
  $$update public.editions set contributors = '{"role":"translator"}'::jsonb where id = 'e3400000-0000-0000-0000-000000000001'$$,
  '23514', null, 'contributors must be a JSON array');

-- (5)-(7) The active publication must belong to the edition it is set on.
select throws_ok(
  $$update public.editions set active_publication_id = 'e3600000-0000-0000-0000-000000000002' where id = 'e3400000-0000-0000-0000-000000000001'$$,
  '23514', null, 'an edition cannot point at another edition''s publication');
select lives_ok(
  $$update public.editions set active_publication_id = 'e3600000-0000-0000-0000-000000000001', status = 'published' where id = 'e3400000-0000-0000-0000-000000000001'$$,
  'an edition can point at its own publication');
select throws_ok(
  $$update public.editions set active_publication_id = 'e3600000-0000-0000-0000-000000000002' where id = 'e3400000-0000-0000-0000-000000000003'$$,
  '23514', null, 'a publication of another book is refused too');

-- (8)-(11) One explicit default edition per book and language, and it must match both.
-- Publishing the first edition of a language records it as that language's default (trigger), and an
-- admin may later point the default at another edition by upsert.
select is((select edition_id from public.book_language_editions where book_id = 'e3300000-0000-0000-0000-000000000001' and language_code = 'en'), 'e3400000-0000-0000-0000-000000000001'::uuid, 'the first published edition of a language becomes its default');

select throws_ok(
  $$insert into public.book_language_editions (book_id, language_code, edition_id) values ('e3300000-0000-0000-0000-000000000001', 'en', 'e3400000-0000-0000-0000-000000000001')$$,
  '23505', null, 'a book and language have one default edition');
select throws_ok(
  $$insert into public.book_language_editions (book_id, language_code, edition_id) values ('e3300000-0000-0000-0000-000000000001', 'fr', 'e3400000-0000-0000-0000-000000000002')$$,
  '23503', null, 'the default edition must be written in that language');
select throws_ok(
  $$insert into public.book_language_editions (book_id, language_code, edition_id) values ('e3300000-0000-0000-0000-000000000002', 'en', 'e3400000-0000-0000-0000-000000000001')$$,
  '23503', null, 'the default edition must belong to that book');

-- (12)-(14) The default offer must be an offer of a SKU of that edition.
select lives_ok(
  $$insert into public.edition_default_offers (edition_id, sku_id, offer_id) values ('e3400000-0000-0000-0000-000000000001', 'e3700000-0000-0000-0000-000000000001', 'e3800000-0000-0000-0000-000000000001')$$,
  'an edition can name one of its own offers as default');
select throws_ok(
  $$insert into public.edition_default_offers (edition_id, sku_id, offer_id) values ('e3400000-0000-0000-0000-000000000002', 'e3700000-0000-0000-0000-000000000002', 'e3800000-0000-0000-0000-000000000001')$$,
  '23503', null, 'another edition''s offer cannot be the default');
select throws_ok(
  $$insert into public.edition_default_offers (edition_id, sku_id, offer_id) values ('e3400000-0000-0000-0000-000000000001', 'e3700000-0000-0000-0000-000000000001', 'e3800000-0000-0000-0000-000000000001')$$,
  '23505', null, 'an edition has one default offer');

-- (15)-(21) Access columns carry an edition that must belong to the same book.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, reference_code)
select 'e3900000-0000-0000-0000-000000000001', reader_id, 'completed', 'succeeded', 'VN', 'VND', 0, 0, 'IB-ES001' from t_p;
select lives_ok(
  $$insert into public.entitlements (id, profile_id, book_id, edition_id, source_type, source_order_id) select 'e3a00000-0000-0000-0000-000000000001', reader_id, 'e3300000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000001', 'free_order', 'e3900000-0000-0000-0000-000000000001' from t_p$$,
  'an entitlement can name the edition it grants');
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, edition_id, source_type, source_order_id) select admin_id, 'e3300000-0000-0000-0000-000000000002', 'e3400000-0000-0000-0000-000000000001', 'free_order', 'e3900000-0000-0000-0000-000000000001' from t_p$$,
  '23503', null, 'an entitlement cannot name an edition of a different book');
select lives_ok(
  $$insert into public.library_items (profile_id, book_id, edition_id, entitlement_id) select reader_id, 'e3300000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000001', 'e3a00000-0000-0000-0000-000000000001' from t_p$$,
  'a library item can name its edition');
select throws_ok(
  $$insert into public.library_items (profile_id, book_id, edition_id, entitlement_id) select reader_id, 'e3300000-0000-0000-0000-000000000002', 'e3400000-0000-0000-0000-000000000002', 'e3a00000-0000-0000-0000-000000000001' from t_p$$,
  '23503', null, 'a library item cannot name an edition of a different book');
select lives_ok(
  $$insert into public.order_items (order_id, sku_id, book_id, edition_id, language_code, title_snapshot, unit_price_minor) values ('e3900000-0000-0000-0000-000000000001', 'e3700000-0000-0000-0000-000000000001', 'e3300000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000001', 'en', 'ES Book', 0)$$,
  'an order item snapshots its edition and language');
select throws_ok(
  $$insert into public.book_reviews (book_id, edition_id, profile_id, rating, body, locale) select 'e3300000-0000-0000-0000-000000000002', 'e3400000-0000-0000-0000-000000000001', reader_id, 5, 'Good', 'en' from t_p$$,
  '23503', null, 'a review cannot name an edition of a different book');
select has_index('public', 'entitlements', 'entitlements_active_edition_key', 'active entitlements are unique per profile and edition');

-- (22)-(25) Bundles hold fixed editions, readable only while the bundle is published.
insert into public.bundles (id, status) values
  ('e3b00000-0000-0000-0000-000000000001', 'published'),
  ('e3b00000-0000-0000-0000-000000000002', 'draft');
insert into public.bundle_editions (bundle_id, edition_id, position) values
  ('e3b00000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000001', 1),
  ('e3b00000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000002', 2),
  ('e3b00000-0000-0000-0000-000000000002', 'e3400000-0000-0000-0000-000000000001', 1);
select throws_ok(
  $$insert into public.bundle_editions (bundle_id, edition_id, position) values ('e3b00000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000003', 2)$$,
  '23505', null, 'a bundle position holds one edition');
select throws_ok(
  $$insert into public.bundle_editions (bundle_id, edition_id, position) values ('e3b00000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000001', 3)$$,
  '23505', null, 'an edition appears once per bundle');
set local role anon;
select is((select count(*) from public.bundle_editions), 2::bigint, 'anon sees only the published bundle''s editions');
select throws_ok(
  $$insert into public.bundle_editions (bundle_id, edition_id, position) values ('e3b00000-0000-0000-0000-000000000001', 'e3400000-0000-0000-0000-000000000003', 3)$$,
  '42501', null, 'anon cannot edit bundle membership');
reset role;

-- (26)-(28) Writes to the publication pointer and status are not open to ordinary clients.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e3100000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$update public.editions set active_publication_id = null where id = 'e3400000-0000-0000-0000-000000000001'$$,
  '42501', null, 'even an admin session cannot move the pointer outside the publishing RPCs');
select throws_ok(
  $$update public.editions set status = 'published' where id = 'e3400000-0000-0000-0000-000000000002'$$,
  '42501', null, 'status changes only through the publishing RPCs');
select throws_ok(
  $$insert into public.book_language_editions (book_id, language_code, edition_id) values ('e3300000-0000-0000-0000-000000000002', 'en', 'e3400000-0000-0000-0000-000000000003')$$,
  '42501', null, 'default edition mapping is written through RPCs, not directly');
reset role;

-- (29)-(30) Edition covers live beside book covers, one per edition.
select lives_ok(
  $$insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text, width, height) values ('edition', 'e3400000-0000-0000-0000-000000000002', 'cover', 'es/ja/cover.png', 'cover alt', 600, 900)$$,
  'an edition can own a cover');
select throws_ok(
  $$insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text, width, height) values ('edition', 'e3400000-0000-0000-0000-000000000002', 'cover', 'es/ja/cover2.png', 'cover alt', 600, 900)$$,
  '23505', null, 'an edition has one cover');

-- (31)-(32) The work-level default content language is optional and registry-checked.
select lives_ok(
  $$update public.books set default_content_language = 'ja' where id = 'e3300000-0000-0000-0000-000000000001'$$,
  'a work can override the platform default language');
select throws_ok(
  $$update public.books set default_content_language = 'xx' where id = 'e3300000-0000-0000-0000-000000000001'$$,
  '23503', null, 'the override must be a registered content language');

-- (33)-(34) An edition with orders or entitlements keeps its language; a fresh one may still change.
select throws_ok(
  $$update public.editions set language_code = 'fr' where id = 'e3400000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a sold edition cannot change language');
select lives_ok(
  $$update public.editions set language_code = 'fr' where id = 'e3400000-0000-0000-0000-000000000003'$$,
  'an edition nobody owns may still be corrected');

select * from finish();
rollback;
