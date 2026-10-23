-- S20 growth report (/admin/growth) and the homepage's bilingual passage.
--
-- The admin_growth_* functions read analytics_events only, which has identifier columns and no
-- text. Each returns raw integer counts with the denominators beside them; the page decides how to
-- show a ratio, and nothing here judges a number good or bad. Windows are p_days back from now(),
-- 1..365. Days are UTC dates.

-- Shared gate: admin only, and a bounded window. Not callable by any browser role.
create function public.growth_report_guard(p_name text, p_days integer)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '%: caller is not an admin', p_name using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 365 then
    raise exception '%: p_days must be between 1 and 365', p_name using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.growth_report_guard(text, integer) from public, anon, authenticated;

-- Per book, inside the window: sample opens (events: anonymous visitors have no profile), and
-- distinct readers who opened the reader, completed a journey session, and completed a journey.
create function public.admin_growth_funnel(p_days integer)
returns table (book_id uuid, open_sample bigint, open_reader bigint, session_completed_readers bigint, journey_completed bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.growth_report_guard('admin_growth_funnel', p_days);
  return query
  select e.book_id,
    count(*) filter (where e.event_name = 'open_sample'),
    count(distinct e.profile_id) filter (where e.event_name = 'open_reader'),
    count(distinct e.profile_id) filter (where e.event_name = 'session_completed'),
    count(distinct e.profile_id) filter (where e.event_name = 'journey_completed')
  from public.analytics_events e
  where e.book_id is not null
    and e.event_name in ('open_sample', 'open_reader', 'session_completed', 'journey_completed')
    and e.occurred_at >= now() - make_interval(days => p_days)
  group by e.book_id
  order by e.book_id;
end;
$$;
revoke all on function public.admin_growth_funnel(integer) from public, anon;
grant execute on function public.admin_growth_funnel(integer) to authenticated, service_role;

-- One cohort per UTC day: the readers whose FIRST session_completed ever fell on that day (within
-- the window), and how many of them opened the reader 6..8 days later. A cohort younger than 8 days
-- is still open, so its returned_d7 can only grow.
create function public.admin_growth_retention(p_days integer)
returns table (cohort_day date, activated bigint, returned_d7 bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.growth_report_guard('admin_growth_retention', p_days);
  return query
  with firsts as (
    select e.profile_id, min((e.occurred_at at time zone 'UTC')::date) as day
    from public.analytics_events e
    where e.event_name = 'session_completed' and e.profile_id is not null
    group by e.profile_id
  )
  select f.day,
    count(*),
    count(*) filter (where exists (
      select 1 from public.analytics_events r
      where r.event_name = 'open_reader' and r.profile_id = f.profile_id
        and (r.occurred_at at time zone 'UTC')::date between f.day + 6 and f.day + 8))
  from firsts f
  where f.day >= (now() at time zone 'UTC')::date - p_days
  group by f.day
  order by f.day;
end;
$$;
revoke all on function public.admin_growth_retention(integer) from public, anon;
grant execute on function public.admin_growth_retention(integer) to authenticated, service_role;

-- Passages shared inside the window (passage_shared), how many of those cards were opened
-- (view_quote), and how many led a visitor on into the book (passage_opened). Each step counts
-- shared quotes, so opened and continued never exceed shared.
create function public.admin_growth_share(p_days integer)
returns table (shared bigint, opened bigint, continued bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_since timestamptz;
begin
  perform public.growth_report_guard('admin_growth_share', p_days);
  v_since := now() - make_interval(days => p_days);
  return query
  with s as (
    select distinct e.shared_quote_id as id
    from public.analytics_events e
    where e.event_name = 'passage_shared' and e.shared_quote_id is not null and e.occurred_at >= v_since
  )
  select count(*),
    count(*) filter (where exists (select 1 from public.analytics_events v
      where v.event_name = 'view_quote' and v.shared_quote_id = s.id and v.occurred_at >= v_since)),
    count(*) filter (where exists (select 1 from public.analytics_events v
      where v.event_name = 'passage_opened' and v.shared_quote_id = s.id and v.occurred_at >= v_since))
  from s;
end;
$$;
revoke all on function public.admin_growth_share(integer) from public, anon;
grant execute on function public.admin_growth_share(integer) to authenticated, service_role;

-- Public: the homepage's bilingual passage for a book (the page passes its featured book). The first
-- exact (confidence 1) aligned pair whose two texts are 120..400 characters, both from the live
-- publication of a sellable edition, and both inside their edition's sample (sample_chunk_locator),
-- so the homepage never shows paid text and each side opens in the sample reader. The book's
-- original language is preferred as the source side. Null when nothing qualifies.
create function public.catalog_home_passage(p_book_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sourceText', s.plain_text, 'sourceLang', sed.language_code, 'sourceEditionId', sed.id, 'ordinal', s.ordinal,
    'targetText', t.plain_text, 'targetLang', ted.language_code, 'targetEditionId', ted.id, 'targetOrdinal', t.ordinal)
  from public.passage_alignments pa
  join public.books b on b.id = pa.book_id
  join public.ebook_search_chunks s on s.id = pa.source_chunk_id
  join public.ebook_search_chunks t on t.id = pa.target_chunk_id
  join public.editions sed on sed.active_publication_id = pa.source_publication_id
  join public.editions ted on ted.active_publication_id = pa.target_publication_id
  where pa.book_id = p_book_id
    and pa.confidence = 1
    and char_length(s.plain_text) between 120 and 400
    and char_length(t.plain_text) between 120 and 400
    and public.edition_is_sellable(sed.id)
    and public.edition_is_sellable(ted.id)
    and public.sample_chunk_locator(pa.source_publication_id, s.ordinal) is not null
    and public.sample_chunk_locator(pa.target_publication_id, t.ordinal) is not null
  order by (sed.language_code = b.original_language) desc, s.ordinal, sed.language_code, ted.language_code
  limit 1;
$$;
revoke all on function public.catalog_home_passage(uuid) from public;
grant execute on function public.catalog_home_passage(uuid) to anon, authenticated, service_role;
