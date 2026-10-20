begin;
select plan(34);

-- Press Task 3: deterministic legacy -> edition backfill. Legacy rows carry only a book; the
-- function maps each to exactly one edition from evidence (the SKU on the order, the asset behind a
-- publication) and refuses to guess. No row is ever granted an extra language to "stay compatible".

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e4100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'bf-reader1@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e4100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'bf-reader2@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e4100000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'bf-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
create temporary table t_p as
select (select id from public.profiles where auth_user_id = 'e4100000-0000-0000-0000-000000000001') as r1,
       (select id from public.profiles where auth_user_id = 'e4100000-0000-0000-0000-000000000002') as r2,
       (select id from public.profiles where auth_user_id = 'e4100000-0000-0000-0000-000000000003') as admin_id;

insert into public.authors (id, canonical_slug, display_name, status)
values ('e4200000-0000-0000-0000-000000000001', 'bf-author', 'BF Author', 'published');

-- Book A: one edition (en). Book B: two editions (en, ja). Book C: an unpublished draft with one.
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e4300000-0000-0000-0000-00000000000a', 'bf-a', 'en', 'e4200000-0000-0000-0000-000000000001', 'published'),
  ('e4300000-0000-0000-0000-00000000000b', 'bf-b', 'en', 'e4200000-0000-0000-0000-000000000001', 'published'),
  ('e4300000-0000-0000-0000-00000000000c', 'bf-c', 'en', 'e4200000-0000-0000-0000-000000000001', 'draft');
insert into public.editions (id, book_id, language_code) values
  ('e4400000-0000-0000-0000-00000000000a', 'e4300000-0000-0000-0000-00000000000a', 'en'),
  ('e4400000-0000-0000-0000-0000000000b1', 'e4300000-0000-0000-0000-00000000000b', 'en'),
  ('e4400000-0000-0000-0000-0000000000b2', 'e4300000-0000-0000-0000-00000000000b', 'ja'),
  ('e4400000-0000-0000-0000-00000000000c', 'e4300000-0000-0000-0000-00000000000c', 'en');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('e4500000-0000-0000-0000-00000000000a', 'e4400000-0000-0000-0000-00000000000a', 'bf/a.epub', 1, 'published'),
  ('e4500000-0000-0000-0000-0000000000b1', 'e4400000-0000-0000-0000-0000000000b1', 'bf/b-en.epub', 1, 'published'),
  ('e4500000-0000-0000-0000-0000000000b2', 'e4400000-0000-0000-0000-0000000000b2', 'bf/b-ja.epub', 1, 'ready_for_preview');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('e4600000-0000-0000-0000-00000000000a', 'e4500000-0000-0000-0000-00000000000a', 1, 'bf/a.json', 'published'),
  ('e4600000-0000-0000-0000-0000000000b1', 'e4500000-0000-0000-0000-0000000000b1', 1, 'bf/b-en.json', 'published'),
  ('e4600000-0000-0000-0000-0000000000b2', 'e4500000-0000-0000-0000-0000000000b2', 1, 'bf/b-ja.json', 'ready_for_preview');
-- Legacy pointers live on the book.
update public.books set active_publication_id = 'e4600000-0000-0000-0000-00000000000a' where id = 'e4300000-0000-0000-0000-00000000000a';
update public.books set active_publication_id = 'e4600000-0000-0000-0000-0000000000b1' where id = 'e4300000-0000-0000-0000-00000000000b';

insert into public.skus (id, edition_id, sku_code) values
  ('e4700000-0000-0000-0000-00000000000a', 'e4400000-0000-0000-0000-00000000000a', 'BF-A'),
  ('e4700000-0000-0000-0000-0000000000b1', 'e4400000-0000-0000-0000-0000000000b1', 'BF-B-EN'),
  ('e4700000-0000-0000-0000-0000000000b2', 'e4400000-0000-0000-0000-0000000000b2', 'BF-B-JA');
-- A has one active offer; B-EN has two (no safe default); B-JA has none.
insert into public.offers (id, sku_id, market_code, currency, price_minor) values
  ('e4800000-0000-0000-0000-00000000000a', 'e4700000-0000-0000-0000-00000000000a', 'VN', 'VND', 50000),
  ('e4800000-0000-0000-0000-0000000000b1', 'e4700000-0000-0000-0000-0000000000b1', 'VN', 'VND', 50000),
  ('e4800000-0000-0000-0000-0000000000b2', 'e4700000-0000-0000-0000-0000000000b1', 'US', 'USD', 500);

-- Paid orders: r1 bought A; r2 bought B in Japanese; r1 also got B in English for free.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, reference_code) values
  ('e4900000-0000-0000-0000-000000000001', (select r1 from t_p), 'completed', 'succeeded', 'VN', 'VND', 50000, 50000, 'IB-BF001'),
  ('e4900000-0000-0000-0000-000000000002', (select r2 from t_p), 'completed', 'succeeded', 'VN', 'VND', 60000, 60000, 'IB-BF002'),
  ('e4900000-0000-0000-0000-000000000003', (select r1 from t_p), 'completed', 'not_required', 'VN', 'VND', 0, 0, 'IB-BF003');
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor) values
  ('e4900000-0000-0000-0000-000000000001', 'e4700000-0000-0000-0000-00000000000a', 'e4300000-0000-0000-0000-00000000000a', 'A', 50000),
  ('e4900000-0000-0000-0000-000000000002', 'e4700000-0000-0000-0000-0000000000b2', 'e4300000-0000-0000-0000-00000000000b', 'B ja', 60000),
  ('e4900000-0000-0000-0000-000000000003', 'e4700000-0000-0000-0000-0000000000b1', 'e4300000-0000-0000-0000-00000000000b', 'B en', 0);
insert into public.entitlements (id, profile_id, book_id, source_type, source_order_id) values
  ('e4a00000-0000-0000-0000-000000000001', (select r1 from t_p), 'e4300000-0000-0000-0000-00000000000a', 'simulated_payment', 'e4900000-0000-0000-0000-000000000001'),
  ('e4a00000-0000-0000-0000-000000000002', (select r2 from t_p), 'e4300000-0000-0000-0000-00000000000b', 'simulated_payment', 'e4900000-0000-0000-0000-000000000002'),
  ('e4a00000-0000-0000-0000-000000000003', (select r1 from t_p), 'e4300000-0000-0000-0000-00000000000b', 'free_order', 'e4900000-0000-0000-0000-000000000003');
insert into public.library_items (id, profile_id, book_id, entitlement_id) values
  ('e4b00000-0000-0000-0000-000000000001', (select r1 from t_p), 'e4300000-0000-0000-0000-00000000000a', 'e4a00000-0000-0000-0000-000000000001'),
  ('e4b00000-0000-0000-0000-000000000002', (select r2 from t_p), 'e4300000-0000-0000-0000-00000000000b', 'e4a00000-0000-0000-0000-000000000002'),
  ('e4b00000-0000-0000-0000-000000000003', (select r1 from t_p), 'e4300000-0000-0000-0000-00000000000b', 'e4a00000-0000-0000-0000-000000000003');
-- One review per reader: r2 reviewed B and owns only the Japanese edition.
insert into public.book_reviews (id, book_id, profile_id, rating, body, locale)
select 'e4c00000-0000-0000-0000-000000000001', 'e4300000-0000-0000-0000-00000000000b', r2, 5, 'Lovely', 'ja' from t_p;
-- Bundles: one over single-edition book A, one over multi-edition book B (ambiguous).
insert into public.bundles (id, status) values
  ('e4d00000-0000-0000-0000-000000000001', 'published'),
  ('e4d00000-0000-0000-0000-000000000002', 'draft');
insert into public.bundle_books (bundle_id, book_id, position) values
  ('e4d00000-0000-0000-0000-000000000001', 'e4300000-0000-0000-0000-00000000000a', 1),
  ('e4d00000-0000-0000-0000-000000000002', 'e4300000-0000-0000-0000-00000000000b', 1);
-- Reading progress and annotations point at publications, which already identify an edition.
insert into public.reading_progress (profile_id, publication_id, locator_json, progression, device_id, client_sequence)
select r2, 'e4600000-0000-0000-0000-0000000000b2', '{"href":"a"}'::jsonb, 0.5, 'd', 1 from t_p;

-- (1)-(3) The bundle over a multi-edition book makes the whole run ambiguous: dry run reports it.
select is(
  (select public.press_edition_backfill(false) #>> '{ambiguous,bundle_books,0}'),
  'e4d00000-0000-0000-0000-000000000002/e4300000-0000-0000-0000-00000000000b',
  'the dry run names the ambiguous bundle membership by ids only');
select is(
  (select public.press_edition_backfill(false) ->> 'applied'), 'false', 'a dry run applies nothing');
select throws_ok(
  $$select public.press_edition_backfill(true)$$, '55000', null, 'an ambiguous run refuses to apply');

-- (4)-(5) Nothing changed: the refusal is all-or-nothing.
select is((select count(*) from public.entitlements where edition_id is not null), 0::bigint, 'no entitlement was mapped by the refused run');
select is((select count(*) from public.editions where active_publication_id is not null), 0::bigint, 'no pointer was set by the refused run');

-- Resolve the ambiguity the way an operator would: the bundle over B is drafted away.
delete from public.bundle_books where bundle_id = 'e4d00000-0000-0000-0000-000000000002';

-- (6)-(8) An admin grant on a multi-edition book has no evidence to pick a language.
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason)
select 'e4a00000-0000-0000-0000-000000000009', r2, 'e4300000-0000-0000-0000-00000000000a', 'admin_grant', admin_id, 'support' from t_p;
-- (single-edition book: that grant is mappable, so it must NOT be reported)
select is(
  (select jsonb_array_length(public.press_edition_backfill(false) -> 'ambiguous' -> 'entitlements')), 0,
  'an admin grant on a single-edition book is mappable');
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason)
select 'e4a00000-0000-0000-0000-00000000000a', admin_id, 'e4300000-0000-0000-0000-00000000000b', 'admin_grant', admin_id, 'support' from t_p;
select is(
  (select public.press_edition_backfill(false) #>> '{ambiguous,entitlements,0}'),
  'e4a00000-0000-0000-0000-00000000000a',
  'an admin grant on a two-edition book is reported, never guessed');
select throws_ok($$select public.press_edition_backfill(true)$$, '55000', null, 'and it blocks the run');
-- The operator resolves it by revoking the unscoped grant.
update public.entitlements set status = 'revoked', revoked_at = now() where id = 'e4a00000-0000-0000-0000-00000000000a';
-- A revoked row still has to map or the history is lost: it is still ambiguous.
select is(
  (select public.press_edition_backfill(false) #>> '{ambiguous,entitlements,0}'),
  'e4a00000-0000-0000-0000-00000000000a',
  'a revoked unscoped grant is still reported: history must map too');
delete from public.library_items where entitlement_id = 'e4a00000-0000-0000-0000-00000000000a';
delete from public.entitlements where id = 'e4a00000-0000-0000-0000-00000000000a';

-- (10)-(11) Clean run applies.
select is((select public.press_edition_backfill(true) ->> 'applied'), 'true', 'an unambiguous run applies');
select is((select (public.press_edition_backfill(true) -> 'counts' ->> 'entitlements')::int), 0, 'a second run changes nothing (idempotent)');

-- (12)-(14) Publication pointers move from the book to the edition the asset belongs to.
select is((select active_publication_id from public.editions where id = 'e4400000-0000-0000-0000-00000000000a'), 'e4600000-0000-0000-0000-00000000000a'::uuid, 'edition A points at its publication');
select is((select active_publication_id from public.editions where id = 'e4400000-0000-0000-0000-0000000000b1'), 'e4600000-0000-0000-0000-0000000000b1'::uuid, 'edition B-EN points at the English publication');
select is((select active_publication_id from public.editions where id = 'e4400000-0000-0000-0000-0000000000b2'), null, 'edition B-JA is not given the book''s English publication');

-- (15)-(17) Edition status follows the evidence, not the book.
select is((select status::text from public.editions where id = 'e4400000-0000-0000-0000-00000000000a'), 'published', 'an edition with a live publication of a published book is published');
select is((select status::text from public.editions where id = 'e4400000-0000-0000-0000-0000000000b2'), 'draft', 'an edition without a publication stays draft');
select is((select status::text from public.editions where id = 'e4400000-0000-0000-0000-00000000000c'), 'draft', 'an edition of a draft book stays draft');

-- (18)-(20) Order items take the SKU's edition and its language.
select is((select edition_id from public.order_items where order_id = 'e4900000-0000-0000-0000-000000000002'), 'e4400000-0000-0000-0000-0000000000b2'::uuid, 'the order item maps to the SKU''s edition');
select is((select language_code from public.order_items where order_id = 'e4900000-0000-0000-0000-000000000002'), 'ja', 'and snapshots its language');
select is((select count(*) from public.order_items where edition_id is null), 0::bigint, 'every order item is mapped');

-- (21)-(24) Entitlements and library items keep exactly the edition bought; no language is added.
select is((select edition_id from public.entitlements where id = 'e4a00000-0000-0000-0000-000000000002'), 'e4400000-0000-0000-0000-0000000000b2'::uuid, 'the Japanese purchase stays Japanese');
select is((select edition_id from public.entitlements where id = 'e4a00000-0000-0000-0000-000000000003'), 'e4400000-0000-0000-0000-0000000000b1'::uuid, 'the free English copy stays English');
select is((select edition_id from public.library_items where id = 'e4b00000-0000-0000-0000-000000000002'), 'e4400000-0000-0000-0000-0000000000b2'::uuid, 'the library item follows its entitlement');
select is((select count(*) from public.entitlements where book_id = 'e4300000-0000-0000-0000-00000000000b'), 2::bigint, 'no entitlement was created to cover another language');

-- (25)-(26) A review maps to the edition its author owns; a single-edition book maps directly.
select is((select edition_id from public.book_reviews where id = 'e4c00000-0000-0000-0000-000000000001'), 'e4400000-0000-0000-0000-0000000000b2'::uuid, 'a review maps to the edition its author owns');
select is((select edition_id from public.entitlements where id = 'e4a00000-0000-0000-0000-000000000009'), 'e4400000-0000-0000-0000-00000000000a'::uuid, 'an admin grant on a single-edition book maps to that edition');

-- (27)-(28) Defaults: one edition per book and language where unambiguous.
select is((select edition_id from public.book_language_editions where book_id = 'e4300000-0000-0000-0000-00000000000b' and language_code = 'ja'), 'e4400000-0000-0000-0000-0000000000b2'::uuid, 'the only Japanese edition becomes the Japanese default');
select is((select count(*) from public.book_language_editions), 4::bigint, 'one default per book and language');

-- (29)-(31) The default offer is set only where exactly one active offer exists.
select is((select offer_id from public.edition_default_offers where edition_id = 'e4400000-0000-0000-0000-00000000000a'), 'e4800000-0000-0000-0000-00000000000a'::uuid, 'a single active offer becomes the default');
select is((select count(*) from public.edition_default_offers where edition_id = 'e4400000-0000-0000-0000-0000000000b1'), 0::bigint, 'two offers: the admin must choose, nothing is picked');
select is((select count(*) from public.edition_default_offers where edition_id = 'e4400000-0000-0000-0000-0000000000b2'), 0::bigint, 'no offer, no default');

-- (32)-(33) Bundles hold the fixed edition of a single-edition book.
select is((select edition_id from public.bundle_editions where bundle_id = 'e4d00000-0000-0000-0000-000000000001'), 'e4400000-0000-0000-0000-00000000000a'::uuid, 'bundle membership maps to the only edition');
select is((select count(*) from public.bundle_editions), 1::bigint, 'only real memberships were created');

-- (34) Progress is untouched: it already pointed at a publication, which identifies its edition.
select is((select publication_id from public.reading_progress limit 1), 'e4600000-0000-0000-0000-0000000000b2'::uuid, 'reading progress still points at the same publication');

select * from finish();
rollback;
