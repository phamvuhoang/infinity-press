begin;
select plan(5);

-- S20 growth report: the three admin_growth_* functions refuse non-admins and windows outside
-- 1..365 days, and count fixture events; catalog_home_passage returns a qualifying aligned pair for
-- a book, or null.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'fa100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'gr-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'fa100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'gr-reader-1@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'fa100000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'gr-reader-2@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role) select id, 'admin' from public.profiles where auth_user_id = 'fa100000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status) values ('fa200000-0000-0000-0000-000000000001', 'gr-author', 'GR Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('fa300000-0000-0000-0000-000000000001', 'gr-book', 'vi', 'fa200000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code) values
  ('fa400000-0000-0000-0000-000000000001', 'fa300000-0000-0000-0000-000000000001', 'vi'),
  ('fa400000-0000-0000-0000-000000000002', 'fa300000-0000-0000-0000-000000000001', 'en');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('fa500000-0000-0000-0000-000000000001', 'fa400000-0000-0000-0000-000000000001', 'gr/vi.epub', 1, 'published'),
  ('fa500000-0000-0000-0000-000000000002', 'fa400000-0000-0000-0000-000000000002', 'gr/en.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('fa600000-0000-0000-0000-000000000001', 'fa500000-0000-0000-0000-000000000001', 1, 'gr/vi.json', 'published'),
  ('fa600000-0000-0000-0000-000000000002', 'fa500000-0000-0000-0000-000000000002', 1, 'gr/en.json', 'published');
update public.editions set active_publication_id = 'fa600000-0000-0000-0000-000000000001', status = 'published' where id = 'fa400000-0000-0000-0000-000000000001';
update public.editions set active_publication_id = 'fa600000-0000-0000-0000-000000000002', status = 'published' where id = 'fa400000-0000-0000-0000-000000000002';
insert into public.book_samples (publication_id, allowed_hrefs) values
  ('fa600000-0000-0000-0000-000000000001', '["*"]'),
  ('fa600000-0000-0000-0000-000000000002', '["*"]');
insert into public.ebook_search_chunks (id, publication_id, href, ordinal, plain_text, locator_json) values
  ('fa700000-0000-0000-0000-000000000001', 'fa600000-0000-0000-0000-000000000001', 'c1', 3, repeat('một ', 50), '{"href":"c1","progression":0,"totalProgression":0,"locations":{"position":1},"text":{"highlight":"x"}}'),
  ('fa700000-0000-0000-0000-000000000002', 'fa600000-0000-0000-0000-000000000002', 'c1', 4, repeat('one ', 50), '{"href":"c1","progression":0,"totalProgression":0,"locations":{"position":1},"text":{"highlight":"x"}}');

-- A shared passage for the share funnel.
insert into public.shared_quotes (id, code, book_id, publication_id, profile_id, quote, locale, chunk_ordinal)
select 'fa800000-0000-0000-0000-000000000001', 'grcode0001', 'fa300000-0000-0000-0000-000000000001', 'fa600000-0000-0000-0000-000000000001', id, 'Một câu.', 'vi', 3
from public.profiles where auth_user_id = 'fa100000-0000-0000-0000-000000000002';

-- Reader 1: first session 20 days ago, opens the reader 7 days later. Reader 2: same cohort day, opens
-- the reader only on day +5 and day +9, both outside the +6..+8 return window. An open_sample outside
-- a 30-day window does not count.
insert into public.analytics_events (event_name, profile_id, book_id, shared_quote_id, occurred_at)
select v.event_name, p.id, 'fa300000-0000-0000-0000-000000000001', v.quote::uuid, v.at
from (values
  ('fa100000-0000-0000-0000-000000000002'::uuid, 'open_sample', null, now() - interval '25 days'),
  ('fa100000-0000-0000-0000-000000000002', 'open_sample', null, now() - interval '40 days'),
  ('fa100000-0000-0000-0000-000000000002', 'session_completed', null, now() - interval '20 days'),
  ('fa100000-0000-0000-0000-000000000002', 'session_completed', null, now() - interval '19 days'),
  ('fa100000-0000-0000-0000-000000000002', 'open_reader', null, now() - interval '13 days'),
  ('fa100000-0000-0000-0000-000000000002', 'journey_completed', null, now() - interval '12 days'),
  ('fa100000-0000-0000-0000-000000000003', 'session_completed', null, now() - interval '20 days'),
  ('fa100000-0000-0000-0000-000000000003', 'open_reader', null, now() - interval '15 days'),
  ('fa100000-0000-0000-0000-000000000003', 'open_reader', null, now() - interval '11 days'),
  ('fa100000-0000-0000-0000-000000000002', 'passage_shared', 'fa800000-0000-0000-0000-000000000001', now() - interval '5 days'),
  ('fa100000-0000-0000-0000-000000000003', 'view_quote', 'fa800000-0000-0000-0000-000000000001', now() - interval '4 days'),
  ('fa100000-0000-0000-0000-000000000003', 'view_quote', 'fa800000-0000-0000-0000-000000000001', now() - interval '3 days'),
  ('fa100000-0000-0000-0000-000000000003', 'passage_opened', 'fa800000-0000-0000-0000-000000000001', now() - interval '3 days')
) as v(auth_id, event_name, quote, at)
join public.profiles p on p.auth_user_id = v.auth_id;

create temporary table t_refused (fn text, code text);
grant all on t_refused to public;
create function pg_temp.try_growth(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-000000000002', true);
insert into t_refused values
  ('funnel', pg_temp.try_growth('select * from public.admin_growth_funnel(30)')),
  ('retention', pg_temp.try_growth('select * from public.admin_growth_retention(30)')),
  ('share', pg_temp.try_growth('select * from public.admin_growth_share(30)'));
select set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-000000000001', true);
insert into t_refused values
  ('days 0', pg_temp.try_growth('select * from public.admin_growth_funnel(0)')),
  ('days 366', pg_temp.try_growth('select * from public.admin_growth_retention(366)')),
  ('days null', pg_temp.try_growth('select * from public.admin_growth_share(null)'));
reset role;
select is(
  (select array_agg(code order by fn) from t_refused),
  array['22023', '22023', '22023', '42501', '42501', '42501'],
  'non-admins are refused every growth report, and a window outside 1..365 days is refused');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-000000000001', true);
select results_eq(
  $$select open_sample, open_reader, session_completed_readers, journey_completed from public.admin_growth_funnel(30)
    where book_id = 'fa300000-0000-0000-0000-000000000001'$$,
  $$values (1::bigint, 2::bigint, 2::bigint, 1::bigint)$$,
  'the funnel counts one open_sample and one journey_completed in the window, readers distinct');
select results_eq(
  $$select activated, returned_d7 from public.admin_growth_retention(30)
    where cohort_day = ((now() - interval '20 days') at time zone 'UTC')::date$$,
  $$values (2::bigint, 1::bigint)$$,
  'retention cohorts by first session_completed, counts an open_reader 7 days later, and excludes day +5 and day +9');
select results_eq(
  $$select shared, opened, continued from public.admin_growth_share(30)$$,
  $$values (1::bigint, 1::bigint, 1::bigint)$$,
  'the share funnel counts one share, opened and continued once each');
reset role;

create temporary table t_passage (phase text, pair jsonb);
grant all on t_passage to public;
set local role anon;
insert into t_passage values ('none', public.catalog_home_passage('fa300000-0000-0000-0000-000000000001'));
reset role;
insert into public.passage_alignments (book_id, source_publication_id, target_publication_id, source_chunk_id, target_chunk_id, confidence) values
  ('fa300000-0000-0000-0000-000000000001', 'fa600000-0000-0000-0000-000000000001', 'fa600000-0000-0000-0000-000000000002', 'fa700000-0000-0000-0000-000000000001', 'fa700000-0000-0000-0000-000000000002', 1),
  ('fa300000-0000-0000-0000-000000000001', 'fa600000-0000-0000-0000-000000000002', 'fa600000-0000-0000-0000-000000000001', 'fa700000-0000-0000-0000-000000000002', 'fa700000-0000-0000-0000-000000000001', 1);
set local role anon;
insert into t_passage values ('pair', public.catalog_home_passage('fa300000-0000-0000-0000-000000000001'));
reset role;
select is(
  array[(select pair from t_passage where phase = 'none'),
        (select pair - 'sourceText' - 'targetText' from t_passage where phase = 'pair')],
  array[null, jsonb_build_object(
    'sourceLang', 'vi', 'sourceEditionId', 'fa400000-0000-0000-0000-000000000001', 'ordinal', 3,
    'targetLang', 'en', 'targetEditionId', 'fa400000-0000-0000-0000-000000000002', 'targetOrdinal', 4)],
  'catalog_home_passage is null without an alignment and returns the pair, original language first, once one qualifies');

select * from finish();
rollback;
