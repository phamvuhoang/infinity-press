begin;
select plan(31);

-- S5 review fix: the durable, cross-instance quota that POST /api/analytics/events consumes before
-- its service-role insert. A bucket is `profile/<uuid>` or the single `anonymous` key - never an IP
-- address or anything derived from one - and only service_role can consume it.

-- Schema and function contract (1-7)
select has_table('public', 'analytics_intake_quota'::name);
select columns_are(
  'public', 'analytics_intake_quota',
  array['bucket_key', 'window_start', 'event_count'],
  'the quota table holds a bucket key, a window start, and a count - nothing else'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'analytics_intake_quota'
      and (data_type in ('inet', 'cidr') or column_name ~* '(^|_)(ip|addr|address|user_agent|agent)($|_)')
  ),
  'the quota table has no IP-like or user-agent column'
);
select has_function('public', 'consume_analytics_quota', array['text', 'integer', 'integer']);
select function_returns('public', 'consume_analytics_quota', array['text', 'integer', 'integer'], 'boolean');
select is_definer('public', 'consume_analytics_quota', array['text', 'integer', 'integer']);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.analytics_intake_quota'::regclass),
  'row level security is enabled on the quota table'
);

-- Only the two bucket shapes are storable, so an IP address cannot be written by mistake (8-9)
select throws_ok(
  $$insert into public.analytics_intake_quota values ('203.0.113.7', now(), 1)$$,
  '23514'
);
select throws_ok(
  $$insert into public.analytics_intake_quota values ('profile/not-a-uuid', now(), 1)$$,
  '23514'
);

-- A window counts events up to the limit and refuses the rest (10-14)
set local role service_role;
select ok(public.consume_analytics_quota('anonymous', 3, 60), 'first event in the window is allowed');
select ok(public.consume_analytics_quota('anonymous', 3, 60), 'second event is allowed');
select ok(public.consume_analytics_quota('anonymous', 3, 60), 'third event reaches the limit and is allowed');
select ok(not public.consume_analytics_quota('anonymous', 3, 60), 'fourth event is over the limit');
select ok(not public.consume_analytics_quota('anonymous', 3, 60), 'a refused event stays refused');
reset role;

-- The stored count saturates at limit + 1 instead of growing for every refused call (15)
select is(
  (select event_count from public.analytics_intake_quota where bucket_key = 'anonymous'),
  4,
  'the stored count stops at limit + 1'
);

-- Once saturated, a refused call does not write the row at all: its tuple (ctid) stays the same,
-- where any update - even one to identical values - would create a new row version (16-17)
create temporary table t_saturated as
select ctid::text as row_ctid, window_start, event_count
from public.analytics_intake_quota where bucket_key = 'anonymous';
grant select on t_saturated to public;
set local role service_role;
select ok(not public.consume_analytics_quota('anonymous', 3, 60), 'a call against a saturated window is refused');
reset role;
select is(
  (select row(ctid::text, window_start, event_count)::text from public.analytics_intake_quota where bucket_key = 'anonymous'),
  (select row(row_ctid, window_start, event_count)::text from t_saturated),
  'a refused call leaves the saturated row unwritten'
);

-- Buckets are independent (18)
set local role service_role;
select ok(
  public.consume_analytics_quota('profile/20000000-0000-4000-8000-000000000001', 3, 60),
  'a profile bucket is not charged for anonymous traffic'
);
reset role;

-- An elapsed window starts over at one (19-20)
update public.analytics_intake_quota
set window_start = now() - interval '61 seconds'
where bucket_key = 'anonymous';
set local role service_role;
select ok(public.consume_analytics_quota('anonymous', 3, 60), 'an elapsed window resets and allows the event');
reset role;
select is(
  (select event_count from public.analytics_intake_quota where bucket_key = 'anonymous'),
  1,
  'the reset window counts this event only'
);

-- Input validation (21-24)
set local role service_role;
select throws_ok($$select public.consume_analytics_quota('anonymous', 0, 60)$$, '22023');
select throws_ok($$select public.consume_analytics_quota('anonymous', 5, 0)$$, '22023');
select throws_ok($$select public.consume_analytics_quota(repeat('x', 101), 5, 60)$$, '22023');
select throws_ok($$select public.consume_analytics_quota('198.51.100.1', 5, 60)$$, '22023');
reset role;

-- Browser roles can neither execute the function nor touch the table (25-31)
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
    where p.oid = 'public.consume_analytics_quota(text, integer, integer)'::regprocedure
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no default execute on consume_analytics_quota'
);
set local role anon;
select throws_ok($$select public.consume_analytics_quota('anonymous', 1000, 60)$$, '42501');
select throws_ok($$select count(*) from public.analytics_intake_quota$$, '42501');
reset role;
set local role authenticated;
select throws_ok($$select public.consume_analytics_quota('anonymous', 1000, 60)$$, '42501');
select throws_ok(
  $$insert into public.analytics_intake_quota values ('anonymous', now(), 0)
    on conflict (bucket_key) do update set event_count = 0$$,
  '42501'
);
reset role;
-- service_role reaches the table only through the function: no direct read or write either
set local role service_role;
select throws_ok($$select count(*) from public.analytics_intake_quota$$, '42501');
select throws_ok(
  $$update public.analytics_intake_quota set event_count = 0 where bucket_key = 'anonymous'$$,
  '42501'
);
reset role;

select * from finish();
rollback;
