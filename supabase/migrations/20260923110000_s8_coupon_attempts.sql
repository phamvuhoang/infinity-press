-- S8: the per-profile failed-attempt quota for coupon codes (spec 5.5), reusing the fixed-window
-- shape 20260916140000_s5_analytics_intake_quota.sql established.
--
-- No new error codes.
--
-- Why a code needs this at all: a code is short, guessable, and a wrong one is an oracle. The
-- counter is per profile because apply_coupon_to_order is only reachable by a signed-in reader on
-- their own order, so a profile - not an IP address - is the actor. No IP address, or anything
-- derived from one, is stored here.
--
-- One row per profile that has ever entered a wrong code; nothing else is written, so the table
-- stays small without a cleanup job.
create table public.coupon_attempts (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  window_start timestamptz not null default now(),
  failure_count integer not null default 0 check (failure_count >= 0)
);

alter table public.coupon_attempts enable row level security;
revoke all on public.coupon_attempts from public, anon, authenticated, service_role;

-- The limit and the window. Ten wrong codes in ten minutes is far more than a reader retyping a
-- code from a chat message, and far less than a useful search of the code space.
create function public.coupon_attempts_exhausted(p_profile_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    (select a.failure_count >= 10 and a.window_start > now() - interval '10 minutes'
     from public.coupon_attempts a where a.profile_id = p_profile_id),
    false
  );
$$;

-- Called on a REJECTED application, never on a successful one, and never from a code path that is
-- about to raise: an exception would roll this write back with the rest of the transaction, which
-- is exactly why apply_coupon_to_order returns its rejection as a value instead of raising it.
create function public.record_coupon_failure(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.coupon_attempts as a (profile_id, window_start, failure_count)
  values (p_profile_id, now(), 1)
  on conflict (profile_id) do update set
    window_start = case when a.window_start <= now() - interval '10 minutes' then now() else a.window_start end,
    failure_count = case when a.window_start <= now() - interval '10 minutes' then 1 else a.failure_count + 1 end;
end;
$$;

revoke execute on function public.coupon_attempts_exhausted(uuid) from public, anon, authenticated;
revoke execute on function public.record_coupon_failure(uuid) from public, anon, authenticated;
