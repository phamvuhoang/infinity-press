begin;
select plan(11);

-- S9: the two findings from the second review of PR #28 (migration 20260925110000).
--
--   1. create_bundle_order must read its member list once. The bundle row lock it took in the
--      previous round stops admin_set_bundle_members; it does NOT stop unpublish_book, which locks
--      the book row and can commit between two reads of bundle_order_lines.
--   2. bundle_live_offer ignores bundle status by design, so it must not be reachable by a browser
--      role. The public read is catalog_bundle_live_offer, published bundles only.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-prfix2-buyer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000001') as buyer_id;
grant select on t_ids to public;

create extension if not exists dblink with schema extensions;
select extensions.dblink_connect('prfix2_settings', 'host=db port=5432 dbname=postgres user=postgres password=postgres');
select extensions.dblink_exec('prfix2_settings', $stmt$update public.commerce_settings set payments_enabled = true, payment_provider = 'simulator'$stmt$);
select extensions.dblink_disconnect('prfix2_settings');

insert into public.authors (id, canonical_slug, display_name, status)
values ('e3000000-0000-0000-0000-000000000001', 's9-prfix2-author', 'S9 PR Fix 2 Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e2000000-0000-0000-0000-000000000001', 's9-prfix2-book-1', 'vi', 'e3000000-0000-0000-0000-000000000001', 'published'),
  ('e2000000-0000-0000-0000-000000000002', 's9-prfix2-book-2', 'vi', 'e3000000-0000-0000-0000-000000000001', 'published');

insert into public.book_localizations (book_id, locale, slug, title) values
  ('e2000000-0000-0000-0000-000000000001', 'vi', 's9-prfix2-sach-mot', 'Sach mot'),
  ('e2000000-0000-0000-0000-000000000002', 'vi', 's9-prfix2-sach-hai', 'Sach hai');

insert into public.editions (id, book_id, language_code) values
  ('e4000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'vi'),
  ('e4000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 'vi');

insert into public.skus (id, edition_id, sku_code) values
  ('e5000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 'S9-PRFIX2-SKU-1'),
  ('e5000000-0000-0000-0000-000000000002', 'e4000000-0000-0000-0000-000000000002', 'S9-PRFIX2-SKU-2');

-- Bundle 1 is published and sells. Bundle 2 is a DRAFT with a live offer, which is the shape
-- finding 2 is about.
insert into public.bundles (id, status) values
  ('e7000000-0000-0000-0000-000000000001', 'published'),
  ('e7000000-0000-0000-0000-000000000002', 'draft');

insert into public.bundle_localizations (bundle_id, locale, slug, title, description) values
  ('e7000000-0000-0000-0000-000000000001', 'vi', 's9-prfix2-bo-mot', 'Bo mot', 'Mo ta'),
  ('e7000000-0000-0000-0000-000000000002', 'vi', 's9-prfix2-bo-hai', 'Bo hai', 'Mo ta');

insert into public.bundle_books (bundle_id, book_id, position) values
  ('e7000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 1),
  ('e7000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000002', 2),
  ('e7000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000001', 1),
  ('e7000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 2);

insert into public.offers (id, bundle_id, market_code, currency, price_minor, active) values
  ('e6000000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000001', 'VN', 'VND', 250000, true),
  ('e6000000-0000-0000-0000-000000000002', 'e7000000-0000-0000-0000-000000000002', 'VN', 'VND', 777000, true);

-- ==========================================================================================
-- Finding 2: the status-blind rule is not reachable from a browser (1-6)
-- ==========================================================================================
select has_function('public', 'catalog_bundle_live_offer', array['uuid'], 'catalog_bundle_live_offer exists');

-- The rule itself: granted to nobody a request can arrive as. This is the assertion that would
-- have failed before the split, and it is written against the catalog rather than against a call
-- because an ungranted function is refused before it runs.
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'bundle_live_offer'
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute'))),
  0,
  'the status-blind price rule is executable by no browser or worker role');

select ok(
  has_function_privilege('anon', 'public.catalog_bundle_live_offer(uuid)', 'execute'),
  'the public read is the one anon may call');

set local role anon;
select is(
  (select count(*)::int from public.catalog_bundle_live_offer('e7000000-0000-0000-0000-000000000002')),
  0,
  'a draft bundle has no public price, however well its id is known');

select is(
  (select l.price_minor from public.catalog_bundle_live_offer('e7000000-0000-0000-0000-000000000001') l),
  250000::bigint,
  'a published bundle answers with its live offer');

select throws_ok(
  $$select * from public.bundle_live_offer('e7000000-0000-0000-0000-000000000002')$$,
  '42501',
  null,
  'and anon cannot reach around the gate to the rule itself');
reset role;

-- ==========================================================================================
-- Finding 1: one membership snapshot (7-11)
--
-- The race itself cannot be staged from a test: unpublish_book takes no lock create_bundle_order
-- waits on, which is precisely why a lock was the wrong fix. What CAN be asserted is the property
-- that replaced it - the member list is read once - and the behaviour that property produces.
-- ==========================================================================================
select has_type('public', 'bundle_order_line', 'the order-line composite exists to carry the snapshot');

-- The invariant, stated where it cannot rot: a second call to bundle_order_lines is a second
-- snapshot, and a second snapshot is this defect. Asserted against the function source because the
-- interleaving that exploits it is not reachable from a test - see the note above.
select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace,
   lateral regexp_matches(p.prosrc, 'public\.bundle_order_lines\s*\(', 'g')
   where n.nspname = 'public' and p.proname = 'create_bundle_order'),
  1,
  'create_bundle_order reads its member list exactly once');

set local role authenticated;
set local "request.jwt.claim.sub" = 'e1000000-0000-0000-0000-000000000001';
create temporary table t_order (order_id uuid);
grant select, insert on t_order to public;
reset role;

set local role authenticated;
set local "request.jwt.claim.sub" = 'e1000000-0000-0000-0000-000000000001';
insert into t_order select public.create_bundle_order('e7000000-0000-0000-0000-000000000001');
reset role;

-- The snapshot is the whole published membership, priced on one line.
select is(
  (select count(*)::int from public.order_items i join t_order t on t.order_id = i.order_id),
  2,
  'both published members are on the order');
select is(
  (select sum(i.unit_price_minor)::bigint from public.order_items i join t_order t on t.order_id = i.order_id),
  250000::bigint,
  'and the bundle price sits on exactly one of them');

-- A member unpublished AFTER the order exists does not rewrite it. The order is what was sold.
update public.books set status = 'draft' where id = 'e2000000-0000-0000-0000-000000000002';
select is(
  (select count(*)::int from public.order_items i join t_order t on t.order_id = i.order_id),
  2,
  'unpublishing a member afterwards leaves the sold order alone');

select finish();
rollback;
