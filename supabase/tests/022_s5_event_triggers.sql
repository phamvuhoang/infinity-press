begin;
select plan(32);

-- S5: database-owned product outcome events
-- (docs/superpowers/specs/2026-09-16-s5-seo-operations-design.md 8.1, 8.3).

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '90000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's5-events-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '90000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's5-events-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role: profiles RLS hides other readers' rows after a role switch.
create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '90000000-0000-0000-0000-000000000001') as admin_id,
  (select id from public.profiles where auth_user_id = '90000000-0000-0000-0000-000000000002') as reader_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

insert into public.authors (id, canonical_slug, display_name)
values ('91000000-0000-0000-0000-000000000001', 's5-events-author', 'S5 Events Author');
insert into public.author_localizations (author_id, locale, slug, name)
values ('91000000-0000-0000-0000-000000000001', 'vi', 's5-events-tac-gia', 'S5 Events Author');

-- Book A: already published directly (like 020_reader_completion.sql), so save_reading_progress
-- has a real progress target and the progress trigger has a real reading_progress row to fire on.
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('92000000-0000-0000-0000-00000000000a', 's5-events-book-a', 'vi', '91000000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values ('92000000-0000-0000-0000-00000000000a', 'vi', 's5-events-sach-a', 'Sach S5 Events A');
insert into public.editions (id, book_id, language_code)
values ('93000000-0000-0000-0000-00000000000a', '92000000-0000-0000-0000-00000000000a', 'vi');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('94000000-0000-0000-0000-00000000000a', '93000000-0000-0000-0000-00000000000a', 's5-events/a/1.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language)
values ('95000000-0000-0000-0000-00000000000a', '94000000-0000-0000-0000-00000000000a', 1, 's5-events/a/1/manifest.json', 'published', 'vi');
update public.books set active_publication_id = '95000000-0000-0000-0000-00000000000a'
where id = '92000000-0000-0000-0000-00000000000a';
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select '96000000-0000-0000-0000-00000000000a', t_ids.reader_id, '92000000-0000-0000-0000-00000000000a', 'admin_grant', t_ids.admin_id, 'Test fixture', 'active'
from t_ids;

-- Book B: left in draft, with every readiness piece so publish_book can be called for real
-- inside this test (book_readiness_issues, 20260913150000_catalog_admin_review_fixes.sql).
insert into public.books (id, canonical_key, original_language, primary_author_id)
values ('92000000-0000-0000-0000-00000000000b', 's5-events-book-b', 'vi', '91000000-0000-0000-0000-000000000001');
insert into public.book_localizations (book_id, locale, slug, title, description)
values ('92000000-0000-0000-0000-00000000000b', 'vi', 's5-events-sach-b', 'Sach S5 Events B', 'Complete description.');
insert into public.editions (id, book_id, language_code)
values ('93000000-0000-0000-0000-00000000000b', '92000000-0000-0000-0000-00000000000b', 'vi');
insert into public.skus (id, edition_id, sku_code)
values ('97000000-0000-0000-0000-00000000000b', '93000000-0000-0000-0000-00000000000b', 's5-events-book-b-ebook');
insert into public.offers (sku_id, market_code, currency, price_minor)
values ('97000000-0000-0000-0000-00000000000b', 'VN', 'VND', 0);
insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
values ('book', '92000000-0000-0000-0000-00000000000b', 'cover', 'books/92000000-0000-0000-0000-00000000000b/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', 'Cover');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('94000000-0000-0000-0000-00000000000b', '93000000-0000-0000-0000-00000000000b', 's5-events/b/1.epub', 1, 'ready_for_preview');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language)
values ('95000000-0000-0000-0000-00000000000b', '94000000-0000-0000-0000-00000000000b', 1, 's5-events/b/1/manifest.json', 'ready_for_preview', 'vi');

-- Book C: never published or made ready - only its edition and two ebook_assets exist, as
-- processing_jobs targets for the EPUB job trigger. This models a book still mid-processing.
insert into public.books (id, canonical_key, original_language, primary_author_id)
values ('92000000-0000-0000-0000-00000000000c', 's5-events-book-c', 'vi', '91000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code)
values ('93000000-0000-0000-0000-00000000000c', '92000000-0000-0000-0000-00000000000c', 'vi');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('94000000-0000-0000-0000-00000000000c', '93000000-0000-0000-0000-00000000000c', 's5-events/c/1.epub', 1, 'uploading');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('94000000-0000-0000-0000-00000000000d', '93000000-0000-0000-0000-00000000000c', 's5-events/c/2.epub', 2, 'uploading');

-- Trigger contract (1-3)
select has_trigger('public', 'reading_progress', 'reading_progress_milestone_events', 'the progress milestone trigger exists');
select has_trigger('public', 'audit_logs', 'audit_logs_book_published_events', 'the book_published trigger exists');
select has_trigger('public', 'processing_jobs', 'processing_jobs_epub_events', 'the EPUB job trigger exists');

-- A save that crosses no threshold emits nothing (4)
-- Press: a publication goes live only for an editorially approved edition.
update public.editions set editorial_state = 'approved', reviewed_at = now(),
  reviewed_by = (select id from public.profiles order by created_at limit 1);

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$ select public.save_reading_progress('95000000-0000-0000-0000-00000000000a', '{"href":"c1.xhtml","progression":0.1,"totalProgression":0.1,"locations":{}}'::jsonb, 0.1, 0.1, 'device-a', 100) $$,
  'a first save below every threshold is accepted'
);
reset role;
select is(
  (select count(*)::int from public.analytics_events ae, t_ids
   where ae.profile_id = t_ids.reader_id and ae.publication_id = '95000000-0000-0000-0000-00000000000a'),
  0,
  'a save below 0.25 crosses no milestone'
);

-- A winning save from 0.10 to 0.76 emits 25, 50, and 75 once (5-8)
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$ select public.save_reading_progress('95000000-0000-0000-0000-00000000000a', '{"href":"c2.xhtml","progression":0.76,"totalProgression":0.76,"locations":{}}'::jsonb, 0.76, 0.76, 'device-a', 200) $$,
  'a winning save from 0.10 to 0.76 is accepted'
);
reset role;
select results_eq(
  $$ select ae.event_name::text, ae.dedupe_key from public.analytics_events ae, t_ids
     where ae.profile_id = t_ids.reader_id and ae.publication_id = '95000000-0000-0000-0000-00000000000a'
     order by ae.event_name $$,
  $$ values
      ('progress_25', 'progress/' || (select reader_id::text from t_ids) || '/95000000-0000-0000-0000-00000000000a/25'),
      ('progress_50', 'progress/' || (select reader_id::text from t_ids) || '/95000000-0000-0000-0000-00000000000a/50'),
      ('progress_75', 'progress/' || (select reader_id::text from t_ids) || '/95000000-0000-0000-0000-00000000000a/75')
  $$,
  'crossing 0.10 to 0.76 in one save emits 25, 50, and 75 exactly once each'
);
select is(
  (select ae.book_id from public.analytics_events ae, t_ids
   where ae.profile_id = t_ids.reader_id and ae.publication_id = '95000000-0000-0000-0000-00000000000a' and ae.event_name = 'progress_25'),
  '92000000-0000-0000-0000-00000000000a'::uuid,
  'the milestone event carries the book id derived from the publication'
);

-- A stale save creates no milestone (spec 13.1). It must carry a value that WOULD cross a new
-- threshold (0.99, which would emit progress_100) if wrongly accepted, or a test that merely
-- repeats an already-crossed value (like the old 0.3 here) can never actually detect a broken
-- refusal - the count assertion would hold even if save_reading_progress wrongly accepted the
-- write, since 0.3 crosses nothing new either way. client_sequence 150 is lower than the
-- winning save's 200 on the same device, so save_reading_progress's own reconciliation refuses
-- it (9-11)
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$ select public.save_reading_progress('95000000-0000-0000-0000-00000000000a', '{"href":"c1.xhtml","progression":0.99,"totalProgression":0.99,"locations":{}}'::jsonb, 0.99, 0.99, 'device-a', 150) $$,
  'a stale save (lower client_sequence on the same device) is refused without raising'
);
reset role;
select is(
  (select count(*)::int from public.analytics_events ae, t_ids
   where ae.profile_id = t_ids.reader_id and ae.publication_id = '95000000-0000-0000-0000-00000000000a' and ae.event_name = 'progress_100'),
  0,
  'a stale save that would have crossed 0.99 creates no progress_100 event'
);
select is(
  (select rp.total_progression from public.reading_progress rp, t_ids
   where rp.profile_id = t_ids.reader_id and rp.publication_id = '95000000-0000-0000-0000-00000000000a'),
  0.76::numeric,
  'the stale save does not move the stored whole-book figure off the winning 0.76'
);

-- The real winning save to 0.99 emits progress_100 once, and the running total is exactly four
-- events (25, 50, 75, 100) - proving the stale save above truly added nothing (12-14)
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$ select public.save_reading_progress('95000000-0000-0000-0000-00000000000a', '{"href":"c9.xhtml","progression":0.99,"totalProgression":0.99,"locations":{}}'::jsonb, 0.99, 0.99, 'device-a', 300) $$,
  'a winning save reaching 0.99 is accepted'
);
reset role;
select is(
  (select count(*)::int from public.analytics_events ae, t_ids
   where ae.profile_id = t_ids.reader_id and ae.publication_id = '95000000-0000-0000-0000-00000000000a' and ae.event_name = 'progress_100'),
  1,
  'reaching 0.99 emits progress_100 once'
);
select is(
  (select count(*)::int from public.analytics_events ae, t_ids
   where ae.profile_id = t_ids.reader_id and ae.publication_id = '95000000-0000-0000-0000-00000000000a'),
  4,
  'exactly four milestone events exist in total: 25, 50, 75, and 100'
);

-- Paging back below 0.25 and forward past it again re-crosses progress_25's threshold
-- arithmetic, but the partial unique dedupe index
-- (on conflict (dedupe_key) where dedupe_key is not null do nothing) suppresses the second
-- insert attempt - proving dedupe holds at the storage layer, not only via the trigger's own
-- threshold-crossing condition (15-18)
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$ select public.save_reading_progress('95000000-0000-0000-0000-00000000000a', '{"href":"c2.xhtml","progression":0.15,"totalProgression":0.15,"locations":{}}'::jsonb, 0.15, 0.15, 'device-a', 400) $$,
  'paging back below 0.25 is accepted'
);
select lives_ok(
  $$ select public.save_reading_progress('95000000-0000-0000-0000-00000000000a', '{"href":"c3.xhtml","progression":0.3,"totalProgression":0.3,"locations":{}}'::jsonb, 0.3, 0.3, 'device-a', 500) $$,
  're-crossing 0.25 after paging back is accepted'
);
reset role;
select is(
  (select count(*)::int from public.analytics_events ae, t_ids
   where ae.profile_id = t_ids.reader_id and ae.publication_id = '95000000-0000-0000-0000-00000000000a' and ae.event_name = 'progress_25'),
  1,
  're-crossing 0.25 after paging back does not duplicate the progress_25 event'
);
select is(
  (select count(*)::int from public.analytics_events ae, t_ids
   where ae.profile_id = t_ids.reader_id and ae.publication_id = '95000000-0000-0000-0000-00000000000a'),
  4,
  'the total milestone event count is unchanged by the re-cross'
);

-- One publish_book audit row emits one book_published event keyed by audit ID (12-15)
select is(
  (select count(*)::int from public.analytics_events where event_name = 'book_published'),
  0,
  'no book_published event exists before any book is published'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.publish_publication('95000000-0000-0000-0000-00000000000b')$$, 'admin publishes the EPUB version for book B');
select lives_ok($$select public.publish_book('92000000-0000-0000-0000-00000000000b')$$, 'admin publishes the now-ready book B');
reset role;
select is(
  (select count(*)::int from public.audit_logs where action = 'publish_book' and entity_type = 'books' and entity_id = '92000000-0000-0000-0000-00000000000b'),
  1,
  'publish_book writes exactly one audit row'
);
select is(
  (select count(*)::int from public.analytics_events ae
   join public.audit_logs al on al.action = 'publish_book' and al.entity_type = 'books' and al.entity_id = '92000000-0000-0000-0000-00000000000b'
   where ae.event_name = 'book_published'
     and ae.book_id = '92000000-0000-0000-0000-00000000000b'
     and ae.dedupe_key = 'publish/' || al.id::text),
  1,
  'the publish_book audit row produces exactly one book_published event keyed by the audit row id'
);

-- queued -> processing emits epub_job_started (16)
insert into public.processing_jobs (id, target_id, status, correlation_id)
values ('98000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-00000000000c', 'queued', 's5-events-corr-1');
update public.processing_jobs set status = 'processing', attempt = 1 where id = '98000000-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.analytics_events
   where event_name = 'epub_job_started'
     and processing_job_id = '98000000-0000-0000-0000-000000000001'
     and dedupe_key = 'epub/98000000-0000-0000-0000-000000000001/1/started'
     and book_id = '92000000-0000-0000-0000-00000000000c'),
  1,
  'queued -> processing emits one epub_job_started event with the derived book id'
);

-- processing -> completed emits epub_job_completed (17)
update public.processing_jobs set status = 'completed' where id = '98000000-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.analytics_events
   where event_name = 'epub_job_completed'
     and processing_job_id = '98000000-0000-0000-0000-000000000001'
     and dedupe_key = 'epub/98000000-0000-0000-0000-000000000001/1/completed'),
  1,
  'processing -> completed emits one epub_job_completed event'
);

-- Updating unrelated job columns emits no event (18)
update public.processing_jobs set correlation_id = 's5-events-corr-1-updated' where id = '98000000-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.analytics_events where processing_job_id = '98000000-0000-0000-0000-000000000001'),
  2,
  'updating an unrelated column on a job emits no additional event'
);

-- retry attempt 2 -> failed emits a distinct epub_job_failed row (19-21)
insert into public.processing_jobs (id, target_id, status, correlation_id)
values ('98000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-00000000000d', 'queued', 's5-events-corr-2');
update public.processing_jobs set status = 'processing', attempt = 1 where id = '98000000-0000-0000-0000-000000000002';
update public.processing_jobs set status = 'failed' where id = '98000000-0000-0000-0000-000000000002';
select is(
  (select count(*)::int from public.analytics_events
   where event_name = 'epub_job_failed' and processing_job_id = '98000000-0000-0000-0000-000000000002'),
  1,
  'the first failed attempt emits one epub_job_failed event'
);
update public.processing_jobs set status = 'processing', attempt = 2 where id = '98000000-0000-0000-0000-000000000002';
update public.processing_jobs set status = 'failed' where id = '98000000-0000-0000-0000-000000000002';
select is(
  (select count(*)::int from public.analytics_events
   where event_name = 'epub_job_failed' and processing_job_id = '98000000-0000-0000-0000-000000000002'),
  2,
  'retrying and failing again (attempt 2) emits a second, distinct epub_job_failed event'
);
select is(
  (select count(distinct dedupe_key)::int from public.analytics_events
   where event_name = 'epub_job_failed' and processing_job_id = '98000000-0000-0000-0000-000000000002'),
  2,
  'the two failed-attempt events carry distinct dedupe keys'
);

-- Ruling R10: an expired-lease reclaim (claim_processing_job,
-- 20260911170000_processing_job_rpcs.sql) moves an already-'processing' job from processing to
-- processing while incrementing attempt - a real new attempt starting, not a no-op - so it emits
-- a second, distinct epub_job_started keyed by the new attempt (23-24)
insert into public.processing_jobs (id, target_id, status, correlation_id)
values ('98000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-00000000000c', 'queued', 's5-events-corr-3');
update public.processing_jobs set status = 'processing', attempt = 1 where id = '98000000-0000-0000-0000-000000000003';
update public.processing_jobs set status = 'processing', attempt = 2 where id = '98000000-0000-0000-0000-000000000003';
select is(
  (select count(*)::int from public.analytics_events
   where event_name = 'epub_job_started' and processing_job_id = '98000000-0000-0000-0000-000000000003'),
  2,
  'an expired-lease reclaim (processing -> processing, attempt+1) emits a second epub_job_started for the new attempt'
);
select is(
  (select count(distinct dedupe_key)::int from public.analytics_events
   where event_name = 'epub_job_started' and processing_job_id = '98000000-0000-0000-0000-000000000003'),
  2,
  'the two started events for the reclaimed job carry distinct dedupe keys, one per attempt'
);

-- An unrelated column update on that same (twice-started) job still emits nothing - the trigger's
-- WHEN clause depends on status and attempt actually changing, not on any column being touched
-- (25)
update public.processing_jobs set lease_owner = 'worker-unrelated' where id = '98000000-0000-0000-0000-000000000003';
select is(
  (select count(*)::int from public.analytics_events where processing_job_id = '98000000-0000-0000-0000-000000000003'),
  2,
  'updating an unrelated column after a reclaim emits no additional event'
);

select * from finish();
rollback;
