begin;
select plan(7);

-- S7: the manual bank-transfer provider - payments.provider accepts 'manual', the entitlement
-- source is derived from the provider rather than hard-coded, and an unknown provider is refused.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '71000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-provider-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select (select id from public.profiles where auth_user_id = '71000000-0000-0000-0000-000000000001') as reader_id;
grant select on t_ids to public;

insert into public.authors (id, canonical_slug, display_name) values ('73000000-0000-0000-0000-000000000001', 's7-provider-author', 'S7 Provider Author');
insert into public.books (id, canonical_key, original_language, primary_author_id) values
  ('72000000-0000-0000-0000-000000000001', 's7-provider-book', 'vi', '73000000-0000-0000-0000-000000000001'),
  ('72000000-0000-0000-0000-000000000002', 's7-provider-book-two', 'vi', '73000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code) values ('74000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code) values ('75000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-000000000001', 's7-provider-sku');

insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, payment_provider)
select '76000000-0000-0000-0000-000000000001', reader_id, 'pending', 'pending', 'VN', 'VND', 129000, 'manual' from t_ids;
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
values ('76000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'S7 Provider Book', 129000, 1);

-- The enum and the provider constraint both accept manual.
select is(
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'entitlement_source' and e.enumlabel = 'manual_payment'),
  1::bigint,
  'entitlement_source has manual_payment');
select lives_ok(
  $$insert into public.payments (order_id, provider, status, amount_minor, currency)
    values ('76000000-0000-0000-0000-000000000001', 'manual', 'pending', 129000, 'VND')$$,
  'payments accepts provider manual');
select throws_ok(
  $$insert into public.payments (order_id, provider, status, amount_minor, currency)
    values ('76000000-0000-0000-0000-000000000001', 'bank_of_nowhere', 'pending', 129000, 'VND')$$,
  '23514', null, 'payments still refuses an unknown provider');

-- A manual event grants a manual_payment entitlement.
select lives_ok(
  $$select public.apply_payment_event('manual', 'manual:76000000-0000-0000-0000-000000000001:confirmed',
      '76000000-0000-0000-0000-000000000001', 'VCB-TXN-1', 'succeeded', 129000, 'VND', now())$$,
  'apply_payment_event accepts a manual event');
select is(
  (select source_type::text from public.entitlements where source_order_id = '76000000-0000-0000-0000-000000000001'),
  'manual_payment',
  'a manual event grants a manual_payment entitlement');

-- entitlements_source_consistency still fails closed: a manual_payment entitlement without the
-- order it was paid for is as invalid as a free_order without one.
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
    select reader_id, '72000000-0000-0000-0000-000000000002', 'manual_payment', null, 'active' from t_ids$$,
  '23514', null, 'a manual_payment entitlement still requires its source order');

-- An unknown provider is refused rather than silently defaulting to a source type.
select throws_ok(
  $$select public.apply_payment_event('bank_of_nowhere', 'evt-x', '76000000-0000-0000-0000-000000000001',
      'x', 'succeeded', 129000, 'VND', now())$$,
  'EB015', null, 'apply_payment_event refuses an unknown provider');

select * from finish();
rollback;
