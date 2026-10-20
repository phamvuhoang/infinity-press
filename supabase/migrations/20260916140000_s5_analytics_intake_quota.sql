-- S5 review fix: a durable, cross-instance quota for the public browser analytics intake
-- (POST /api/analytics/events; docs/superpowers/specs/2026-09-16-s5-seo-operations-design.md 8.2
-- and 12). The route consumes one unit here before its service-role insert, so a caller that mints
-- fresh event UUIDs forever still cannot grow analytics_events without bound.
--
-- A bucket is either `profile/<uuid>` (a signed-in caller) or the single `anonymous` key. The check
-- constraint makes that a schema rule: no IP address, or anything derived from one, can be stored
-- here, which keeps spec 12's "analytics cannot store IP addresses" true for this table too.
--
-- The table holds one row per bucket (at most one per profile plus one), so it stays small without
-- a cleanup job. Nobody reads or writes it directly: RLS is on with no policies, every API role's
-- privileges are revoked, and the security definer function below is the only way in.
create table public.analytics_intake_quota (
  bucket_key text primary key check (
    bucket_key = 'anonymous'
    or bucket_key ~ '^profile/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  window_start timestamptz not null,
  event_count integer not null check (event_count >= 0)
);

alter table public.analytics_intake_quota enable row level security;
revoke all on public.analytics_intake_quota from public, anon, authenticated, service_role;

-- Fixed window: the first call in a bucket, or the first after its window elapsed, starts a new
-- window at one; any other call adds one. The upsert takes the row lock, so concurrent calls from
-- different instances serialize on the bucket and each sees its own count. The first refused call
-- records limit + 1 (the operator's sign that the bucket saturated); after that, the update's WHERE
-- guard skips the write entirely until the window elapses, so a flood against a full bucket (the
-- hot `anonymous` row above all) writes no new row versions. A skipped update returns no row, which
-- is a refusal. Returns whether this call is within the limit.
create function public.consume_analytics_quota(p_bucket_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window interval;
  v_count integer;
begin
  if p_bucket_key is null
    or char_length(p_bucket_key) > 100
    or not (
      p_bucket_key = 'anonymous'
      or p_bucket_key ~ '^profile/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
    raise exception 'invalid analytics quota bucket key' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000000 then
    raise exception 'invalid analytics quota limit' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid analytics quota window' using errcode = '22023';
  end if;

  v_window := make_interval(secs => p_window_seconds);

  insert into public.analytics_intake_quota as q (bucket_key, window_start, event_count)
  values (p_bucket_key, now(), 1)
  on conflict (bucket_key) do update set
    window_start = case when q.window_start <= now() - v_window then now() else q.window_start end,
    event_count = case when q.window_start <= now() - v_window then 1 else q.event_count + 1 end
  where q.window_start <= now() - v_window or q.event_count <= p_limit
  returning event_count into v_count;

  -- No row back: the guard skipped the update because this window is already over the limit.
  if not found then
    return false;
  end if;
  return v_count <= p_limit;
end;
$$;

revoke execute on function public.consume_analytics_quota(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_analytics_quota(text, integer, integer) to service_role;
