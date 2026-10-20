begin;
select plan(31);

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

-- S19: a book sale price. offer_effective_price_minor is the one function that knows the sale
-- arithmetic; every order here comes from create_ebook_order, because what is under test is that
-- the order path, coupons, and the catalog read all agree with it.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'a1900000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's19-buyer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_orders (label text primary key, order_id uuid not null);
grant select, insert on t_orders to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('a1930000-0000-0000-0000-000000000001', 's19-author', 'S19 Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status)
select ('a1920000-0000-0000-0000-00000000000' || n)::uuid, 's19-book-' || n, 'vi',
       'a1930000-0000-0000-0000-000000000001', 'published'
from generate_series(1, 5) as n;

insert into public.book_localizations (book_id, locale, slug, title)
select ('a1920000-0000-0000-0000-00000000000' || n)::uuid, 'vi', 's19-sach-' || n, 'Sách S19 ' || n
from generate_series(1, 5) as n;

insert into public.editions (id, book_id, language_code)
select ('a1940000-0000-0000-0000-00000000000' || n)::uuid, ('a1920000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 5) as n;

insert into public.skus (id, edition_id, sku_code)
select ('a1950000-0000-0000-0000-00000000000' || n)::uuid, ('a1940000-0000-0000-0000-00000000000' || n)::uuid, 's19-sku-' || n
from generate_series(1, 5) as n;

insert into public.offers (id, sku_id, market_code, currency, price_minor)
select ('a1980000-0000-0000-0000-00000000000' || n)::uuid, ('a1950000-0000-0000-0000-00000000000' || n)::uuid,
       'VN', 'VND', 129000
from generate_series(1, 5) as n;

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
select ('a1960000-0000-0000-0000-00000000000' || n)::uuid, ('a1940000-0000-0000-0000-00000000000' || n)::uuid,
       's19/' || n || '.epub', 1, 'published'
from generate_series(1, 5) as n;

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
select ('a1970000-0000-0000-0000-00000000000' || n)::uuid, ('a1960000-0000-0000-0000-00000000000' || n)::uuid, 1,
       's19/' || n || '/manifest.json', 'published'
from generate_series(1, 5) as n;

update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = ('a1970000-0000-0000-0000-00000000000' || right(b.canonical_key, 1))::uuid and (b.canonical_key like 's19-book-%');

insert into public.bundles (id, status) values ('a1990000-0000-0000-0000-000000000001', 'draft');
insert into public.offers (id, bundle_id, market_code, currency, price_minor)
values ('a1980000-0000-0000-0000-000000000009', 'a1990000-0000-0000-0000-000000000001', 'VN', 'VND', 199000);

insert into public.coupons (id, code, kind, percent_off, amount_off_minor, currency, active, max_redemptions_per_profile) values
  ('a19c0000-0000-0000-0000-000000000001', 'S19-TWENTY', 'percent', 20, null, null, true, 5),
  ('a19c0000-0000-0000-0000-000000000002', 'S19-FIXED', 'fixed', null, 100000, 'VND', true, 5);

update public.commerce_settings set payments_enabled = true, payment_provider = 'simulator';

create function pg_temp.price(p_offer uuid) returns bigint language sql as $$
  select public.offer_effective_price_minor(o) from public.offers o where o.id = p_offer
$$;

-- Effective price: no sale, percent, fixed, scheduled, ended, and both window edges (1-7)
select is(pg_temp.price('a1980000-0000-0000-0000-000000000001'), 129000::bigint, 'no sale is the list price');
update public.offers set sale_kind = 'percent', sale_percent_off = 30 where id = 'a1980000-0000-0000-0000-000000000001';
select is(pg_temp.price('a1980000-0000-0000-0000-000000000001'), 90300::bigint, '30% off 129000 is 90300');
update public.offers set sale_kind = 'percent', sale_percent_off = 33 where id = 'a1980000-0000-0000-0000-000000000001';
select is(pg_temp.price('a1980000-0000-0000-0000-000000000001'), 86430::bigint, 'a percent discount is floored: 33% of 129000 is 42570 off');
update public.offers set sale_kind = 'fixed', sale_percent_off = null, sale_amount_off_minor = 40000 where id = 'a1980000-0000-0000-0000-000000000001';
select is(pg_temp.price('a1980000-0000-0000-0000-000000000001'), 89000::bigint, '40000 off 129000 is 89000');
update public.offers set sale_starts_at = now() + interval '1 hour' where id = 'a1980000-0000-0000-0000-000000000001';
select is(pg_temp.price('a1980000-0000-0000-0000-000000000001'), 129000::bigint, 'a scheduled sale has not started');
update public.offers set sale_starts_at = now(), sale_ends_at = null where id = 'a1980000-0000-0000-0000-000000000001';
select is(pg_temp.price('a1980000-0000-0000-0000-000000000001'), 89000::bigint, 'a sale runs from the instant it starts');
update public.offers set sale_starts_at = null, sale_ends_at = now() where id = 'a1980000-0000-0000-0000-000000000001';
select is(pg_temp.price('a1980000-0000-0000-0000-000000000001'), 129000::bigint, 'a sale is over at the instant it ends');

-- Every shape a sale must not take is refused by the database (8-16)
select throws_ok($$update public.offers set sale_kind = 'fixed', sale_amount_off_minor = 129000, sale_ends_at = null where id = 'a1980000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a fixed sale cannot reach the list price');
select throws_ok($$update public.offers set sale_kind = 'percent', sale_percent_off = 100, sale_amount_off_minor = null, sale_ends_at = null where id = 'a1980000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a percent sale cannot be 100%');
select throws_ok($$update public.offers set sale_kind = 'percent', sale_percent_off = null, sale_amount_off_minor = null, sale_ends_at = null where id = 'a1980000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a sale kind needs its value');
select throws_ok($$update public.offers set sale_kind = null, sale_percent_off = null, sale_amount_off_minor = null, sale_ends_at = now() + interval '1 day' where id = 'a1980000-0000-0000-0000-000000000001'$$,
  '23514', null, 'no sale means no sale window');
select throws_ok($$update public.offers set sale_kind = null, sale_percent_off = 30, sale_amount_off_minor = null, sale_starts_at = null, sale_ends_at = null where id = 'a1980000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a percentage needs a sale kind');
select throws_ok($$update public.offers set sale_kind = null, sale_percent_off = null, sale_amount_off_minor = 40000, sale_starts_at = null, sale_ends_at = null where id = 'a1980000-0000-0000-0000-000000000001'$$,
  '23514', null, 'an amount off needs a sale kind');
select throws_ok($$update public.offers set sale_starts_at = now() + interval '2 days', sale_ends_at = now() + interval '1 day' where id = 'a1980000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a sale window cannot end before it starts');
select throws_ok($$update public.offers set price_minor = 30000 where id = 'a1980000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a list-price cut cannot undercut a running fixed sale');
select throws_ok($$update public.offers set sale_kind = 'percent', sale_percent_off = 10 where id = 'a1980000-0000-0000-0000-000000000009'$$,
  '23514', null, 'a bundle offer cannot carry a sale');

-- The catalog read carries the effective price and the list price only while a sale runs (17-20)
update public.offers set sale_kind = 'percent', sale_percent_off = 30, sale_amount_off_minor = null,
  sale_starts_at = null, sale_ends_at = now() + interval '7 days'
where id = 'a1980000-0000-0000-0000-000000000001';
select is((select c.price_minor from public.catalog_book_cards('vi') c where c.book_id = 'a1920000-0000-0000-0000-000000000001'),
  90300::bigint, 'a card prices the book at the sale price');
select is((select c.list_price_minor from public.catalog_book_cards('vi') c where c.book_id = 'a1920000-0000-0000-0000-000000000001'),
  129000::bigint, 'a card carries the list price during a sale');
select is((select c.sale_ends_at from public.catalog_book_cards('vi') c where c.book_id = 'a1920000-0000-0000-0000-000000000001'),
  now() + interval '7 days', 'a card carries the sale end');
select is((select c.list_price_minor from public.catalog_book_card_by_id('vi', 'a1920000-0000-0000-0000-000000000002') c),
  null::bigint, 'a book with no sale has no list price on its card');

-- An order snapshots the sale price everywhere it stores an amount (21-23)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1900000-0000-0000-0000-000000000001', true);
insert into t_orders values ('sale', public.create_ebook_order('a1920000-0000-0000-0000-000000000001'));
reset role;
select is((select o.subtotal_minor + o.total_minor from public.orders o where o.id = (select order_id from t_orders where label = 'sale')),
  180600::bigint, 'the order subtotal and total are both the sale price');
select is((select oi.unit_price_minor from public.order_items oi where oi.order_id = (select order_id from t_orders where label = 'sale')),
  90300::bigint, 'the order item is the sale price');
select is((select pay.amount_minor from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'sale')),
  90300::bigint, 'the payment is the sale price');

-- A coupon discounts the sale price, not the list price (24)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1900000-0000-0000-0000-000000000001', true);
select is((select r.total_minor from public.apply_coupon_to_order((select order_id from t_orders where label = 'sale'), 'S19-TWENTY') r),
  72240::bigint, '20% off a 90300 sale price leaves 72240');

-- A pending order booked at the list price is replaced at the sale price once the sale starts (25-26)
insert into t_orders values ('before', public.create_ebook_order('a1920000-0000-0000-0000-000000000002'));
reset role;
update public.offers set sale_kind = 'fixed', sale_amount_off_minor = 40000 where id = 'a1980000-0000-0000-0000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1900000-0000-0000-0000-000000000001', true);
insert into t_orders values ('after', public.create_ebook_order('a1920000-0000-0000-0000-000000000002'));
reset role;
select is((select o.status::text from public.orders o where o.id = (select order_id from t_orders where label = 'before')),
  'cancelled', 'the list-price order is cancelled when the sale starts');
select is((select o.total_minor from public.orders o where o.id = (select order_id from t_orders where label = 'after')),
  89000::bigint, 'the replacement order is at the sale price');

-- A fixed coupon covering the sale price completes the order as a free order (27)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1900000-0000-0000-0000-000000000001', true);
select public.apply_coupon_to_order((select order_id from t_orders where label = 'after'), 'S19-FIXED');
reset role;
select is((select o.status::text from public.orders o where o.id = (select order_id from t_orders where label = 'after')),
  'completed', 'a 100000 coupon on an 89000 sale price completes the order');

-- Spec 9.1: under manual transfer, a reported transfer keeps its price across a price change while
-- an unreported order is still replaced (28-31)
update public.commerce_settings set payment_provider = 'manual';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1900000-0000-0000-0000-000000000001', true);
insert into t_orders values ('claimed', public.create_ebook_order('a1920000-0000-0000-0000-000000000003'));
insert into t_orders values ('unclaimed', public.create_ebook_order('a1920000-0000-0000-0000-000000000004'));
select public.claim_manual_transfer((select order_id from t_orders where label = 'claimed'), 'chuyen luc 10h');
reset role;
update public.offers set sale_kind = 'percent', sale_percent_off = 30
where id in ('a1980000-0000-0000-0000-000000000003', 'a1980000-0000-0000-0000-000000000004');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1900000-0000-0000-0000-000000000001', true);
insert into t_orders values ('claimed-again', public.create_ebook_order('a1920000-0000-0000-0000-000000000003'));
insert into t_orders values ('unclaimed-again', public.create_ebook_order('a1920000-0000-0000-0000-000000000004'));
reset role;
select is((select order_id from t_orders where label = 'claimed-again'), (select order_id from t_orders where label = 'claimed'),
  'Buy returns the order whose transfer was reported');
select is((select o.total_minor from public.orders o where o.id = (select order_id from t_orders where label = 'claimed')),
  129000::bigint, 'the reported order keeps the price the reader transferred');
select isnt((select order_id from t_orders where label = 'unclaimed-again'), (select order_id from t_orders where label = 'unclaimed'),
  'an unreported order is still replaced');
select is((select o.total_minor from public.orders o where o.id = (select order_id from t_orders where label = 'unclaimed-again')),
  90300::bigint, 'the replacement is at the sale price');

select * from finish();
rollback;
