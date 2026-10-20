-- S5 durable analytics events and the notification outbox
-- (docs/superpowers/specs/2026-09-16-s5-seo-operations-design.md 6.1-6.3, 6.5).
--
-- analytics_events is append-only: anon gets no grant at all, authenticated gets select (the
-- admin-only policy limits it), service_role gets select+insert, and an immutability trigger
-- blocks update/delete for every role except the table owner (an operator using the owner
-- credential directly, e.g. for a manual redaction - everyone else is already blocked by grants;
-- the trigger is defense in depth against a future or overlooked grant). A statement-level
-- trigger blocks TRUNCATE for every role, the owner included, because row-level delete triggers
-- never fire on TRUNCATE. The table has no JSON property column by design, so the privacy rule
-- (no book text, search text, reader locations, emails, IPs, or user agents) is a schema rule,
-- not an application convention.
create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null check (event_name in (
    'view_book', 'open_sample', 'begin_checkout', 'purchase', 'payment_failed',
    'open_reader', 'progress_25', 'progress_50', 'progress_75', 'progress_100',
    'change_reader_setting', 'view_library', 'book_published',
    'epub_job_started', 'epub_job_completed', 'epub_job_failed'
  )),
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) between 1 and 200),
  profile_id uuid references public.profiles(id) on delete set null,
  book_id uuid references public.books(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  publication_id uuid references public.ebook_publications(id) on delete set null,
  processing_job_id uuid references public.processing_jobs(id) on delete set null,
  locale text check (locale is null or locale in ('vi', 'en')),
  device_class text check (device_class is null or device_class in ('mobile', 'tablet', 'desktop')),
  occurred_at timestamptz not null default now()
);

-- Partial unique index: later tasks insert with
-- `on conflict (dedupe_key) where dedupe_key is not null do nothing`, which Postgres can only
-- infer against a unique index whose predicate matches exactly.
create unique index analytics_events_dedupe_key_idx
  on public.analytics_events(dedupe_key)
  where dedupe_key is not null;
create index analytics_events_occurred_at_idx on public.analytics_events(occurred_at desc);
create index analytics_events_event_name_occurred_at_idx
  on public.analytics_events(event_name, occurred_at desc);

alter table public.analytics_events enable row level security;
create policy analytics_events_admin_select on public.analytics_events
  for select to authenticated using (public.is_admin());
-- Explicit privileges: a hosted project that auto-exposes new tables hands the API roles default
-- privileges (including TRUNCATE, REFERENCES, and TRIGGER), so revoke everything and re-grant
-- exactly what the application needs - mirroring operations_alert_state. No role is ever granted
-- update, delete, or truncate; the triggers below are the second line of defense.
revoke all on public.analytics_events from public, anon, authenticated, service_role;
grant select on public.analytics_events to authenticated;
grant select, insert on public.analytics_events to service_role;

create function public.analytics_events_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_owner name;
begin
  select tableowner into v_owner
  from pg_catalog.pg_tables
  where schemaname = 'public' and tablename = 'analytics_events';

  if current_user = v_owner then
    return coalesce(new, old);
  end if;

  raise exception 'analytics_events rows are immutable and cannot be updated or deleted' using errcode = '55000';
end;
$$;

create trigger analytics_events_no_update
  before update on public.analytics_events
  for each row execute function public.analytics_events_immutable();

create trigger analytics_events_no_delete
  before delete on public.analytics_events
  for each row execute function public.analytics_events_immutable();

-- Row-level triggers don't fire on TRUNCATE, so immutability needs its own statement-level
-- trigger to close that gap. There is no owner exception here: a manual redaction removes
-- specific rows with delete, never the whole log.
create function public.analytics_events_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'analytics_events rows are immutable and cannot be truncated' using errcode = '55000';
end;
$$;

create trigger analytics_events_no_truncate
  before truncate on public.analytics_events
  for each statement execute function public.analytics_events_no_truncate();

-- notification_outbox: one row per entitlement, ever. The worker resolves the current verified
-- email, profile locale, public title, and public route at delivery time - this table never
-- stores rendered HTML or a copied book title.
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null unique references public.entitlements(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  template_key text not null check (template_key = 'book_ready'),
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 6),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 200),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check ((lease_token is null) = (lease_expires_at is null))
);

create index notification_outbox_claim_idx
  on public.notification_outbox(available_at, created_at)
  where sent_at is null and attempt_count < 6;

alter table public.notification_outbox enable row level security;
create policy notification_outbox_admin_select on public.notification_outbox
  for select to authenticated using (public.is_admin());
-- Explicit privileges, as for analytics_events: revoke the auto-exposed defaults, then grant
-- select only. No role - including service_role - gets insert/update/delete/truncate: the
-- entitlement trigger and the three RPCs below are the only writers, and they run as the table
-- owner via security definer.
revoke all on public.notification_outbox from public, anon, authenticated, service_role;
grant select on public.notification_outbox to authenticated;
grant select on public.notification_outbox to service_role;

-- One outbox row per entitlement, created only by a write event - never a backfill. The
-- migration itself contains no insert-select over existing entitlements, and the trigger is
-- created after the function so rows that exist at migration time are left untouched: only a
-- future insert or a revoked-to-active update ever reaches this function.
create function public.notification_outbox_entitlement_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.status = 'active')
     or (tg_op = 'UPDATE' and old.status = 'revoked' and new.status = 'active') then
    insert into public.notification_outbox (entitlement_id, profile_id, template_key)
    values (new.id, new.profile_id, 'book_ready')
    on conflict (entitlement_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger entitlements_notification_outbox
  after insert or update on public.entitlements
  for each row execute function public.notification_outbox_entitlement_trigger();

-- claim_notification_outbox: service_role only. Claims at most 25 rows, whose entitlement is
-- currently active, under `for update of o skip locked` so concurrent worker runs never lock
-- the same row - a revoked entitlement's row stays pending without being claimed or consuming
-- an attempt, and becomes claimable again the moment its entitlement is reactivated. The lease
-- lasts five minutes. The function returns only what the worker needs to render and send - never
-- a provider API key.
create function public.claim_notification_outbox(p_limit integer, p_lease_token uuid)
returns table (
  id uuid,
  entitlement_id uuid,
  profile_id uuid,
  template_key text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 25));
  v_lease_expires timestamptz := now() + interval '5 minutes';
begin
  return query
  with candidates as (
    select o.id
    from public.notification_outbox o
    join public.entitlements e on e.id = o.entitlement_id
    where o.sent_at is null
      and o.available_at <= now()
      and (o.lease_token is null or o.lease_expires_at <= now())
      and o.attempt_count < 6
      and e.status = 'active'
    order by o.available_at, o.created_at, o.id
    limit v_limit
    for update of o skip locked
  )
  update public.notification_outbox o
  set lease_token = p_lease_token,
      lease_expires_at = v_lease_expires
  from candidates
  where o.id = candidates.id
  returning o.id, o.entitlement_id, o.profile_id, o.template_key, o.attempt_count;
end;
$$;

-- complete_notification_outbox / fail_notification_outbox: both update only when `id` and
-- `lease_token` match and the lease has not expired, and both return boolean so a lost lease
-- (another worker already reclaimed the row) is explicit to the caller rather than silently
-- doing nothing.
create function public.complete_notification_outbox(p_id uuid, p_lease_token uuid, p_provider_message_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.notification_outbox
  set sent_at = now(),
      provider_message_id = p_provider_message_id,
      lease_token = null,
      lease_expires_at = null
  where id = p_id
    and lease_token = p_lease_token
    and lease_expires_at > now();

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create function public.fail_notification_outbox(p_id uuid, p_lease_token uuid, p_error_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt integer;
begin
  select attempt_count + 1 into v_attempt
  from public.notification_outbox
  where id = p_id
    and lease_token = p_lease_token
    and lease_expires_at > now()
  for update;

  if not found then
    return false;
  end if;

  update public.notification_outbox
  set attempt_count = v_attempt,
      last_error_code = p_error_code,
      lease_token = null,
      lease_expires_at = null,
      available_at = now() + case v_attempt
        when 1 then interval '1 minute'
        when 2 then interval '5 minutes'
        when 3 then interval '30 minutes'
        when 4 then interval '2 hours'
        when 5 then interval '6 hours'
        else interval '100 years'
      end
  where id = p_id;

  return true;
end;
$$;

revoke execute on function public.claim_notification_outbox(integer, uuid) from public, anon, authenticated;
revoke execute on function public.complete_notification_outbox(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.fail_notification_outbox(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_notification_outbox(integer, uuid) to service_role;
grant execute on function public.complete_notification_outbox(uuid, uuid, text) to service_role;
grant execute on function public.fail_notification_outbox(uuid, uuid, text) to service_role;
