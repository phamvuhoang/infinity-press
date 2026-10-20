begin;
select plan(38);

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

-- S9: create_bundle_order and the public read policy for a published bundle's offer
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 5 and 6.3).
--
-- Four readers, because every rule this function has is about WHO is buying: A buys and re-buys,
-- B already owns every member book, C has no verified email, and D owns one member book of two and
-- must still be allowed to buy the bundle at its full price.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-bundle-order-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-bundle-order-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's9-bundle-order-c@example.test', '', null, '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 's9-bundle-order-d@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role: profiles RLS would hide other readers' rows after a role switch.
create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001') as a_id,
  (select id from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000002') as b_id,
  (select id from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000004') as d_id;
grant select on t_ids to public;

create temporary table t_orders (label text primary key, order_id uuid not null);
grant select, insert on t_orders to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('c3000000-0000-0000-0000-000000000001', 's9-bundle-order-author', 'S9 Bundle Order Author', 'published');

-- Books 1-3 are published members; book 4 is a draft that sits inside a published bundle, which is
-- the drift the bundle page and this function both have to survive (readiness is a publish-time
-- gate, not an invariant).
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('c2000000-0000-0000-0000-000000000001', 's9-bo-book-1', 'vi', 'c3000000-0000-0000-0000-000000000001', 'published'),
  ('c2000000-0000-0000-0000-000000000002', 's9-bo-book-2', 'vi', 'c3000000-0000-0000-0000-000000000001', 'published'),
  ('c2000000-0000-0000-0000-000000000003', 's9-bo-book-3', 'vi', 'c3000000-0000-0000-0000-000000000001', 'published'),
  ('c2000000-0000-0000-0000-000000000004', 's9-bo-book-4', 'vi', 'c3000000-0000-0000-0000-000000000001', 'draft'),
  -- Not a member of any bundle. It exists so the provider assertions below can compare a bundle
  -- order with a single-book order made from the same commerce_settings row, without
  -- create_ebook_order's own staleness pass reaching a pending bundle order that shares a book.
  ('c2000000-0000-0000-0000-000000000005', 's9-bo-book-5', 'vi', 'c3000000-0000-0000-0000-000000000001', 'published');

insert into public.book_localizations (book_id, locale, slug, title) values
  ('c2000000-0000-0000-0000-000000000001', 'en', 's9-bo-book-one', 'S9 Book One'),
  ('c2000000-0000-0000-0000-000000000001', 'vi', 's9-bo-sach-mot', 'Sách một S9'),
  ('c2000000-0000-0000-0000-000000000002', 'vi', 's9-bo-sach-hai', 'Sách hai S9'),
  ('c2000000-0000-0000-0000-000000000003', 'vi', 's9-bo-sach-ba', 'Sách ba S9'),
  ('c2000000-0000-0000-0000-000000000004', 'vi', 's9-bo-sach-bon', 'Sách bốn S9'),
  ('c2000000-0000-0000-0000-000000000005', 'vi', 's9-bo-sach-nam', 'Sách năm S9');

insert into public.editions (id, book_id, language_code)
select ('c4000000-0000-0000-0000-00000000000' || n)::uuid, ('c2000000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 5) as n;

insert into public.skus (id, edition_id, sku_code)
select ('c5000000-0000-0000-0000-00000000000' || n)::uuid, ('c4000000-0000-0000-0000-00000000000' || n)::uuid, 'S9-BO-SKU-' || n
from generate_series(1, 5) as n;


-- Book 5's own publication and paid offer: everything create_ebook_order needs.
insert into public.offers (id, sku_id, market_code, currency, price_minor)
values ('c6000000-0000-0000-0000-000000000009', 'c5000000-0000-0000-0000-000000000005', 'VN', 'VND', 99000);

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('c8000000-0000-0000-0000-000000000005', 'c4000000-0000-0000-0000-000000000005', 's9-bo/5.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('c9000000-0000-0000-0000-000000000005', 'c8000000-0000-0000-0000-000000000005', 1, 's9-bo/5/manifest.json', 'published');
update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'c9000000-0000-0000-0000-000000000005' and (b.id = 'c2000000-0000-0000-0000-000000000005');

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


-- Bundles: 1 sells, 2 is a draft, 3 has only an inactive offer, 4 has no published member, 5 is
-- the price-change bundle and is localized in English only.
insert into public.bundles (id, status) values
  ('c7000000-0000-0000-0000-000000000001', 'published'),
  ('c7000000-0000-0000-0000-000000000002', 'draft'),
  ('c7000000-0000-0000-0000-000000000003', 'published'),
  ('c7000000-0000-0000-0000-000000000004', 'published'),
  ('c7000000-0000-0000-0000-000000000005', 'published');

insert into public.bundle_localizations (bundle_id, locale, slug, title) values
  ('c7000000-0000-0000-0000-000000000001', 'en', 's9-bo-starter-bundle', 'S9 Starter Bundle'),
  ('c7000000-0000-0000-0000-000000000001', 'vi', 's9-bo-goi-khoi-dau', 'Gói khởi đầu S9'),
  ('c7000000-0000-0000-0000-000000000002', 'vi', 's9-bo-goi-nhap', 'Gói nháp S9'),
  ('c7000000-0000-0000-0000-000000000003', 'vi', 's9-bo-goi-khong-gia', 'Gói không giá S9'),
  ('c7000000-0000-0000-0000-000000000004', 'vi', 's9-bo-goi-rong', 'Gói rỗng S9'),
  ('c7000000-0000-0000-0000-000000000005', 'en', 's9-bo-english-bundle', 'S9 English Bundle');

insert into public.bundle_editions (bundle_id, edition_id, position) values
  ('c7000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000001', 1),
  ('c7000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000002', 2),
  ('c7000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000004', 3),
  ('c7000000-0000-0000-0000-000000000002', 'c4000000-0000-0000-0000-000000000001', 1),
  ('c7000000-0000-0000-0000-000000000003', 'c4000000-0000-0000-0000-000000000001', 1),
  ('c7000000-0000-0000-0000-000000000004', 'c4000000-0000-0000-0000-000000000004', 1),
  ('c7000000-0000-0000-0000-000000000005', 'c4000000-0000-0000-0000-000000000003', 1);

insert into public.offers (id, bundle_id, market_code, currency, price_minor, active) values
  ('c6000000-0000-0000-0000-000000000001', 'c7000000-0000-0000-0000-000000000001', 'VN', 'VND', 199000, true),
  ('c6000000-0000-0000-0000-000000000002', 'c7000000-0000-0000-0000-000000000002', 'VN', 'VND', 199000, true),
  ('c6000000-0000-0000-0000-000000000003', 'c7000000-0000-0000-0000-000000000003', 'VN', 'VND', 199000, false),
  ('c6000000-0000-0000-0000-000000000004', 'c7000000-0000-0000-0000-000000000004', 'VN', 'VND', 199000, true),
  ('c6000000-0000-0000-0000-000000000005', 'c7000000-0000-0000-0000-000000000005', 'VN', 'VND', 259000, true);

-- B owns both published members of bundle 1; D owns the first one only.
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select b_id, book_id, 'admin_grant', b_id, 's9 bundle order fixture', 'active'
from t_ids, (values ('c2000000-0000-0000-0000-000000000001'::uuid), ('c2000000-0000-0000-0000-000000000002'::uuid)) as v(book_id);

insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select d_id, 'c2000000-0000-0000-0000-000000000001', 'admin_grant', d_id, 's9 bundle order fixture', 'active' from t_ids;

update public.commerce_settings set payments_enabled = true, payment_provider = 'simulator';

-- Privileges (1-2)
select is(has_function_privilege('anon', 'public.create_bundle_order(uuid)', 'execute'), false, 'anon cannot create a bundle order');
select is(has_function_privilege('authenticated', 'public.create_bundle_order(uuid)', 'execute'), true, 'a signed-in reader can create a bundle order');

-- The bundle-offer read policy (3-7). Before it existed, the S3 offers policy's `exists (… where
-- s.id = offers.sku_id …)` was FALSE for every bundle offer, so the price the bundle page shows
-- was readable by no browser role at all.
set local role anon;
select is((select count(*)::int from public.offers where id = 'c6000000-0000-0000-0000-000000000001'), 1, 'anon reads a published bundle''s live offer');
select is((select count(*)::int from public.offers where id = 'c6000000-0000-0000-0000-000000000002'), 0, 'anon cannot read a draft bundle''s offer');
select is((select count(*)::int from public.offers where id = 'c6000000-0000-0000-0000-000000000003'), 0, 'anon cannot read an inactive bundle offer');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select is((select count(*)::int from public.offers where id = 'c6000000-0000-0000-0000-000000000001'), 1, 'a signed-in reader reads a published bundle''s live offer');
select is((select count(*)::int from public.offers where id = 'c6000000-0000-0000-0000-000000000002'), 0, 'a signed-in reader cannot read a draft bundle''s offer');
reset role;

-- Creation and idempotency (8-16)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('a-first', public.create_bundle_order('c7000000-0000-0000-0000-000000000001'));
insert into t_orders values ('a-repeat', public.create_bundle_order('c7000000-0000-0000-0000-000000000001'));
reset role;

select is((select order_id from t_orders where label = 'a-repeat'), (select order_id from t_orders where label = 'a-first'), 'a repeat Buy returns the same pending bundle order');
select results_eq(
  $$ select status::text, payment_status::text, total_minor, currency, bundle_id from public.orders where id = (select order_id from t_orders where label = 'a-first') $$,
  $$ values ('pending', 'pending', 199000::bigint, 'VND', 'c7000000-0000-0000-0000-000000000001'::uuid) $$,
  'the bundle order is pending at the server-read offer price and names the bundle'
);
select is(
  (select title_snapshot from public.orders where id = (select order_id from t_orders where label = 'a-first')),
  'S9 Starter Bundle',
  'the order snapshots the bundle title in the default metadata locale (English)'
);
select is(
  (select count(*)::int from public.order_items where order_id = (select order_id from t_orders where label = 'a-first')),
  2,
  'one line per published member, and none for the draft member'
);
select results_eq(
  $$ select position, book_id, unit_price_minor, title_snapshot from public.order_items where order_id = (select order_id from t_orders where label = 'a-first') order by position $$,
  $$ values (1, 'c2000000-0000-0000-0000-000000000001'::uuid, 199000::bigint, 'Sách một S9'),
            (2, 'c2000000-0000-0000-0000-000000000002'::uuid, 0::bigint, 'Sách hai S9') $$,
  'the lines carry bundle_books.position, the books'' own titles, and the bundle price on the first line only'
);
select is(
  (select sum(unit_price_minor)::bigint from public.order_items where order_id = (select order_id from t_orders where label = 'a-first')),
  199000::bigint,
  'the lines add up to the bundle price, never a prorated share of it'
);
select is(
  (select count(*)::int from public.order_items oi join public.skus sk on sk.id = oi.sku_id join public.editions e on e.id = sk.edition_id where oi.order_id = (select order_id from t_orders where label = 'a-first') and e.book_id = oi.book_id),
  2,
  'each line names a sku of its own book'
);
select is(
  (select count(*)::int from public.payments where order_id = (select order_id from t_orders where label = 'a-first') and provider = 'simulator' and status = 'pending' and amount_minor = 199000),
  1,
  'the bundle order has one pending simulator payment for the whole bundle'
);
select is(
  (select count(*)::int from public.order_items where order_id = (select order_id from t_orders where label = 'a-first') and book_id = 'c2000000-0000-0000-0000-000000000004'),
  0,
  'the draft member book is not sold with the bundle'
);

-- Partial ownership (17-19). D owns the first member and must still be able to buy the bundle.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000004', true);
insert into t_orders values ('d-order', public.create_bundle_order('c7000000-0000-0000-0000-000000000001'));
reset role;

select is((select total_minor from public.orders where id = (select order_id from t_orders where label = 'd-order')), 199000::bigint, 'partial ownership pays the full bundle price');
select is((select count(*)::int from public.order_items where order_id = (select order_id from t_orders where label = 'd-order')), 2, 'a partly owned bundle still sells every published member');
select isnt((select order_id from t_orders where label = 'd-order'), (select order_id from t_orders where label = 'a-first'), 'each reader gets their own bundle order');

-- Refusals (20-23)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$ select public.create_bundle_order('c7000000-0000-0000-0000-000000000001') $$,
  'EB013', null, 'a bundle whose every member is already owned cannot be bought'
);
select throws_ok(
  $$ select public.create_bundle_order('c7000000-0000-0000-0000-000000000002') $$,
  'EB027', null, 'a draft bundle cannot be bought'
);
select throws_ok(
  $$ select public.create_bundle_order('c7000000-0000-0000-0000-000000000003') $$,
  'EB027', null, 'a bundle with no live offer cannot be bought'
);
select throws_ok(
  $$ select public.create_bundle_order('c7000000-0000-0000-0000-000000000004') $$,
  'EB027', null, 'a bundle with no published member cannot be bought'
);
reset role;

-- A price change replaces the pending order (24-27), and the English-only bundle proves the title
-- fallback (28).
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('e-first', public.create_bundle_order('c7000000-0000-0000-0000-000000000005'));
reset role;
update public.offers set price_minor = 149000 where id = 'c6000000-0000-0000-0000-000000000005';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('e-second', public.create_bundle_order('c7000000-0000-0000-0000-000000000005'));
insert into t_orders values ('e-third', public.create_bundle_order('c7000000-0000-0000-0000-000000000005'));
reset role;

select isnt((select order_id from t_orders where label = 'e-second'), (select order_id from t_orders where label = 'e-first'), 'a bundle price change creates a new order');
select results_eq(
  $$ select status::text, payment_status::text from public.orders where id = (select order_id from t_orders where label = 'e-first') $$,
  $$ values ('cancelled', 'cancelled') $$,
  'the stale pending bundle order is cancelled'
);
select is((select total_minor from public.orders where id = (select order_id from t_orders where label = 'e-second')), 149000::bigint, 'the replacement bundle order uses the current price');
select is((select order_id from t_orders where label = 'e-third'), (select order_id from t_orders where label = 'e-second'), 'the replacement bundle order is then reused');
select is(
  (select title_snapshot from public.orders where id = (select order_id from t_orders where label = 'e-second')),
  'S9 English Bundle',
  'an English-only bundle snapshots its English title'
);

-- The configured payment provider (31-38). commerce_settings decides who may confirm an order, and
-- a bundle order booked under the wrong provider can never be paid: checkout answers "this order
-- can no longer be paid" and the buyer is stuck. The simulator default is asserted first, so a fix
-- cannot drift the other way, and the manual case is compared against create_ebook_order's own
-- answer from the same settings row - the two order paths must agree.
select is(
  (select payment_provider from public.orders where id = (select order_id from t_orders where label = 'a-first')),
  'simulator',
  'the default provider books a bundle order under the simulator'
);
select is(
  (select subtotal_minor from public.orders where id = (select order_id from t_orders where label = 'a-first')),
  199000::bigint,
  'the bundle order snapshots the quoted price as its subtotal'
);

update public.commerce_settings set payment_provider = 'manual';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000004', true);
insert into t_orders values ('d-manual', public.create_bundle_order('c7000000-0000-0000-0000-000000000001'));
insert into t_orders values ('d-manual-book', public.create_ebook_order('c2000000-0000-0000-0000-000000000005'));
reset role;

select isnt(
  (select order_id from t_orders where label = 'd-manual'),
  (select order_id from t_orders where label = 'd-order'),
  'a provider switch makes the pending bundle order stale rather than reusing it'
);
select results_eq(
  $$ select status::text, payment_status::text from public.orders where id = (select order_id from t_orders where label = 'd-order') $$,
  $$ values ('cancelled', 'cancelled') $$,
  'the bundle order booked under the previous provider is cancelled'
);
select is(
  (select payment_provider from public.orders where id = (select order_id from t_orders where label = 'd-manual')),
  'manual',
  'a bundle order books the configured provider on the order'
);
select is(
  (select pay.provider from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'd-manual')),
  'manual',
  'a bundle order books the configured provider on its payment row'
);
select is(
  (select payment_provider from public.orders where id = (select order_id from t_orders where label = 'd-manual')),
  (select payment_provider from public.orders where id = (select order_id from t_orders where label = 'd-manual-book')),
  'a bundle order and a single-book order agree on the provider from the same settings row'
);

-- A coupon lowers total_minor below the quoted price. Comparing the TOTAL to the offer would read
-- every discounted pending order as stale and cancel it on the reader's next visit, so the
-- staleness check compares the SUBTOTAL - the price as quoted.
update public.orders
set subtotal_minor = 199000, discount_minor = 20000, total_minor = 179000
where id = (select order_id from t_orders where label = 'd-manual');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000004', true);
insert into t_orders values ('d-manual-repeat', public.create_bundle_order('c7000000-0000-0000-0000-000000000001'));
reset role;

select is(
  (select order_id from t_orders where label = 'd-manual-repeat'),
  (select order_id from t_orders where label = 'd-manual'),
  'a discounted pending bundle order is reused, not cancelled as stale'
);

update public.commerce_settings set payment_provider = 'simulator';

-- Gates (29-30)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$ select public.create_bundle_order('c7000000-0000-0000-0000-000000000001') $$,
  'EB005', null, 'an unverified reader cannot buy a bundle'
);
reset role;

update public.commerce_settings set payments_enabled = false;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000004', true);
select throws_ok(
  $$ select public.create_bundle_order('c7000000-0000-0000-0000-000000000001') $$,
  'EB011', null, 'no bundle order can be created while payments are disabled'
);
reset role;

select * from finish();
rollback;
