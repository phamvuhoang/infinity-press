-- S20 reading journeys (docs/superpowers/plans/2026-10-22-s20-minimal-reading-ux.md, Task 1).
-- A journey is a free sequence of short reading sessions over one edition. Content tables are
-- public when the journey is published; admins write them through the service role. Progress and
-- completions are written only by the definer RPCs below and read back by their owner. Error code:
-- EB047 for every journey RPC refusal.

create table public.reading_journeys (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  slug text not null unique,
  status public.content_status not null default 'draft',
  -- Maintained by journey_sessions_count_trigger; never written directly.
  session_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reading_journeys_book_idx on public.reading_journeys (book_id);
create trigger reading_journeys_touch_updated_at before update on public.reading_journeys
  for each row execute function public.touch_updated_at();

create table public.journey_localizations (
  journey_id uuid not null references public.reading_journeys(id) on delete cascade,
  locale text not null references public.supported_locales(code),
  title text not null,
  summary text,
  primary key (journey_id, locale)
);

create table public.journey_sessions (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references public.reading_journeys(id) on delete cascade,
  position integer not null check (position between 1 and 60),
  start_locator jsonb not null check (public.reader_locator_is_valid(start_locator)),
  end_locator jsonb check (end_locator is null or public.reader_locator_is_valid(end_locator)),
  unique (journey_id, position)
);

-- Up to three reflection questions, each a string of at most 500 characters.
create function public.journey_questions_are_valid(p_questions jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_questions) = 'array'
    and jsonb_array_length(p_questions) <= 3
    and not exists (
      select 1 from jsonb_array_elements(p_questions) q
      where jsonb_typeof(q) <> 'string' or char_length(q #>> '{}') > 500
    );
$$;
revoke execute on function public.journey_questions_are_valid(jsonb) from public, anon, authenticated;
grant execute on function public.journey_questions_are_valid(jsonb) to service_role;

create table public.journey_session_localizations (
  session_id uuid not null references public.journey_sessions(id) on delete cascade,
  locale text not null references public.supported_locales(code),
  title text not null,
  guide_md text,
  questions jsonb not null default '[]'::jsonb check (public.journey_questions_are_valid(questions)),
  primary key (session_id, locale)
);

create table public.journey_progress (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  journey_id uuid not null references public.reading_journeys(id) on delete cascade,
  position integer not null,
  completed_at timestamptz not null default now(),
  primary key (profile_id, journey_id, position)
);

create table public.journey_completions (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  journey_id uuid not null references public.reading_journeys(id) on delete cascade,
  reflection text check (reflection is null or char_length(reflection) <= 2000),
  completed_at timestamptz not null default now(),
  primary key (profile_id, journey_id)
);

-- session_count ------------------------------------------------------------------------------

create function public.journey_sessions_count()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_journey_id uuid := coalesce(new.journey_id, old.journey_id);
begin
  update public.reading_journeys j
  set session_count = (select count(*) from public.journey_sessions s where s.journey_id = v_journey_id)
  where j.id = v_journey_id;
  return null;
end;
$$;
create trigger journey_sessions_count_trigger after insert or delete on public.journey_sessions
  for each row execute function public.journey_sessions_count();

-- Analytics: five S20 names. Identifier columns only. ------------------------------------------

alter table public.analytics_events
  drop constraint analytics_events_event_name_check,
  add constraint analytics_events_event_name_check check (event_name in (
    'view_book', 'open_sample', 'begin_checkout', 'purchase', 'payment_failed',
    'open_reader', 'progress_25', 'progress_50', 'progress_75', 'progress_100',
    'change_reader_setting', 'view_library', 'book_published',
    'epub_job_started', 'epub_job_completed', 'epub_job_failed',
    'click_external_store', 'share_quote', 'view_quote',
    'session_completed', 'journey_completed', 'passage_opened', 'passage_shared', 'compare_opened'
  ));

-- RPCs ---------------------------------------------------------------------------------------

create function public.mark_journey_session(p_journey_id uuid, p_position integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_book_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'mark_journey_session: no profile' using errcode = 'EB047';
  end if;
  select j.book_id into v_book_id from public.reading_journeys j
  where j.id = p_journey_id and j.status = 'published';
  if v_book_id is null then
    raise exception 'mark_journey_session: journey not found' using errcode = 'EB047';
  end if;
  if not exists (select 1 from public.journey_sessions s where s.journey_id = p_journey_id and s.position = p_position) then
    raise exception 'mark_journey_session: session not found' using errcode = 'EB047';
  end if;
  insert into public.journey_progress (profile_id, journey_id, position)
  values (v_profile_id, p_journey_id, p_position)
  on conflict do nothing;
  insert into public.analytics_events (event_name, dedupe_key, profile_id, book_id)
  values ('session_completed', 'journey:' || p_journey_id || ':' || v_profile_id || ':' || p_position, v_profile_id, v_book_id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

create function public.complete_journey(p_journey_id uuid, p_reflection text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_reflection text := nullif(btrim(coalesce(p_reflection, '')), '');
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'complete_journey: no profile' using errcode = 'EB047';
  end if;
  select j.book_id into v_book_id from public.reading_journeys j
  where j.id = p_journey_id and j.status = 'published';
  if v_book_id is null then
    raise exception 'complete_journey: journey not found' using errcode = 'EB047';
  end if;
  if char_length(v_reflection) > 2000 then
    raise exception 'complete_journey: reflection too long' using errcode = 'EB047';
  end if;
  -- One completed session is enough here; the 17-of-21 threshold is a report filter, not a gate.
  if not exists (select 1 from public.journey_progress g where g.profile_id = v_profile_id and g.journey_id = p_journey_id) then
    raise exception 'complete_journey: no completed session' using errcode = 'EB047';
  end if;
  insert into public.journey_completions (profile_id, journey_id, reflection)
  values (v_profile_id, p_journey_id, v_reflection)
  on conflict (profile_id, journey_id) do update set reflection = excluded.reflection;
  insert into public.analytics_events (event_name, dedupe_key, profile_id, book_id)
  values ('journey_completed', 'journey:' || p_journey_id || ':' || v_profile_id || ':done', v_profile_id, v_book_id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

revoke execute on function public.mark_journey_session(uuid, integer) from public, anon;
grant execute on function public.mark_journey_session(uuid, integer) to authenticated;
revoke execute on function public.complete_journey(uuid, text) from public, anon;
grant execute on function public.complete_journey(uuid, text) to authenticated;
revoke execute on function public.journey_sessions_count() from public, anon, authenticated;

-- RLS ----------------------------------------------------------------------------------------

alter table public.reading_journeys enable row level security;
alter table public.journey_localizations enable row level security;
alter table public.journey_sessions enable row level security;
alter table public.journey_session_localizations enable row level security;
alter table public.journey_progress enable row level security;
alter table public.journey_completions enable row level security;

-- Browser roles hold SELECT only; every write is the service role (admin, behind requireAdmin) or
-- a definer RPC above.
revoke all on
  public.reading_journeys, public.journey_localizations, public.journey_sessions,
  public.journey_session_localizations, public.journey_progress, public.journey_completions
from public, anon, authenticated, service_role;
grant select on
  public.reading_journeys, public.journey_localizations, public.journey_sessions,
  public.journey_session_localizations
to anon, authenticated;
grant select on public.journey_progress, public.journey_completions to authenticated;
grant select, insert, update, delete on
  public.reading_journeys, public.journey_localizations, public.journey_sessions,
  public.journey_session_localizations, public.journey_progress, public.journey_completions
to service_role;

create policy "public read published journeys" on public.reading_journeys
  for select to anon, authenticated
  using (status = 'published');

create policy "public read published journey localizations" on public.journey_localizations
  for select to anon, authenticated
  using (exists (
    select 1 from public.reading_journeys j
    where j.id = journey_localizations.journey_id and j.status = 'published'
  ));

create policy "public read published journey sessions" on public.journey_sessions
  for select to anon, authenticated
  using (exists (
    select 1 from public.reading_journeys j
    where j.id = journey_sessions.journey_id and j.status = 'published'
  ));

create policy "public read published journey session localizations" on public.journey_session_localizations
  for select to anon, authenticated
  using (exists (
    select 1 from public.journey_sessions s
    join public.reading_journeys j on j.id = s.journey_id
    where s.id = journey_session_localizations.session_id and j.status = 'published'
  ));

create policy "owner reads journey progress" on public.journey_progress
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = journey_progress.profile_id and p.auth_user_id = (select auth.uid())));

create policy "owner reads journey completions" on public.journey_completions
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = journey_completions.profile_id and p.auth_user_id = (select auth.uid())));
