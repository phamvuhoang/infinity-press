begin;
select plan(7);

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

-- S7: orders.payment_provider, the reader-readable copy of the provider the order is booked under.
--
-- The provider already lives on the order's payments row, and every admin surface reads it there.
-- A reader cannot: public.payments carries exactly one policy, "admin reads payments"
-- (20260911100000_mvp_access_admin.sql), and no other policy or grant exists anywhere. So a
-- reader's PostgREST embed of payments returns nothing at all, and every manual state derived from
-- it on a reader-facing page was unreachable. These assertions pin both halves: the column is on
-- the order, the reader can read it, and the payments row they still cannot.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-orderprovider-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role: profiles RLS would hide the row after a role switch.
create temporary table t_ids as
select (select id from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001') as reader_id;
grant select on t_ids to public;

create temporary table t_orders (label text primary key, order_id uuid not null);
grant select, insert on t_orders to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('c3000000-0000-0000-0000-000000000001', 's7-orderprovider-author', 'S7 Order Provider Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('c2000000-0000-0000-0000-000000000001', 's7-orderprovider-book', 'vi', 'c3000000-0000-0000-0000-000000000001', 'published');

insert into public.book_localizations (book_id, locale, slug, title)
values ('c2000000-0000-0000-0000-000000000001', 'vi', 's7-sach-orderprovider', 'Sách order provider S7');

insert into public.editions (id, book_id, language_code)
values ('c4000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'vi');

insert into public.skus (id, edition_id, sku_code)
values ('c5000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000001', 's7-orderprovider-sku');

insert into public.offers (sku_id, market_code, currency, price_minor)
values ('c5000000-0000-0000-0000-000000000001', 'VN', 'VND', 129000);

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('c6000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000001', 's7-orderprovider/1.epub', 1, 'published');

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('c7000000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001', 1, 's7-orderprovider/1/manifest.json', 'published');

update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'c7000000-0000-0000-0000-000000000001' and (b.id = 'c2000000-0000-0000-0000-000000000001');

-- The column (1-2)
select col_not_null('public'::name, 'orders'::name, 'payment_provider'::name, 'orders.payment_provider is not null');

update public.commerce_settings set payments_enabled = true, payment_provider = 'simulator';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('simulator', public.create_ebook_order('c2000000-0000-0000-0000-000000000001'));
reset role;

select is(
  (select o.payment_provider from public.orders o where o.id = (select order_id from t_orders where label = 'simulator')),
  'simulator',
  'an order created while the setting says simulator carries simulator on the order too');

update public.commerce_settings set payment_provider = 'manual';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('manual', public.create_ebook_order('c2000000-0000-0000-0000-000000000001'));
reset role;

-- The order and its payments row can never disagree: create_ebook_order takes both from one
-- commerce_settings read, in one statement, in one transaction (3-4)
select is(
  (select o.payment_provider from public.orders o where o.id = (select order_id from t_orders where label = 'manual')),
  'manual',
  'an order created while the setting says manual carries manual on the order');
select is(
  (select pay.provider from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'manual')),
  (select o.payment_provider from public.orders o where o.id = (select order_id from t_orders where label = 'manual')),
  'the order and its payments row name the same provider');

-- What the whole column exists for: the owning reader can read it, while the payments row it was
-- previously derived from stays invisible to them (5-6)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select is(
  (select o.payment_provider from public.orders o where o.id = (select order_id from t_orders where label = 'manual')),
  'manual',
  'the owning reader reads payment_provider off their own order');
select is(
  (select count(*) from public.payments), 0::bigint,
  'the owning reader still reads no payments row at all - which is why the provider is on the order');
reset role;

-- A provider this database has no mapping for is refused, exactly as on payments.provider (7)
select throws_ok(
  $$ update public.orders set payment_provider = 'stripe'
     where id = (select order_id from t_orders where label = 'manual') $$,
  '23514',
  null,
  'a provider this database has no mapping for is refused on the order too');

select * from finish();
rollback;
