begin;
select plan(21);

-- S4: whole-book progression and the library state it drives
-- (docs/superpowers/specs/2026-09-16-s4-reader-completion-design.md 4.4).

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '70000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's4-reader-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '70000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's4-reader-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role: profiles RLS hides other readers' rows after a role switch.
create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '70000000-0000-0000-0000-000000000001') as a_id,
  (select id from public.profiles where auth_user_id = '70000000-0000-0000-0000-000000000002') as b_id;
grant select on t_ids to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('71000000-0000-0000-0000-000000000001', 's4-author', 'S4 Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('72000000-0000-0000-0000-000000000001', 's4-book', 'vi', '71000000-0000-0000-0000-000000000001', 'published');

insert into public.book_localizations (book_id, locale, slug, title)
values ('72000000-0000-0000-0000-000000000001', 'vi', 's4-sach', 'Sách S4');

insert into public.editions (id, book_id, language_code)
values ('73000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'vi');

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('74000000-0000-0000-0000-000000000001', '73000000-0000-0000-0000-000000000001', 's4/1.epub', 1, 'published');

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('75000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-000000000001', 1, 's4/1/manifest.json', 'published');

update public.books set active_publication_id = '75000000-0000-0000-0000-000000000001'
where id = '72000000-0000-0000-0000-000000000001';

-- Reader A owns the book and has it on their shelf. Reader B owns nothing.
-- admin_grant carries an actor and a reason, like every admin grant elsewhere in these tests.
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select '76000000-0000-0000-0000-000000000001', t_ids.a_id, '72000000-0000-0000-0000-000000000001', 'admin_grant', t_ids.a_id, 'Test fixture', 'active' from t_ids;
insert into public.library_items (profile_id, book_id, entitlement_id)
select t_ids.a_id, '72000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-000000000001' from t_ids;

-- Schema and privileges (1-4)
select has_column('public', 'reading_progress', 'total_progression', 'reading_progress carries whole-book progression');
select col_is_null('public', 'reading_progress', 'total_progression', 'rows written before this migration have none');
select is(has_function_privilege('anon', 'public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)', 'execute'), false, 'anon cannot save progress');
select is(has_table_privilege('authenticated', 'public.library_items', 'update'), false, 'readers cannot change their own library state directly');

-- A first save records both figures and moves the item to reading (5-7)
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c1.xhtml","progression":0.5,"totalProgression":0.1,"locations":{}}'::jsonb, 0.5, 0.1, 'device-a', 100) $$,
  'a first save is accepted'
);
reset role;

select results_eq(
  $$ select progression, total_progression from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id $$,
  $$ values (0.5::numeric, 0.1::numeric) $$,
  'both the per-resource and whole-book figures are stored'
);
select is(
  (select l.state::text from public.library_items l, t_ids where l.profile_id = t_ids.a_id),
  'reading',
  'a partial read moves the item to reading'
);

-- Crossing 0.99 completes it (8-10).
-- `select lives_ok($$ ... $$)` rather than a bare call: save_reading_progress returns a row set, and
-- emitting it into a pgTAP file's stdout would corrupt the TAP stream. plpgsql's `perform` is not
-- available here either - this file is plain SQL run by psql, not a function body.
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c9.xhtml","progression":0.99,"totalProgression":0.995,"locations":{}}'::jsonb, 0.99, 0.995, 'device-a', 200) $$,
  'a save near the end of the book is accepted'
);
reset role;

select is(
  (select l.state::text from public.library_items l, t_ids where l.profile_id = t_ids.a_id),
  'completed',
  'reaching 0.99 of the whole book completes the item'
);
select is(
  (select rp.total_progression from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id),
  0.995::numeric,
  'the whole-book figure is updated'
);

-- Paging back does not un-complete it (11-13)
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c2.xhtml","progression":0.2,"totalProgression":0.2,"locations":{}}'::jsonb, 0.2, 0.2, 'device-a', 300) $$,
  'paging back is accepted'
);
reset role;

select is(
  (select l.state::text from public.library_items l, t_ids where l.profile_id = t_ids.a_id),
  'completed',
  'a completed book stays completed when the reader pages back'
);
select is(
  (select rp.total_progression from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id),
  0.2::numeric,
  'the position itself still moves back'
);

-- A refused save changes nothing (14-16). Sequence 250 is lower than the stored 300 on the same
-- device, so reconciliation refuses it - and the call still succeeds, returning the winning row.
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c3.xhtml","progression":0.3,"totalProgression":0.3,"locations":{}}'::jsonb, 0.3, 0.3, 'device-a', 250) $$,
  'a stale save is refused without raising'
);
reset role;

select is(
  (select rp.total_progression from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id),
  0.2::numeric,
  'a stale save does not move the whole-book figure'
);
select is(
  (select rp.client_sequence from public.reading_progress rp, t_ids where rp.profile_id = t_ids.a_id),
  300::bigint,
  'a stale save does not win'
);

-- Null and out-of-range whole-book progression (17-18)
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c4.xhtml","progression":0.4,"totalProgression":null,"locations":{}}'::jsonb, 0.4, null, 'device-a', 400) $$,
  'a null whole-book progression is accepted - the engine may not report one'
);
select throws_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c5.xhtml","progression":0.5,"totalProgression":1.5,"locations":{}}'::jsonb, 0.5, 1.5, 'device-a', 500) $$,
  'EB009', null, 'a whole-book progression above 1 is refused'
);
reset role;

-- An unentitled reader writes nothing (19-20)
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c1.xhtml","progression":0.5,"totalProgression":0.5,"locations":{}}'::jsonb, 0.5, 0.5, 'device-b', 100) $$,
  'EB009', null, 'a reader without an entitlement cannot save'
);
reset role;
select is(
  (select count(*)::int from public.library_items l, t_ids where l.profile_id = t_ids.b_id),
  0,
  'a refused save creates no library row'
);

-- A reader with an entitlement but no library row is not broken by the update (21)
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select '76000000-0000-0000-0000-000000000002', t_ids.b_id, '72000000-0000-0000-0000-000000000001', 'admin_grant', t_ids.a_id, 'Test fixture', 'active' from t_ids;
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$ select public.save_reading_progress('75000000-0000-0000-0000-000000000001', '{"href":"c1.xhtml","progression":0.5,"totalProgression":0.5,"locations":{}}'::jsonb, 0.5, 0.5, 'device-b', 100) $$,
  'a save succeeds even when the reader has no library row to update'
);
reset role;

select * from finish();
rollback;
