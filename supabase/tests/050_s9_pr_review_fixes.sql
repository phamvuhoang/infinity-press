begin;
select plan(20);

-- S9: the four defects found reviewing PR #28 (migration 20260925100000).
--
--   1. an admin resend or reissue must mint a NEW provider idempotency key, and a worker retry
--      must not;
--   2. the bundle page and create_bundle_order must resolve a live offer by one rule;
--   3. create_bundle_order must not validate one bundle membership and sell another;
--   4. a bundle whose only active offer is free must not pass the publish gate.
--
-- Findings 1, 2 and 4 are single-session properties and are asserted inside this transaction.
-- Finding 3 is a race and cannot be: it runs at the bottom, over two real connections.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-prfix-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-prfix-buyer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000001';

create temporary table t_ids as
select (select id from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000002') as buyer_id;
grant select on t_ids to public;

-- create_bundle_order needs payments enabled - here, and in the two concurrent sessions at the
-- bottom of this file, which cannot see anything this transaction has not committed. So the switch
-- is thrown once from a separate connection rather than by an update this transaction would hold a
-- row lock on until it rolls back: those sessions would wait on that lock forever.
create extension if not exists dblink with schema extensions;
select extensions.dblink_connect('prfix_settings', 'host=db port=5432 dbname=postgres user=postgres password=postgres');
select extensions.dblink_exec('prfix_settings', $stmt$update public.commerce_settings set payments_enabled = true, payment_provider = 'simulator'$stmt$);
select extensions.dblink_disconnect('prfix_settings');

insert into public.authors (id, canonical_slug, display_name, status)
values ('d3000000-0000-0000-0000-000000000001', 's9-prfix-author', 'S9 PR Fix Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('d2000000-0000-0000-0000-000000000001', 's9-prfix-book-1', 'vi', 'd3000000-0000-0000-0000-000000000001', 'published'),
  ('d2000000-0000-0000-0000-000000000002', 's9-prfix-book-2', 'vi', 'd3000000-0000-0000-0000-000000000001', 'published');

insert into public.book_localizations (book_id, locale, slug, title) values
  ('d2000000-0000-0000-0000-000000000001', 'vi', 's9-prfix-sach-mot', 'Sách một'),
  ('d2000000-0000-0000-0000-000000000002', 'vi', 's9-prfix-sach-hai', 'Sách hai');

insert into public.editions (id, book_id, language_code) values
  ('d4000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'vi'),
  ('d4000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000002', 'vi');

insert into public.skus (id, edition_id, sku_code) values
  ('d5000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001', 'S9-PRFIX-SKU-1'),
  ('d5000000-0000-0000-0000-000000000002', 'd4000000-0000-0000-0000-000000000002', 'S9-PRFIX-SKU-2');


-- Press: a bundle member is an EDITION that can be sold now, so each fixture edition of a published
-- work gets a live publication.
insert into public.ebook_assets (edition_id, source_storage_key, version, status)
select e.id, 'fx/' || e.id || '.epub', 1, 'published'
from public.editions e join public.books b on b.id = e.book_id
where b.status = 'published' and e.active_publication_id is null;
insert into public.ebook_publications (ebook_asset_id, version, manifest_key, status, epub_language)
select a.id, 1, 'fx/' || a.id || '.json', 'published', 'vi' from public.ebook_assets a where a.source_storage_key like 'fx/%';
update public.editions e set status = 'published', active_publication_id = p.id
from public.ebook_publications p join public.ebook_assets a on a.id = p.ebook_asset_id
where a.edition_id = e.id and a.source_storage_key like 'fx/%';

insert into public.bundles (id, status) values
  ('d7000000-0000-0000-0000-000000000001', 'published'),
  ('d7000000-0000-0000-0000-000000000002', 'draft');

insert into public.bundle_localizations (bundle_id, locale, slug, title, description) values
  ('d7000000-0000-0000-0000-000000000001', 'vi', 's9-prfix-bo-mot', 'Bộ một', 'Mô tả'),
  ('d7000000-0000-0000-0000-000000000002', 'vi', 's9-prfix-bo-hai', 'Bộ hai', 'Mô tả');

insert into public.bundle_editions (bundle_id, edition_id, position) values
  ('d7000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001', 1),
  ('d7000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000002', 2),
  ('d7000000-0000-0000-0000-000000000002', 'd4000000-0000-0000-0000-000000000001', 1),
  ('d7000000-0000-0000-0000-000000000002', 'd4000000-0000-0000-0000-000000000002', 2);

insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
values ('bundle', 'd7000000-0000-0000-0000-000000000002', 'cover', 'bundles/d7000000-0000-0000-0000-000000000002/cover.jpg', 'Bìa');

-- ==========================================================================================
-- Finding 2: one market-resolution rule (1-5)
--
-- Two live offers on one bundle, priced differently. The page and the order RPC must agree, and
-- the rule is the cheapest - the reader is never charged more than the page quoted.
-- ==========================================================================================
insert into public.offers (id, bundle_id, market_code, currency, price_minor, active) values
  ('d6000000-0000-0000-0000-000000000001', 'd7000000-0000-0000-0000-000000000001', 'US', 'USD', 900, true),
  ('d6000000-0000-0000-0000-000000000002', 'd7000000-0000-0000-0000-000000000001', 'VN', 'VND', 500, true);

select has_function('public', 'bundle_live_offer', array['uuid'], 'bundle_live_offer exists');

select is(
  (select l.offer_id from public.bundle_live_offer('d7000000-0000-0000-0000-000000000001') l),
  'd6000000-0000-0000-0000-000000000002'::uuid,
  'the cheapest live offer wins, not the first by market code');

-- The order the storefront sees is the order the buyer is charged. Before the fix this function
-- ordered by (market_code, currency) and would have booked the US offer at 900 while the page
-- showed 500.
create temporary table t_order (order_id uuid);
grant select, insert on t_order to public;

set local role authenticated;
set local "request.jwt.claim.sub" = 'd1000000-0000-0000-0000-000000000002';
insert into t_order select public.create_bundle_order('d7000000-0000-0000-0000-000000000001');
reset role;

select is(
  (select o.subtotal_minor from public.orders o join t_order t on t.order_id = o.id),
  500::bigint,
  'the order is booked at the price the bundle page shows');
select is(
  (select o.currency from public.orders o join t_order t on t.order_id = o.id),
  'VND',
  'and in that offer''s currency');
select is(
  (select sum(i.unit_price_minor)::bigint from public.order_items i join t_order t on t.order_id = i.order_id),
  500::bigint,
  'the line total still equals the order total');

-- ==========================================================================================
-- Finding 4: a publishable bundle is a buyable bundle (6-9)
-- ==========================================================================================
set local role authenticated;
set local "request.jwt.claim.sub" = 'd1000000-0000-0000-0000-000000000001';

select throws_ok(
  $$select public.admin_set_bundle_offer('d7000000-0000-0000-0000-000000000002', 'VN', 'VND', 0, true)$$,
  '22023',
  null,
  'an active bundle offer cannot be free');

-- Inactive at zero stays allowed: a draft price nothing reads.
select lives_ok(
  $$select public.admin_set_bundle_offer('d7000000-0000-0000-0000-000000000002', 'VN', 'VND', 0, false)$$,
  'an inactive zero-price row is still a legal draft price');
reset role;

-- The zero offer is forced active behind the RPC's back, which is the state a database that has
-- already applied the old migration can be in. Readiness must still refuse it.
update public.offers set active = true
where bundle_id = 'd7000000-0000-0000-0000-000000000002';

select ok(
  'missing_offer' = any(public.bundle_readiness_issues('d7000000-0000-0000-0000-000000000002')),
  'a bundle whose only active offer is free is not ready to publish');

update public.offers set price_minor = 700
where bundle_id = 'd7000000-0000-0000-0000-000000000002';

select ok(
  not ('missing_offer' = any(public.bundle_readiness_issues('d7000000-0000-0000-0000-000000000002'))),
  'a positive active offer clears the readiness rule');

-- ==========================================================================================
-- Finding 1: delivery generation (10-16)
-- ==========================================================================================
select has_column('public', 'notification_outbox', 'delivery_generation', 'the outbox carries a delivery generation');

insert into public.orders (id, profile_id, status, payment_status, market_code, currency,
                           subtotal_minor, discount_minor, total_minor, reference_code, payment_provider)
select 'd8000000-0000-0000-0000-000000000001', buyer_id, 'completed', 'succeeded', 'VN', 'VND',
       150000, 0, 150000, 'IB-PRFX1', 'simulator'
from t_ids;
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
values ('d8000000-0000-0000-0000-000000000001', 'd5000000-0000-0000-0000-000000000001',
        'd2000000-0000-0000-0000-000000000001', 'Sách một', 150000, 1);
insert into public.gifts (id, order_id, purchaser_profile_id, recipient_email, claim_token_hash, status)
select 'd9000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-000000000001', buyer_id,
       's9-prfix-recipient@example.test',
       encode(extensions.digest(convert_to('s9-prfix-token', 'UTF8'), 'sha256'), 'hex'), 'sent'
from t_ids;
insert into public.notification_outbox (id, gift_id, template_key, payload)
values ('da000000-0000-0000-0000-000000000001', 'd9000000-0000-0000-0000-000000000001', 'gift_claim',
        '{"claimPath": "/vi/gifts/claim/s9-prfix-token"}'::jsonb);

select is(
  (select delivery_generation from public.notification_outbox where id = 'da000000-0000-0000-0000-000000000001'),
  0,
  'a freshly written delivery starts at generation 0');

-- A worker claim is a retry, not a new delivery: it must leave the generation alone, or every
-- automatic retry would be sent to the provider as a separate email.
set local role service_role;
select is(
  (select c.delivery_generation from public.claim_notification_outbox(5, gen_random_uuid()) c
   where c.id = 'da000000-0000-0000-0000-000000000001'),
  0,
  'the worker is handed the generation and claiming does not change it');
reset role;

update public.notification_outbox
set lease_token = null, lease_expires_at = null, attempt_count = 3, last_error_code = 'provider_error'
where id = 'da000000-0000-0000-0000-000000000001';

set local role authenticated;
set local "request.jwt.claim.sub" = 'd1000000-0000-0000-0000-000000000001';
select lives_ok(
  $$select public.admin_resend_gift('d9000000-0000-0000-0000-000000000001')$$,
  'an admin resends a sent gift');
reset role;

select is(
  (select delivery_generation from public.notification_outbox where id = 'da000000-0000-0000-0000-000000000001'),
  1,
  'a resend is a new delivery and gets a new generation');
select is(
  (select attempt_count from public.notification_outbox where id = 'da000000-0000-0000-0000-000000000001'),
  0,
  'and the attempt budget is still rewound');

set local role authenticated;
set local "request.jwt.claim.sub" = 'd1000000-0000-0000-0000-000000000001';
select lives_ok(
  $$select public.admin_reissue_gift('d9000000-0000-0000-0000-000000000001', 'S9-Prfix-Other@Example.Test',
                                     encode(extensions.digest(convert_to('s9-prfix-token-2', 'UTF8'), 'sha256'), 'hex'),
                                     '/vi/gifts/claim/s9-prfix-new', 'wrong address')$$,
  'an admin reissues the gift to another address');
reset role;

select is(
  (select delivery_generation from public.notification_outbox where id = 'da000000-0000-0000-0000-000000000001'),
  2,
  'a reissue changes the payload, so it must change the key too');


-- ==========================================================================================
-- Finding 3: one membership snapshot per order (18-20)
--
-- create_bundle_order reads bundle membership through bundle_order_lines once per statement - to
-- count members, to check every member has a sku, to check ownership, and finally to write
-- order_items. Under READ COMMITTED each of those statements takes a fresh snapshot, so an admin
-- replacing the membership between two of them left the order validated against one set of books
-- and written from another. The fix is a FOR UPDATE on the bundle row taken before the first of
-- those reads and held to commit; admin_set_bundle_members takes the same row lock.
--
-- The interleaving is staged rather than hoped for: the admin session opens a transaction, takes
-- the lock by replacing the membership, and is held open. The buyer's create_bundle_order is sent
-- asynchronously and asserted to be BLOCKED - which is the property under test, because before the
-- fix it would have run straight past into a half-changed bundle. Only then does the admin commit,
-- and the order that comes out is read back.
--
-- The fixtures are committed from a third connection, because the other two have to see them, and
-- deleted again at the end. See 048 for the same harness and the reasons behind each piece of it.
-- ==========================================================================================
create extension if not exists dblink with schema extensions;

create function pg_temp.await_idle(p_conn text) returns void language plpgsql as $fn$
begin
  for i in 1..400 loop
    exit when extensions.dblink_is_busy(p_conn) = 0;
    perform pg_sleep(0.05);
  end loop;
end;
$fn$;

-- The async result has to be read back as a value rather than raised: it arrives in the middle of
-- this transaction, and dblink re-raises the remote SQLSTATE.
create function pg_temp.result_text(p_conn text) returns text language plpgsql as $fn$
declare
  v_value text;
begin
  select t.v into v_value from extensions.dblink_get_result(p_conn) as t(v text);
  -- One result per call, finished only when a call comes back empty. Leaving that terminator
  -- unread would leave the connection mid-command.
  perform 1 from extensions.dblink_get_result(p_conn) as t(v text);
  return 'ok:' || coalesce(v_value, 'null');
exception when others then
  begin
    perform 1 from extensions.dblink_get_result(p_conn) as t(v text);
  exception when others then
    null;
  end;
  return sqlstate;
end;
$fn$;

-- Catalog writes are audited and audit_logs refuses every delete, so a row committed here would
-- outlive this file and fail the table counts in 002 on the next run. Suppressed for the one
-- statement and restored immediately.
create function pg_temp.uncatalogued(p_conn text, p_sql text) returns void language plpgsql as $fn$
begin
  perform extensions.dblink_exec(p_conn, 'set session_replication_role = replica');
  begin
    perform extensions.dblink_exec(p_conn, p_sql);
  exception when others then
    perform extensions.dblink_exec(p_conn, 'set session_replication_role = origin');
    raise;
  end;
  perform extensions.dblink_exec(p_conn, 'set session_replication_role = origin');
end;
$fn$;

select extensions.dblink_connect('mem_setup', 'host=db port=5432 dbname=postgres user=postgres password=postgres');
select extensions.dblink_connect('mem_admin', 'host=db port=5432 dbname=postgres user=postgres password=postgres');
select extensions.dblink_connect('mem_buyer', 'host=db port=5432 dbname=postgres user=postgres password=postgres');

-- A run that failed before its cleanup leaves these behind, and a duplicate key would then hide
-- whatever actually broke.
select extensions.dblink_exec('mem_setup', $stmt$delete from public.order_items where order_id in (select id from public.orders where bundle_id = 'db700000-0000-0000-0000-000000000001')$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.payments where order_id in (select id from public.orders where bundle_id = 'db700000-0000-0000-0000-000000000001')$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.orders where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.offers where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.bundle_editions where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.bundle_editions where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.bundle_localizations where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.bundles where id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.skus where sku_code like 'S9-MEM-SKU-%'$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$update public.editions set active_publication_id = null where book_id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.ebook_publications where ebook_asset_id in (select id from public.ebook_assets where source_storage_key like 'fx-mem/%')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.ebook_assets where source_storage_key like 'fx-mem/%'$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.editions where book_id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.book_localizations where book_id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.books where id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.authors where id = 'db300000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.audit_logs where entity_type = 'bundles' and entity_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.user_roles where profile_id in (select id from public.profiles where auth_user_id in ('db100000-0000-0000-0000-000000000001', 'db100000-0000-0000-0000-000000000002'))$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from auth.users where id in ('db100000-0000-0000-0000-000000000001', 'db100000-0000-0000-0000-000000000002')$stmt$);

select extensions.dblink_exec('mem_setup', $stmt$
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', 'db100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-mem-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', 'db100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-mem-buyer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$
  insert into public.user_roles (profile_id, role)
  select id, 'admin' from public.profiles where auth_user_id = 'db100000-0000-0000-0000-000000000001'
$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$
  insert into public.authors (id, canonical_slug, display_name, status)
  values ('db300000-0000-0000-0000-000000000001', 's9-mem-author', 'S9 Mem Author', 'published')
$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$
  insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
    ('db200000-0000-0000-0000-000000000001', 's9-mem-book-1', 'vi', 'db300000-0000-0000-0000-000000000001', 'published'),
    ('db200000-0000-0000-0000-000000000002', 's9-mem-book-2', 'vi', 'db300000-0000-0000-0000-000000000001', 'published'),
    ('db200000-0000-0000-0000-000000000003', 's9-mem-book-3', 'vi', 'db300000-0000-0000-0000-000000000001', 'published')
$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$
  insert into public.book_localizations (book_id, locale, slug, title) values
    ('db200000-0000-0000-0000-000000000001', 'vi', 's9-mem-sach-mot', 'Sach mot'),
    ('db200000-0000-0000-0000-000000000002', 'vi', 's9-mem-sach-hai', 'Sach hai'),
    ('db200000-0000-0000-0000-000000000003', 'vi', 's9-mem-sach-ba', 'Sach ba')
$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$
  insert into public.editions (book_id, language_code) values
    ('db200000-0000-0000-0000-000000000001', 'vi'),
    ('db200000-0000-0000-0000-000000000002', 'vi'),
    ('db200000-0000-0000-0000-000000000003', 'vi')
$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$
  insert into public.skus (edition_id, sku_code)
  select e.id, 'S9-MEM-SKU-' || e.book_id
  from public.editions e
  where e.book_id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')
$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$
  insert into public.ebook_assets (edition_id, source_storage_key, version, status)
  select e.id, 'fx-mem/' || e.id || '.epub', 1, 'published'
  from public.editions e where e.book_id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')
$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$
  insert into public.ebook_publications (ebook_asset_id, version, manifest_key, status, epub_language)
  select a.id, 1, 'fx-mem/' || a.id || '.json', 'published', 'vi' from public.ebook_assets a where a.source_storage_key like 'fx-mem/%'
$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$
  update public.editions e set status = 'published', active_publication_id = p.id
  from public.ebook_publications p join public.ebook_assets a on a.id = p.ebook_asset_id
  where a.edition_id = e.id and a.source_storage_key like 'fx-mem/%'
$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$
  insert into public.bundles (id, status) values ('db700000-0000-0000-0000-000000000001', 'published')
$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$
  insert into public.bundle_localizations (bundle_id, locale, slug, title, description)
  values ('db700000-0000-0000-0000-000000000001', 'vi', 's9-mem-bo', 'Bo ghep', 'Mo ta')
$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$
  insert into public.bundle_editions (bundle_id, edition_id, position)
  select 'db700000-0000-0000-0000-000000000001', e.id, row_number() over (order by e.book_id)
  from public.editions e where e.book_id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002')
$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$
  insert into public.offers (bundle_id, market_code, currency, price_minor, active)
  values ('db700000-0000-0000-0000-000000000001', 'VN', 'VND', 250000, true)
$stmt$);

-- The admin holds the bundle row and has already replaced its membership.
select extensions.dblink_exec('mem_admin', 'begin');
select extensions.dblink_exec('mem_admin', 'set local role authenticated');
select extensions.dblink_exec('mem_admin', 'set local "request.jwt.claim.sub" = ''db100000-0000-0000-0000-000000000001''');
-- dblink() rather than dblink_exec(), which refuses a statement that returns rows - and an RPC
-- returning void still returns one.
select * from extensions.dblink('mem_admin', $stmt$select public.admin_set_bundle_members('db700000-0000-0000-0000-000000000001', array(select e.id from public.editions e where e.book_id in ('db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003') order by e.book_id))$stmt$) as t(v text);

-- The buyer arrives mid-change.
select extensions.dblink_exec('mem_buyer', 'begin');
select extensions.dblink_exec('mem_buyer', 'set local role authenticated');
select extensions.dblink_exec('mem_buyer', 'set local "request.jwt.claim.sub" = ''db100000-0000-0000-0000-000000000002''');
select extensions.dblink_send_query('mem_buyer', 'select public.create_bundle_order(''db700000-0000-0000-0000-000000000001'')::text');
select pg_sleep(1);
select is(extensions.dblink_is_busy('mem_buyer'), 1,
  'the order waits on the bundle row lock instead of reading a half-changed membership');

select extensions.dblink_exec('mem_admin', 'commit');
select pg_temp.await_idle('mem_buyer');
select matches(pg_temp.result_text('mem_buyer'), '^ok:[0-9a-f-]{36}$',
  'the order is created once the membership change has committed');
select extensions.dblink_exec('mem_buyer', 'commit');

select is(
  (select string_agg(i.book_id::text, ',' order by i.position)
   from public.order_items i
   join public.orders o on o.id = i.order_id
   where o.bundle_id = 'db700000-0000-0000-0000-000000000001'),
  'db200000-0000-0000-0000-000000000002,db200000-0000-0000-0000-000000000003',
  'and it holds exactly the membership that was committed, never a mix of the two');

-- Committed fixtures are committed: this transaction's rollback will not take them with it.
select extensions.dblink_exec('mem_setup', $stmt$delete from public.order_items where order_id in (select id from public.orders where bundle_id = 'db700000-0000-0000-0000-000000000001')$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.payments where order_id in (select id from public.orders where bundle_id = 'db700000-0000-0000-0000-000000000001')$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.orders where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.offers where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.bundle_editions where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.bundle_editions where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.bundle_localizations where bundle_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.bundles where id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.skus where sku_code like 'S9-MEM-SKU-%'$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$update public.editions set active_publication_id = null where book_id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.ebook_publications where ebook_asset_id in (select id from public.ebook_assets where source_storage_key like 'fx-mem/%')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.ebook_assets where source_storage_key like 'fx-mem/%'$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.editions where book_id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.book_localizations where book_id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.books where id in ('db200000-0000-0000-0000-000000000001', 'db200000-0000-0000-0000-000000000002', 'db200000-0000-0000-0000-000000000003')$stmt$);
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.authors where id = 'db300000-0000-0000-0000-000000000001'$stmt$);
-- The membership change this race staged was a real admin action, so it wrote a real audit row -
-- and that row references the admin profile, which is why deleting the user below fails while it
-- stands. audit_logs refuses every delete by design; uncatalogued() suspends that for the one
-- statement, exactly as it does for the catalog triggers. Leaving the row behind would fail the
-- audit-log assertions in 002 on the NEXT run against this database.
select pg_temp.uncatalogued('mem_setup', $stmt$delete from public.audit_logs where entity_type = 'bundles' and entity_id = 'db700000-0000-0000-0000-000000000001'$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from public.user_roles where profile_id in (select id from public.profiles where auth_user_id in ('db100000-0000-0000-0000-000000000001', 'db100000-0000-0000-0000-000000000002'))$stmt$);
select extensions.dblink_exec('mem_setup', $stmt$delete from auth.users where id in ('db100000-0000-0000-0000-000000000001', 'db100000-0000-0000-0000-000000000002')$stmt$);

select extensions.dblink_disconnect('mem_setup');
select extensions.dblink_disconnect('mem_admin');
select extensions.dblink_disconnect('mem_buyer');

select finish();
rollback;
