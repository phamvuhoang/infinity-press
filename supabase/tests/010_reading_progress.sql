begin;
select plan(25);

-- Task 10: save_reading_progress - the only write path to public.reading_progress a browser can
-- reach. Numbered 010, continuing from Task 8's 009_reader_sessions.sql.
--
-- This file carries a second job beyond covering the RPC: lib/reader/progress.ts's
-- reconcileProgress() is the unit-tested *specification* of the reconciliation rule, and the RPC
-- re-derives that rule in SQL because a security-definer function cannot call into TypeScript.
-- Sections (10)-(15) below are the cases where the two must agree. If the SQL and the TypeScript
-- ever drift apart, these are the assertions that fail.

-- ============================================================================================
-- Fixtures
-- ============================================================================================

-- Three readers: entitled, never entitled, and entitled-then-revoked. Kept separate so each
-- outcome below is unambiguous.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'ab000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'progress-entitled@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'ab000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'progress-unentitled@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'ab000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'progress-revoked@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved once as the unrestricted connecting role: "owner reads own profile" RLS means a later
-- subquery against public.profiles, evaluated after a scenario has switched role, would silently
-- read back no row rather than fail loud. Same guard 009_reader_sessions.sql uses.
create temporary table t_readers as
select
  (select id from public.profiles where auth_user_id = 'ab000000-0000-0000-0000-000000000001') as entitled_id,
  (select id from public.profiles where auth_user_id = 'ab000000-0000-0000-0000-000000000002') as unentitled_id,
  (select id from public.profiles where auth_user_id = 'ab000000-0000-0000-0000-000000000003') as revoked_id;
grant select on t_readers to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('ab000000-0000-0000-0000-000000000010', 'progress-author', 'Progress Author', 'published');

-- book_live is published with an active publication. book_unpublished is deliberately 'draft'
-- while carrying a 'published' publication that its own active pointer names - so the ONLY
-- failing condition for it is books.status, which is what test (19) isolates.
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('ab000000-0000-0000-0000-000000000020', 'progress-book-live', 'en', 'ab000000-0000-0000-0000-000000000010', 'published'),
  ('ab000000-0000-0000-0000-000000000021', 'progress-book-draft', 'en', 'ab000000-0000-0000-0000-000000000010', 'draft');

insert into public.book_localizations (book_id, locale, slug, title) values
  ('ab000000-0000-0000-0000-000000000020', 'en', 'progress-book-live', 'Progress Book'),
  ('ab000000-0000-0000-0000-000000000021', 'en', 'progress-book-draft', 'Progress Draft');

insert into public.editions (id, book_id, language_code) values
  ('ab000000-0000-0000-0000-000000000030', 'ab000000-0000-0000-0000-000000000020', 'en'),
  ('ab000000-0000-0000-0000-000000000031', 'ab000000-0000-0000-0000-000000000021', 'en');

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('ab000000-0000-0000-0000-000000000040', 'ab000000-0000-0000-0000-000000000030', 'ed/asset-v1/source.epub', 1, 'published'),
  ('ab000000-0000-0000-0000-000000000041', 'ab000000-0000-0000-0000-000000000031', 'ed2/asset-v1/source.epub', 1, 'published'),
  ('ab000000-0000-0000-0000-000000000042', 'ab000000-0000-0000-0000-000000000030', 'ed/asset-v2/source.epub', 2, 'superseded');

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('ab000000-0000-0000-0000-000000000050', 'ab000000-0000-0000-0000-000000000040', 1, 'ed/asset-v1/manifest.json', 'published'),
  ('ab000000-0000-0000-0000-000000000051', 'ab000000-0000-0000-0000-000000000041', 1, 'ed2/asset-v1/manifest.json', 'published'),
  ('ab000000-0000-0000-0000-000000000052', 'ab000000-0000-0000-0000-000000000042', 2, 'ed/asset-v2/manifest.json', 'superseded');

update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'ab000000-0000-0000-0000-000000000050' and (b.id = 'ab000000-0000-0000-0000-000000000020');
update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'ab000000-0000-0000-0000-000000000051' and (b.id = 'ab000000-0000-0000-0000-000000000021');

-- admin_grant rather than free_order so no order fixture is needed; the source consistency CHECK
-- requires an actor and a reason for this source type. The entitled reader also holds a grant on
-- the draft book, so test (19) fails on book status alone rather than on a missing entitlement.
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select entitled_id, 'ab000000-0000-0000-0000-000000000020', 'admin_grant', entitled_id, 'test fixture', 'active' from t_readers;
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select entitled_id, 'ab000000-0000-0000-0000-000000000021', 'admin_grant', entitled_id, 'test fixture', 'active' from t_readers;
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status, revoked_at)
select revoked_id, 'ab000000-0000-0000-0000-000000000020', 'admin_grant', revoked_id, 'test fixture', 'revoked', now() from t_readers;

-- ============================================================================================
-- (1)-(5) Grants and direct table privileges
--
-- Checked against the grant itself (Ruling AS): the function raises EB009 for an unauthorized
-- caller, so a live call could not distinguish "no grant" from "the guard refused me".
-- ============================================================================================
select is(has_function_privilege('anon', 'public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)', 'EXECUTE'), false, 'anon holds no EXECUTE on save_reading_progress');
select is(has_function_privilege('authenticated', 'public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)', 'EXECUTE'), true, 'authenticated holds EXECUTE on save_reading_progress');
-- service_role deliberately holds no EXECUTE: auth.uid() is null under it (Ruling W's trap), so
-- the grant could only ever be a permission that always fails.
select is(has_function_privilege('service_role', 'public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)', 'EXECUTE'), false, 'service_role holds no EXECUTE on save_reading_progress');

-- The reason this RPC has to exist at all: no browser role can insert the row itself, so a
-- reader's very first save of a book is unwritable through the user-session client.
select is(has_table_privilege('authenticated', 'public.reading_progress', 'INSERT'), false, 'authenticated cannot INSERT reading_progress directly');
select is(has_table_privilege('anon', 'public.reading_progress', 'SELECT'), false, 'anon cannot read reading_progress at all');

-- ============================================================================================
-- (6)-(9) The first save
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);

select lives_ok(
  $$select public.save_reading_progress(
      'ab000000-0000-0000-0000-000000000050',
      '{"href":"OEBPS/text/chapter2.xhtml","progression":0.375,"totalProgression":0.62,"locations":{"position":17,"fragment":"sec-3"}}'::jsonb,
      0.375, 0.375, 'device-a', 7)$$,
  'an entitled reader records progress for the active publication'
);
reset role;

select is(
  (select count(*) from public.reading_progress where publication_id = 'ab000000-0000-0000-0000-000000000050')::int,
  1,
  'exactly one reading_progress row exists after the first save'
);
select is(
  (select locator_json->>'href' from public.reading_progress where publication_id = 'ab000000-0000-0000-0000-000000000050'),
  'OEBPS/text/chapter2.xhtml',
  'the exact locator submitted is what got stored'
);
select is(
  (select client_sequence from public.reading_progress where publication_id = 'ab000000-0000-0000-0000-000000000050'),
  7::bigint,
  'the submitting device''s client_sequence is recorded'
);

-- ============================================================================================
-- (10)-(12) Same-device reconciliation: strictly greater client_sequence wins
--
-- reconcileProgress()'s "same-device-newer-sequence" / "same-device-stale-sequence" branches.
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"OEBPS/text/chapter3.xhtml","progression":0.5,"totalProgression":null,"locations":{}}'::jsonb, 0.5, 0.5, 'device-a', 9);
reset role;
select is(
  (select client_sequence from public.reading_progress where publication_id = 'ab000000-0000-0000-0000-000000000050'),
  9::bigint,
  'the same device with a greater client_sequence wins'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
-- Equal is refused as well as lower: the same sequence is the same position, and letting a retry
-- restamp updated_at would hand it a later cross-device comparison it has not earned.
select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"OEBPS/text/replay.xhtml","progression":0.5,"totalProgression":null,"locations":{}}'::jsonb, 0.5, 0.5, 'device-a', 9);
reset role;
select is(
  (select locator_json->>'href' from public.reading_progress where publication_id = 'ab000000-0000-0000-0000-000000000050'),
  'OEBPS/text/chapter3.xhtml',
  'the same device replaying an equal client_sequence does not overwrite'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"OEBPS/text/stale.xhtml","progression":0.1,"totalProgression":null,"locations":{}}'::jsonb, 0.1, 0.1, 'device-a', 2);
reset role;
select is(
  (select locator_json->>'href' from public.reading_progress where publication_id = 'ab000000-0000-0000-0000-000000000050'),
  'OEBPS/text/chapter3.xhtml',
  'a save that overtook an earlier one in flight does not overwrite newer progress'
);

-- ============================================================================================
-- (13) A refused save still returns the WINNING row
--
-- This is what lets the client reconcile to the server's actual position instead of being told
-- "saved" and carrying on from a position nothing holds.
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
select is(
  (select locator_json->>'href' from public.save_reading_progress(
     'ab000000-0000-0000-0000-000000000050',
     '{"href":"OEBPS/text/loser.xhtml","progression":0.1,"totalProgression":null,"locations":{}}'::jsonb,
     0.1, 0.1, 'device-a', 1)),
  'OEBPS/text/chapter3.xhtml',
  'a refused save returns the row that won, not the one submitted'
);
reset role;

-- ============================================================================================
-- (14)-(15) Cross-device reconciliation: only the SERVER clock orders two devices
--
-- reconcileProgress()'s "other-device-later-server-time" / "other-device-not-later" branches.
-- Note (14) uses client_sequence 1 - far below the stored 9 - proving a foreign device's
-- numbering is ignored entirely rather than compared.
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"OEBPS/text/phone.xhtml","progression":0.8,"totalProgression":null,"locations":{}}'::jsonb, 0.8, 0.8, 'device-b', 1);
reset role;
select is(
  (select device_id from public.reading_progress where publication_id = 'ab000000-0000-0000-0000-000000000050'),
  'device-b',
  'another device wins on a later server timestamp regardless of its own sequence numbering'
);

-- Force the stored row into the future so the next cross-device save is genuinely "not later".
-- The RPC stamps rows with clock_timestamp(), so every save in this transaction gets a distinct,
-- increasing time; pushing the stored row an hour ahead is what reaches the refusal branch.
update public.reading_progress set updated_at = now() + interval '1 hour'
where publication_id = 'ab000000-0000-0000-0000-000000000050';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"OEBPS/text/laptop.xhtml","progression":0.2,"totalProgression":null,"locations":{}}'::jsonb, 0.2, 0.2, 'device-c', 50);
reset role;
select is(
  (select locator_json->>'href' from public.reading_progress where publication_id = 'ab000000-0000-0000-0000-000000000050'),
  'OEBPS/text/phone.xhtml',
  'a cross-device save that is not strictly later does not overwrite newer progress'
);

update public.reading_progress set updated_at = now() - interval '1 minute'
where publication_id = 'ab000000-0000-0000-0000-000000000050';

-- ============================================================================================
-- (16)-(20) Denials - one SQLSTATE for every reason, so none is distinguishable from the others
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"a.xhtml","progression":0,"totalProgression":null,"locations":{}}'::jsonb, 0, 0, 'device-x', 1)$$,
  'EB009',
  null,
  'a reader with no entitlement cannot record progress'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"a.xhtml","progression":0,"totalProgression":null,"locations":{}}'::jsonb, 0, 0, 'device-x', 1)$$,
  'EB009',
  null,
  'a revoked entitlement stops progress writes on the very next save'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.save_reading_progress('ab000000-0000-0000-0000-000000000052', '{"href":"a.xhtml","progression":0,"totalProgression":null,"locations":{}}'::jsonb, 0, 0, 'device-x', 1)$$,
  'EB009',
  null,
  'a superseded publication accepts no progress, even from an entitled reader'
);
select throws_ok(
  $$select public.save_reading_progress('ab000000-0000-0000-0000-000000000051', '{"href":"a.xhtml","progression":0,"totalProgression":null,"locations":{}}'::jsonb, 0, 0, 'device-x', 1)$$,
  'EB009',
  null,
  'a publication whose book is not published accepts no progress'
);
select throws_ok(
  $$select public.save_reading_progress('ab000000-0000-0000-0000-0000000000ff', '{"href":"a.xhtml","progression":0,"totalProgression":null,"locations":{}}'::jsonb, 0, 0, 'device-x', 1)$$,
  'EB009',
  null,
  'a publication that does not exist is refused with the same code as one the caller cannot read'
);
reset role;

-- ============================================================================================
-- (21)-(22) Isolation: a save writes the caller's own row and nobody else's
-- ============================================================================================
select is(
  (select count(*) from public.reading_progress rp join t_readers r on rp.profile_id = r.unentitled_id)::int,
  0,
  'no reading_progress row was created for the unentitled reader'
);
select is(
  (select count(*) from public.reading_progress)::int,
  1,
  'every save in this file resolved to exactly one row, never a second for another profile'
);

-- ============================================================================================
-- (23)-(24) Input the RPC refuses before touching the table
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"a.xhtml","progression":0,"totalProgression":null,"locations":{}}'::jsonb, 0, 0, '', 1)$$,
  'EB009',
  null,
  'an empty device id is refused'
);
select throws_ok(
  $$select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"a.xhtml","progression":0,"totalProgression":null,"locations":{}}'::jsonb, 0, 0, 'device-a', -1)$$,
  'EB009',
  null,
  'a negative client_sequence is refused'
);

-- ============================================================================================
-- (25) The progression CHECK is still the backstop
--
-- lib/reader/engine.ts's PROGRESSION_EPSILON clamp exists so a real engine's last-page rounding
-- never reaches this constraint. The constraint is what makes that clamp load-bearing rather
-- than decorative - proven here rather than assumed.
--
-- p_total_progression is passed as null rather than duplicating 1.5: S4's own explicit range
-- guard on p_total_progression raises EB009 before the insert is ever attempted, which would
-- mask the column CHECK this test exists to prove. Keeping it in range isolates the two guards.
-- ============================================================================================
select throws_ok(
  $$select public.save_reading_progress('ab000000-0000-0000-0000-000000000050', '{"href":"a.xhtml","progression":0,"totalProgression":null,"locations":{}}'::jsonb, 1.5, null, 'device-a', 999)$$,
  '23514',
  null,
  'a progression outside [0, 1] is rejected by the column CHECK, not silently stored'
);
reset role;

select * from finish();
rollback;
