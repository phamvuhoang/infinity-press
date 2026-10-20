begin;
select plan(5);

select has_column('public', 'orders', 'reference_code', 'orders has reference_code');
select col_not_null('public', 'orders', 'reference_code', 'reference_code is not null');
select col_is_unique('public', 'orders', array['reference_code'], 'reference_code is unique');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '81000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-ref-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select (select id from public.profiles where auth_user_id = '81000000-0000-0000-0000-000000000001') as reader_id;
grant select on t_ids to public;

insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '86000000-0000-0000-0000-000000000001', reader_id, 'pending', 'pending', 'VN', 'VND', 1000 from t_ids;

select matches(
  (select reference_code from public.orders where id = '86000000-0000-0000-0000-000000000001'),
  '^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$',
  'a new order gets a well-formed reference code without the caller supplying one');

select is(
  (select count(*) from public.orders where reference_code is null), 0::bigint,
  'no order is left without a reference code');

select * from finish();
rollback;
