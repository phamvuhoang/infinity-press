begin;
select plan(8);

-- The work-level order entry point was removed by the contract migration. This fixture stands in for
-- it (one edition on sale -> that edition's best payable offer) so these older tests keep exercising
-- the order machinery through create_edition_order.
create function public.create_ebook_order(p_book_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $f$
declare v_edition_ids uuid[]; v_offer_id uuid;
begin
  select array_agg(distinct s.edition_id) into v_edition_ids
  from public.offers o join public.skus s on s.id = o.sku_id and s.active
  join public.editions ed on ed.id = s.edition_id
  where ed.book_id = p_book_id and ed.status = 'published' and ed.active_publication_id is not null
    and o.active and public.offer_effective_price_minor(o) > 0
    and (o.starts_at is null or o.starts_at <= now()) and (o.ends_at is null or o.ends_at > now());
  if coalesce(cardinality(v_edition_ids), 0) = 0 then
    raise exception 'create_ebook_order: book % is not purchasable', p_book_id using errcode = 'EB012';
  end if;
  if cardinality(v_edition_ids) > 1 then
    raise exception 'create_ebook_order: book % has several editions on sale; name one', p_book_id using errcode = 'EB042';
  end if;
  select o.id into v_offer_id from public.offers o join public.skus s on s.id = o.sku_id and s.active
  where s.edition_id = v_edition_ids[1] and o.active and public.offer_effective_price_minor(o) > 0
    and (o.starts_at is null or o.starts_at <= now()) and (o.ends_at is null or o.ends_at > now())
  order by public.currency_is_payable(o.currency) desc, public.offer_effective_price_minor(o), o.currency limit 1;
  return public.create_edition_order(v_edition_ids[1], v_offer_id, null);
end $f$;
revoke all on function public.create_ebook_order(uuid) from public, anon;
grant execute on function public.create_ebook_order(uuid) to authenticated;

-- S7 PR fix C1: apply_payment_event refuses an event whose provider disagrees with the order's own
-- payment_provider (EB016).
--
-- The function resolves its payments row by (order_id, provider) and CREATES one when none exists.
-- That branch exists for a provider that delivers an event before the order's own row is written,
-- and it is also how a simulator event against a manual order produced a SECOND payments row and an
-- entitlement whose source_type said simulated_payment while the order said manual. An event for a
-- provider the order was never booked under is not a payment for that order, so it is refused
-- before anything is written.
--
-- Both orders here come from create_ebook_order rather than a hand-written insert: the shape this
-- test is about is the agreement between orders.payment_provider and payments.provider, and only
-- the real RPC produces it.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-eventprovider-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_orders (label text primary key, order_id uuid not null);
grant select, insert on t_orders to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('d3000000-0000-0000-0000-000000000001', 's7-eventprovider-author', 'S7 Event Provider Author', 'published');

-- Two books, so the manual order and the simulator order can exist at the same time: a second
-- create_ebook_order for the SAME book under a different provider cancels and replaces the first.
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
select ('d2000000-0000-0000-0000-00000000000' || n)::uuid, 's7-eventprovider-book-' || n, 'vi',
       'd3000000-0000-0000-0000-000000000001', 'published'
from generate_series(1, 2) as n;

insert into public.book_localizations (book_id, locale, slug, title)
select ('d2000000-0000-0000-0000-00000000000' || n)::uuid, 'vi', 's7-sach-eventprovider-' || n, 'Sách event provider ' || n
from generate_series(1, 2) as n;

insert into public.editions (id, book_id, language_code)
select ('d4000000-0000-0000-0000-00000000000' || n)::uuid, ('d2000000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 2) as n;

insert into public.skus (id, edition_id, sku_code)
select ('d5000000-0000-0000-0000-00000000000' || n)::uuid, ('d4000000-0000-0000-0000-00000000000' || n)::uuid, 's7-eventprovider-sku-' || n
from generate_series(1, 2) as n;

insert into public.offers (sku_id, market_code, currency, price_minor)
select ('d5000000-0000-0000-0000-00000000000' || n)::uuid, 'VN', 'VND', 129000
from generate_series(1, 2) as n;

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
select ('d6000000-0000-0000-0000-00000000000' || n)::uuid, ('d4000000-0000-0000-0000-00000000000' || n)::uuid,
       's7-eventprovider/' || n || '.epub', 1, 'published'
from generate_series(1, 2) as n;

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
select ('d7000000-0000-0000-0000-00000000000' || n)::uuid, ('d6000000-0000-0000-0000-00000000000' || n)::uuid, 1,
       's7-eventprovider/' || n || '/manifest.json', 'published'
from generate_series(1, 2) as n;

update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = ('d7000000-0000-0000-0000-00000000000' || right(b.canonical_key, 1))::uuid and (b.canonical_key in ('s7-eventprovider-book-1', 's7-eventprovider-book-2'));

update public.commerce_settings set payments_enabled = true, payment_provider = 'manual';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('manual', public.create_ebook_order('d2000000-0000-0000-0000-000000000001'));
reset role;

update public.commerce_settings set payment_provider = 'simulator';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('simulator', public.create_ebook_order('d2000000-0000-0000-0000-000000000002'));
reset role;

-- The backstop itself (1)
select throws_ok(
  $$ select public.apply_payment_event('simulator', 'sim-evt-against-manual',
       (select order_id from t_orders where label = 'manual'), 'ext-sim-1', 'succeeded', 129000, 'VND', now()) $$,
  'EB016',
  null,
  'a simulator event against an order booked as manual is refused');

-- And it refuses before writing anything: no second payments row, no event row, no entitlement
-- (2-5)
select is(
  (select count(*) from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'manual')),
  1::bigint,
  'the refused event created no second payments row');
select is(
  (select pay.provider from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'manual')),
  'manual',
  'the order still has exactly the manual payments row create_ebook_order booked');
select is(
  (select count(*) from public.payment_events pe where pe.provider_event_id = 'sim-evt-against-manual'),
  0::bigint,
  'the refused event was not recorded');
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = (select order_id from t_orders where label = 'manual')),
  0::bigint,
  'the refused event granted nothing');

-- The provider the order WAS booked under still works, so the backstop costs the manual path
-- nothing (6)
-- The call and the assertion are separate statements, for the reason 029 gives at length: a query
-- that both invokes the RPC and reads the rows it is about to write can plan the read against a
-- snapshot that predates them.
create temporary table t_manual_ok as
select * from public.apply_payment_event('manual', 'manual-evt-ok',
  (select order_id from t_orders where label = 'manual'), 'VCB-TXN-OK', 'succeeded', 129000, 'VND', now());

select is(
  (select e.source_type::text from public.entitlements e
   where e.id in (select unnest(entitlement_ids) from t_manual_ok)),
  'manual_payment',
  'the manual event the order was booked for still grants a manual_payment entitlement');

-- The other direction, and the case every order predating orders.payment_provider falls into:
-- a simulator order takes a simulator event exactly as before (7)
select is(
  (select r.order_status::text
   from public.apply_payment_event('simulator', 'sim-evt-ok',
     (select order_id from t_orders where label = 'simulator'), 'ext-sim-ok', 'succeeded', 129000, 'VND', now()) r),
  'completed',
  'a simulator order still accepts its own simulator event');

-- EB015 is resolved before any row is read, so an unknown provider is still refused as unknown
-- rather than as a mismatch (8)
select throws_ok(
  $$ select public.apply_payment_event('bank_of_nowhere', 'evt-unknown',
       (select order_id from t_orders where label = 'manual'), 'ext-x', 'succeeded', 129000, 'VND', now()) $$,
  'EB015',
  null,
  'an unknown provider is still refused as unknown, not as a provider mismatch');

select * from finish();
rollback;
