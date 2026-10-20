begin;
select plan(15);

-- S7: commerce_settings.payment_provider, and create_ebook_order booking the payments row under it
-- instead of the 'simulator' literal it used to write. Everything the manual provider added joins
-- on payments.provider = 'manual', so an order booked under the wrong provider is invisible to all
-- of it - which is what these assertions exist to keep true.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-provider-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role: profiles RLS would hide the row after a role switch.
create temporary table t_ids as
select (select id from public.profiles where auth_user_id = 'b1000000-0000-0000-0000-000000000001') as reader_id;
grant select on t_ids to public;

create temporary table t_orders (label text primary key, order_id uuid not null);
grant select, insert on t_orders to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('b3000000-0000-0000-0000-000000000001', 's7-provider-author', 'S7 Provider Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('b2000000-0000-0000-0000-000000000001', 's7-provider-book', 'vi', 'b3000000-0000-0000-0000-000000000001', 'published');

insert into public.book_localizations (book_id, locale, slug, title)
values ('b2000000-0000-0000-0000-000000000001', 'vi', 's7-sach-provider', 'Sách provider S7');

insert into public.editions (id, book_id, language_code)
values ('b4000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'vi');

insert into public.skus (id, edition_id, sku_code)
values ('b5000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 's7-provider-sku');

insert into public.offers (sku_id, market_code, currency, price_minor)
values ('b5000000-0000-0000-0000-000000000001', 'VN', 'VND', 129000);

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('b6000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 's7-provider/1.epub', 1, 'published');

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('b7000000-0000-0000-0000-000000000001', 'b6000000-0000-0000-0000-000000000001', 1, 's7-provider/1/manifest.json', 'published');

update public.books set active_publication_id = 'b7000000-0000-0000-0000-000000000001'
where id = 'b2000000-0000-0000-0000-000000000001';

-- The column (1-4)
select col_not_null('public'::name, 'commerce_settings'::name, 'payment_provider'::name, 'payment_provider is not null');
select is(
  (select payment_provider from public.commerce_settings where id),
  'simulator',
  'the seeded settings row defaults to the simulator, so S3 behaviour is unchanged'
);
select throws_ok(
  $$ update public.commerce_settings set payment_provider = 'stripe' $$,
  '23514',
  null,
  'a provider this database has no mapping for is refused'
);
select throws_ok(
  $$ update public.commerce_settings set payment_provider = 'disabled' $$,
  '23514',
  null,
  'disabled is the payments_enabled gate, not a provider an order can be booked under'
);

-- Privileges. The provider decides who may confirm an order, so a reader must be able neither to
-- read it nor to change it (5-8)
select is(has_table_privilege('authenticated', 'public.commerce_settings', 'select'), false, 'readers cannot read commerce_settings');
select is(has_table_privilege('anon', 'public.commerce_settings', 'select'), false, 'anon cannot read commerce_settings');
select is(has_table_privilege('authenticated', 'public.commerce_settings', 'update'), false, 'readers cannot change commerce_settings');
select is(has_table_privilege('anon', 'public.commerce_settings', 'update'), false, 'anon cannot change commerce_settings');

update public.commerce_settings set payments_enabled = true, payment_provider = 'simulator';

-- An order booked while the database says simulator (9-10)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('simulator-first', public.create_ebook_order('b2000000-0000-0000-0000-000000000001'));
insert into t_orders values ('simulator-repeat', public.create_ebook_order('b2000000-0000-0000-0000-000000000001'));
reset role;

select is(
  (select pay.provider from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'simulator-first')),
  'simulator',
  'an order created while the setting says simulator is booked under the simulator'
);
select is(
  (select order_id from t_orders where label = 'simulator-repeat'),
  (select order_id from t_orders where label = 'simulator-first'),
  'a repeat Buy under the same provider still reuses the pending order'
);

update public.commerce_settings set payment_provider = 'manual';

-- The switch (11-14)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('manual-first', public.create_ebook_order('b2000000-0000-0000-0000-000000000001'));
insert into t_orders values ('manual-repeat', public.create_ebook_order('b2000000-0000-0000-0000-000000000001'));
reset role;

select isnt(
  (select order_id from t_orders where label = 'manual-first'),
  (select order_id from t_orders where label = 'simulator-first'),
  'a pending order booked under the other provider is not reused'
);
select results_eq(
  $$ select status::text, payment_status::text from public.orders where id = (select order_id from t_orders where label = 'simulator-first') $$,
  $$ values ('cancelled', 'cancelled') $$,
  'the order booked under the other provider is cancelled, not left pending'
);
select is(
  (select pay.status::text from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'simulator-first')),
  'cancelled',
  'its payments row is cancelled with it'
);
select is(
  (select pay.provider from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'manual-first')),
  'manual',
  'the replacement order is booked under the active provider'
);

-- And the reuse rule still holds on the new provider (15)
select is(
  (select order_id from t_orders where label = 'manual-repeat'),
  (select order_id from t_orders where label = 'manual-first'),
  'a repeat Buy after the switch reuses the new order rather than cancelling it again'
);

select * from finish();
rollback;
