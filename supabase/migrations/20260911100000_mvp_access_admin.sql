create type public.entitlement_status as enum ('active', 'revoked');
create type public.entitlement_source as enum ('free_order', 'admin_grant', 'simulated_payment');
create type public.library_state as enum ('unread', 'reading', 'completed');
create type public.order_status as enum ('draft', 'pending', 'completed', 'cancelled');
create type public.payment_status as enum ('not_required', 'pending', 'succeeded', 'failed', 'cancelled');

-- Reader-session version integrity: reader_sessions below pins its publication reference to a
-- specific (id, version) pair rather than just the publication id, so this unique constraint has
-- to exist before that composite foreign key can be declared.
alter table public.ebook_publications
  add constraint ebook_publications_id_version_key unique (id, version);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text,
  locale text not null default 'vi' check (locale in ('vi', 'en')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customer_identities (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete cascade,
  normalized_email text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  status public.order_status not null,
  payment_status public.payment_status not null,
  market_code text not null check (market_code ~ '^[A-Z]{2}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check (total_minor >= 0),
  created_at timestamptz not null default now()
);

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id),
  source_type public.entitlement_source not null,
  source_order_id uuid references public.orders(id),
  actor_profile_id uuid references public.profiles(id),
  reason text,
  status public.entitlement_status not null default 'active',
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  -- Entitlement source consistency: each source_type carries its own required evidence, and an
  -- admin_grant may never masquerade as an order-backed entitlement (source_order_id null). The
  -- else branch makes the check fail closed (rather than pass via NULL) for any source_type this
  -- CASE doesn't yet know about.
  constraint entitlements_source_consistency check (
    case source_type
      when 'free_order' then source_order_id is not null
      when 'simulated_payment' then source_order_id is not null
      when 'admin_grant' then
        actor_profile_id is not null
        and reason is not null
        and length(trim(reason)) > 0
        and source_order_id is null
      else false
    end
  ),
  constraint entitlements_revoked_at_check check (
    status <> 'revoked' or revoked_at is not null
  )
);

create table public.library_items (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id),
  entitlement_id uuid not null references public.entitlements(id),
  state public.library_state not null default 'unread',
  added_at timestamptz not null default now()
);

create table public.reading_progress (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  publication_id uuid not null references public.ebook_publications(id),
  locator_json jsonb not null,
  progression numeric not null check (progression between 0 and 1),
  device_id text not null,
  client_sequence bigint not null check (client_sequence >= 0),
  updated_at timestamptz not null default now()
);

create table public.reader_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  publication_id uuid not null,
  publication_version integer not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  -- Guarantees only that publication_version matches the referenced publication's actual
  -- version, instead of just the publication id. It does not by itself stop a session from
  -- reading a superseded publication: a superseded publication keeps its (id, version), so this
  -- FK is still satisfied. Superseding enforcement, if any, is a later task's concern.
  foreign key (publication_id, publication_version) references public.ebook_publications(id, version)
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  sku_id uuid not null references public.skus(id),
  book_id uuid not null references public.books(id),
  title_snapshot text not null,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  quantity integer not null default 1 check (quantity = 1)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  provider text not null check (provider in ('disabled', 'simulator')),
  external_payment_id text,
  status public.payment_status not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id),
  provider text not null,
  provider_event_id text not null,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, provider_event_id)
);

create table public.user_roles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  role text not null check (role in ('reader', 'admin')),
  granted_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.redirects (
  id uuid primary key default gen_random_uuid(),
  source_path text not null unique check (source_path like '/%'),
  destination_path text not null check (destination_path like '/%'),
  created_at timestamptz not null default now(),
  check (source_path <> destination_path)
);

create table public.merchandising_slots (
  id uuid primary key default gen_random_uuid(),
  slot_key text not null unique,
  book_id uuid references public.books(id),
  position integer not null default 0,
  active boolean not null default true
);

create unique index customer_identities_email_key
  on public.customer_identities(lower(normalized_email));
create unique index entitlements_active_subject_key
  on public.entitlements(profile_id, book_id)
  where status = 'active';
create unique index library_items_profile_book_key
  on public.library_items(profile_id, book_id);
create unique index reading_progress_profile_publication_key
  on public.reading_progress(profile_id, publication_id);

-- Audit immutability: audit_logs rows can be inserted but never changed, removed, or truncated
-- away, by any role including service_role. The triggers fire unconditionally, independent of
-- grants or RLS. This function is reused for both row-level (update/delete) and statement-level
-- (truncate) triggers below, so it must not reference NEW/OLD.
create function public.audit_logs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs rows are immutable and cannot be updated, deleted, or truncated';
end;
$$;

create trigger audit_logs_no_update
  before update on public.audit_logs
  for each row execute function public.audit_logs_immutable();

create trigger audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function public.audit_logs_immutable();

-- Row-level triggers don't fire on TRUNCATE, so immutability needs its own statement-level
-- trigger to close that gap.
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function public.audit_logs_immutable();

-- public.is_admin(): whether the calling user's profile holds the 'admin' role. Used by RLS
-- policies below and by server-side authorization checks (Task 7's requireAdmin()).
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.profiles p on p.id = ur.profile_id
    where p.auth_user_id = auth.uid()
      and ur.role = 'admin'
  );
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- Profile/identity bootstrap: mirrors auth.users into a profile and a normalized customer
-- identity on insert, and keeps the identity's normalized_email/verified_at in sync on the
-- email-affecting updates auth.users can go through. Idempotent so it never creates duplicate
-- profile or identity rows for the same auth user. A user with no email (phone/anonymous
-- sign-in) still gets a profile, just no customer_identity, since normalized_email is not null.
create function public.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
begin
  if tg_op = 'INSERT' then
    insert into public.profiles (auth_user_id)
    values (new.id)
    on conflict (auth_user_id) do nothing
    returning id into v_profile_id;

    if v_profile_id is null then
      select id into v_profile_id from public.profiles where auth_user_id = new.id;
    end if;

    if new.email is not null then
      insert into public.customer_identities (profile_id, normalized_email, verified_at)
      values (v_profile_id, lower(trim(new.email)), new.email_confirmed_at)
      on conflict (lower(normalized_email)) do nothing;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.email is not null then
      update public.customer_identities
      set normalized_email = lower(trim(new.email)),
          verified_at = new.email_confirmed_at
      where profile_id = (select id from public.profiles where auth_user_id = new.id);
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.handle_auth_user_change() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_change();

create trigger on_auth_user_email_updated
  after update of email, email_confirmed_at on auth.users
  for each row execute function public.handle_auth_user_change();

-- Backfill: the two triggers above only fire for auth.users rows inserted or updated after this
-- migration runs. Any auth.users row that predates the migration (for example, users created by
-- the Task 4 magic-link flow before this schema existed) needs its profile and customer_identity
-- created here instead, using the same normalization and skipping null emails. Idempotent via
-- the same conflict targets the trigger uses, so re-running this migration, or running this
-- block again by hand, creates no duplicates.
insert into public.profiles (auth_user_id)
select u.id
from auth.users u
where not exists (select 1 from public.profiles p where p.auth_user_id = u.id)
on conflict (auth_user_id) do nothing;

insert into public.customer_identities (profile_id, normalized_email, verified_at)
select p.id, lower(trim(u.email)), u.email_confirmed_at
from auth.users u
join public.profiles p on p.auth_user_id = u.id
where u.email is not null
  and not exists (select 1 from public.customer_identities ci where ci.profile_id = p.id)
on conflict (lower(normalized_email)) do nothing;

-- Row level security: owner-scoped reads on the reader-facing tables, is_admin()-gated reads on
-- the admin-facing tables, and no INSERT/DELETE policies for browser roles anywhere. Financial,
-- entitlement, role, and audit mutations go through trusted server code (security-definer RPCs,
-- or the service-role admin client and CLI), never a browser-facing policy.
--
-- Every predicate below wraps its session function as `(select auth.uid())` / `(select
-- public.is_admin())`. Postgres hoists a scalar subquery with no outer reference into a one-shot
-- InitPlan, so the function runs once per statement instead of once per candidate row (Supabase
-- calls this the auth_rls_initplan lint). It matters most for is_admin(), a security-definer
-- function joining two tables across the seven admin policies here.
alter table public.profiles enable row level security;
alter table public.customer_identities enable row level security;
alter table public.orders enable row level security;
alter table public.entitlements enable row level security;
alter table public.library_items enable row level security;
alter table public.reading_progress enable row level security;
alter table public.reader_sessions enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.user_roles enable row level security;
alter table public.audit_logs enable row level security;
alter table public.redirects enable row level security;
alter table public.merchandising_slots enable row level security;

create policy "owner reads own profile" on public.profiles
  for select
  to authenticated
  using (auth_user_id = (select auth.uid()));

create policy "owner updates own profile" on public.profiles
  for update
  to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

create policy "owner reads own orders" on public.orders
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = orders.profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "owner reads own order items" on public.order_items
  for select
  to authenticated
  using (
    exists (
      select 1 from public.orders o
      join public.profiles p on p.id = o.profile_id
      where o.id = order_items.order_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "owner reads own entitlements" on public.entitlements
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = entitlements.profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "owner reads own library items" on public.library_items
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = library_items.profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "owner reads own reading progress" on public.reading_progress
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = reading_progress.profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "owner updates own reading progress" on public.reading_progress
  for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = reading_progress.profile_id
        and p.auth_user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = reading_progress.profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "owner reads own reader sessions" on public.reader_sessions
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = reader_sessions.profile_id
        and p.auth_user_id = (select auth.uid())
    )
  );

create policy "admin reads customer identities" on public.customer_identities
  for select
  to authenticated
  using ((select public.is_admin()));

create policy "admin reads payments" on public.payments
  for select
  to authenticated
  using ((select public.is_admin()));

create policy "admin reads payment events" on public.payment_events
  for select
  to authenticated
  using ((select public.is_admin()));

create policy "admin reads user roles" on public.user_roles
  for select
  to authenticated
  using ((select public.is_admin()));

create policy "admin reads audit logs" on public.audit_logs
  for select
  to authenticated
  using ((select public.is_admin()));

create policy "admin reads redirects" on public.redirects
  for select
  to authenticated
  using ((select public.is_admin()));

create policy "admin reads merchandising slots" on public.merchandising_slots
  for select
  to authenticated
  using ((select public.is_admin()));

-- Privileges: explicit grants only, matching Task 5's convention. anon gets nothing on any
-- Task 6 table. authenticated gets table-level SELECT only on the tables its policies above
-- cover, plus column-level UPDATE on the two owner-editable tables. No role gets browser-facing
-- INSERT/DELETE anywhere in this schema.
grant select on
  public.profiles,
  public.customer_identities,
  public.orders,
  public.entitlements,
  public.library_items,
  public.reading_progress,
  public.reader_sessions,
  public.order_items,
  public.payments,
  public.payment_events,
  public.user_roles,
  public.audit_logs,
  public.redirects,
  public.merchandising_slots
to authenticated;

revoke select on
  public.profiles,
  public.customer_identities,
  public.orders,
  public.entitlements,
  public.library_items,
  public.reading_progress,
  public.reader_sessions,
  public.order_items,
  public.payments,
  public.payment_events,
  public.user_roles,
  public.audit_logs,
  public.redirects,
  public.merchandising_slots
from anon;

revoke insert, update, delete, truncate on
  public.profiles,
  public.customer_identities,
  public.orders,
  public.entitlements,
  public.library_items,
  public.reading_progress,
  public.reader_sessions,
  public.order_items,
  public.payments,
  public.payment_events,
  public.user_roles,
  public.audit_logs,
  public.redirects,
  public.merchandising_slots
from anon, authenticated;

-- Column-level UPDATE grants must come after the table-wide revoke above: a bare
-- "revoke update on table from role" strips previously granted column-specific UPDATE
-- privileges too, so granting these first would leave authenticated with no UPDATE at all.
grant update (display_name, locale) on public.profiles to authenticated;
grant update (locator_json, progression, device_id, client_sequence, updated_at)
  on public.reading_progress to authenticated;

-- service_role backs Task 7's server-only DAL, security-definer RPCs, and the admin client/CLI
-- that will write entitlements, orders, payments, roles, audit rows, and progress on these
-- tables; it is not auto-exposed to them (see auto_expose_new_tables in supabase/config.toml).
grant select, insert, update, delete on
  public.profiles,
  public.customer_identities,
  public.orders,
  public.entitlements,
  public.library_items,
  public.reading_progress,
  public.reader_sessions,
  public.order_items,
  public.payments,
  public.payment_events,
  public.user_roles,
  public.audit_logs,
  public.redirects,
  public.merchandising_slots
to service_role;
