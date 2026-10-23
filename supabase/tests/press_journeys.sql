begin;
select plan(18);

-- S20 reading journeys (docs/superpowers/plans/2026-10-22-s20-minimal-reading-ux.md, Task 1).
-- Journeys are free: any signed-in reader may mark a session of a published journey. Progress and
-- completions are written only by the definer RPCs and read back by their owner only.

-- ============================================================================================
-- Fixtures
-- ============================================================================================

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e7400000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'journey-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e7400000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'journey-stranger@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved once as the connecting role: "owner reads own profile" RLS would hide other rows later.
create temporary table t_readers as
select (select id from public.profiles where auth_user_id = 'e7400000-0000-0000-0000-000000000001') as reader_id;
grant select on t_readers to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('e7400000-0000-0000-0000-000000000010', 'journey-author', 'Journey Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e7400000-0000-0000-0000-000000000020', 'journey-book', 'vi', 'e7400000-0000-0000-0000-000000000010', 'published');
insert into public.editions (id, book_id, language_code, status)
values ('e7400000-0000-0000-0000-000000000030', 'e7400000-0000-0000-0000-000000000020', 'vi', 'published');

insert into public.reading_journeys (id, book_id, edition_id, slug, status) values
  ('e7400000-0000-0000-0000-000000000040', 'e7400000-0000-0000-0000-000000000020', 'e7400000-0000-0000-0000-000000000030', 'journey-draft', 'draft'),
  ('e7400000-0000-0000-0000-000000000041', 'e7400000-0000-0000-0000-000000000020', 'e7400000-0000-0000-0000-000000000030', 'journey-published', 'published'),
  ('e7400000-0000-0000-0000-000000000042', 'e7400000-0000-0000-0000-000000000020', 'e7400000-0000-0000-0000-000000000030', 'journey-fresh', 'published');
insert into public.journey_sessions (journey_id, position, start_locator)
select j.id, p.position, '{"href":"OEBPS/text/ch1.xhtml","progression":0,"totalProgression":null,"locations":{}}'::jsonb
from (values ('e7400000-0000-0000-0000-000000000040'::uuid), ('e7400000-0000-0000-0000-000000000041'), ('e7400000-0000-0000-0000-000000000042')) j(id)
cross join generate_series(1, 3) p(position);

-- ============================================================================================
-- Objects
-- ============================================================================================
select has_table('public', 'reading_journeys', 'reading_journeys exists');
select has_table('public', 'journey_localizations', 'journey_localizations exists');
select has_table('public', 'journey_sessions', 'journey_sessions exists');
select has_table('public', 'journey_session_localizations', 'journey_session_localizations exists');
select has_table('public', 'journey_progress', 'journey_progress exists');
select has_table('public', 'journey_completions', 'journey_completions exists');
select has_function('public', 'mark_journey_session', array['uuid', 'integer'], 'mark_journey_session exists');
select has_function('public', 'complete_journey', array['uuid', 'text'], 'complete_journey exists');
select is(
  (select session_count from public.reading_journeys where id = 'e7400000-0000-0000-0000-000000000041'),
  3,
  'session_count follows the journey''s sessions'
);

-- ============================================================================================
-- Reader
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7400000-0000-0000-0000-000000000001', true);

select results_eq(
  $$select slug from public.reading_journeys where id in ('e7400000-0000-0000-0000-000000000040', 'e7400000-0000-0000-0000-000000000041')$$,
  $$values ('journey-published'::text)$$,
  'a reader sees the published journey and not the draft'
);
select lives_ok(
  $$select public.mark_journey_session('e7400000-0000-0000-0000-000000000041', 2)$$,
  'a reader marks a session of a published journey'
);
select public.mark_journey_session('e7400000-0000-0000-0000-000000000041', 2);
select is(
  (select count(*) from public.journey_progress where journey_id = 'e7400000-0000-0000-0000-000000000041')::int,
  1,
  'marking the same session twice keeps one progress row'
);
select throws_ok(
  $$select public.mark_journey_session('e7400000-0000-0000-0000-000000000040', 1)$$,
  'EB047', null,
  'a draft journey cannot be marked'
);
select throws_ok(
  $$select public.mark_journey_session('e7400000-0000-0000-0000-000000000041', 99)$$,
  'EB047', null,
  'a position the journey does not have cannot be marked'
);
select lives_ok(
  $$select public.complete_journey('e7400000-0000-0000-0000-000000000041', 'ok')$$,
  'a reader with a completed session completes the journey'
);
select throws_ok(
  $$select public.complete_journey('e7400000-0000-0000-0000-000000000042', '')$$,
  'EB047', null,
  'a journey with no completed session cannot be completed'
);
reset role;

-- analytics_events has no browser read policy; checked as the connecting role.
select results_eq(
  $$select event_name, count(*)::int from public.analytics_events
    where profile_id = (select reader_id from t_readers) and book_id = 'e7400000-0000-0000-0000-000000000020'
    group by event_name order by event_name$$,
  $$values ('journey_completed'::text, 1), ('session_completed'::text, 1)$$,
  'one session_completed and one journey_completed event for the reader'
);

-- ============================================================================================
-- Stranger
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7400000-0000-0000-0000-000000000002', true);
select is(
  (select count(*) from public.journey_progress)::int,
  0,
  'a stranger reads no one else''s journey progress'
);
reset role;

select * from finish();
rollback;
