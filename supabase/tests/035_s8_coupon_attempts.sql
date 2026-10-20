begin;
select plan(22);

-- S8: the coupon failed-attempt quota (spec 5.5). A wrong code is an oracle, so failures are
-- counted per profile - apply_coupon_to_order (Task 4) is the only caller, and it is only
-- reachable by a signed-in reader on their own order.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's8-quota-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's8-quota-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'b1000000-0000-0000-0000-000000000001') as reader_a,
  (select id from public.profiles where auth_user_id = 'b1000000-0000-0000-0000-000000000002') as reader_b;
grant select on t_ids to public;

-- Shape and contract (1-8)
select has_table('public', 'coupon_attempts', 'coupon_attempts exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.coupon_attempts'::regclass),
  'row level security is enabled on the quota table'
);
select has_function('public', 'coupon_attempts_exhausted', array['uuid']);
select function_returns('public', 'coupon_attempts_exhausted', array['uuid'], 'boolean');
select is_definer('public', 'coupon_attempts_exhausted', array['uuid']);
select has_function('public', 'record_coupon_failure', array['uuid']);
select function_returns('public', 'record_coupon_failure', array['uuid'], 'void');
select is_definer('public', 'record_coupon_failure', array['uuid']);

-- The window's behaviour (9-13)
select is(
  (select public.coupon_attempts_exhausted(t_ids.reader_a) from t_ids),
  false, 'a profile that has never entered a wrong code is not exhausted');

-- Nine failures is still inside the allowance.
do $$
declare v_profile uuid := (select reader_a from t_ids);
begin
  for i in 1..9 loop perform public.record_coupon_failure(v_profile); end loop;
end;
$$;

select is(
  (select public.coupon_attempts_exhausted(t_ids.reader_a) from t_ids),
  false, 'nine wrong codes in the window are allowed');

do $$ begin perform public.record_coupon_failure((select reader_a from t_ids)); end; $$;

select is(
  (select public.coupon_attempts_exhausted(t_ids.reader_a) from t_ids),
  true, 'the tenth wrong code exhausts the window');

-- An elapsed window starts over.
update public.coupon_attempts set window_start = now() - interval '11 minutes' where profile_id = (select reader_a from t_ids);
select is(
  (select public.coupon_attempts_exhausted(t_ids.reader_a) from t_ids),
  false, 'an elapsed window is not exhausted, whatever it counted');

do $$ begin perform public.record_coupon_failure((select reader_a from t_ids)); end; $$;

select is(
  (select a.failure_count from public.coupon_attempts a where a.profile_id = (select reader_a from t_ids)),
  1, 'the first failure after an elapsed window starts a new count at one');

-- Buckets are independent: reader A's ten exhausting failures above never touched reader B's row,
-- which does not exist yet - the cross-profile negative case (14)
select is(
  (select public.coupon_attempts_exhausted(t_ids.reader_b) from t_ids),
  false, 'a different profile is unaffected by another profile exhausting its own window');

-- Nobody but the owner role may call these, and nobody but the owner role may touch the table
-- directly - not a reader, not an anonymous caller, and not service_role either, since the only
-- door in is apply_coupon_to_order (Task 4), which shares the owner's rights (15-21)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.record_coupon_failure('00000000-0000-0000-0000-000000000000')$$,
  '42501', null, 'a signed-in reader cannot write the quota directly');
select throws_ok(
  $$select public.coupon_attempts_exhausted('00000000-0000-0000-0000-000000000000')$$,
  '42501', null, 'a signed-in reader cannot read the quota function directly');
select throws_ok(
  $$select 1 from public.coupon_attempts$$,
  '42501', null, 'a signed-in reader cannot select the quota table directly');
reset role;

set local role anon;
select throws_ok(
  $$select public.record_coupon_failure('00000000-0000-0000-0000-000000000000')$$,
  '42501', null, 'an anonymous caller cannot write the quota directly');
select throws_ok(
  $$select public.coupon_attempts_exhausted('00000000-0000-0000-0000-000000000000')$$,
  '42501', null, 'an anonymous caller cannot read the quota function directly');
select throws_ok(
  $$select 1 from public.coupon_attempts$$,
  '42501', null, 'an anonymous caller cannot select the quota table directly');
reset role;

set local role service_role;
select throws_ok(
  $$select 1 from public.coupon_attempts$$,
  '42501', null, 'service_role reaches the table only through the functions, not by a direct read');
reset role;

-- Belt and suspenders: PUBLIC carries no default execute grant either (22)
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
    where p.oid = 'public.record_coupon_failure(uuid)'::regprocedure
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no default execute on record_coupon_failure'
);

select * from finish();
rollback;
