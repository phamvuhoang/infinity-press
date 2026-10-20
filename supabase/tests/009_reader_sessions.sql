begin;
select plan(30);

-- Task 8: create_reader_session, authorize_reader_session, and the cover-only media_assets read.
-- Numbered 009, continuing from Task 7's 008_entitlements.sql.

-- ============================================================================================
-- Fixtures
-- ============================================================================================

-- Three readers: one entitled, one with no entitlement at all, and one whose entitlement was
-- revoked after it was granted. Kept separate so each scenario's outcome is unambiguous.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a8000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'reader-entitled@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a8000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'reader-unentitled@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a8000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'reader-revoked@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved once as the unrestricted connecting role: "owner reads own profile" RLS means a later
-- subquery against public.profiles, evaluated after a scenario has switched to a different
-- authenticated user, would silently read back no row rather than fail loud.
create temporary table t_readers as
select
  (select id from public.profiles where auth_user_id = 'a8000000-0000-0000-0000-000000000001') as entitled_id,
  (select id from public.profiles where auth_user_id = 'a8000000-0000-0000-0000-000000000002') as unentitled_id,
  (select id from public.profiles where auth_user_id = 'a8000000-0000-0000-0000-000000000003') as revoked_id;
grant select on t_readers to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('a8000000-0000-0000-0000-000000000010', 'reader-author', 'Reader Author', 'published');

-- book_live is published with an active publication; book_draft stays 'draft' so the cover
-- policy below has a negative case to prove against.
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('a8000000-0000-0000-0000-000000000020', 'reader-book-live', 'en', 'a8000000-0000-0000-0000-000000000010', 'published'),
  ('a8000000-0000-0000-0000-000000000021', 'reader-book-draft', 'en', 'a8000000-0000-0000-0000-000000000010', 'draft');

insert into public.book_localizations (book_id, locale, slug, title) values
  ('a8000000-0000-0000-0000-000000000020', 'en', 'reader-book-live', 'Reader Book');

insert into public.editions (id, book_id, language_code) values
  ('a8000000-0000-0000-0000-000000000030', 'a8000000-0000-0000-0000-000000000020', 'en');

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('a8000000-0000-0000-0000-000000000040', 'a8000000-0000-0000-0000-000000000030', 'ed/asset-v1/source.epub', 1, 'published');

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('a8000000-0000-0000-0000-000000000050', 'a8000000-0000-0000-0000-000000000040', 1, 'ed/asset-v1/manifest.json', 'published');

update public.books
set active_publication_id = 'a8000000-0000-0000-0000-000000000050'
where id = 'a8000000-0000-0000-0000-000000000020';

insert into public.ebook_resources (publication_id, href, media_type, storage_key, byte_size, sha256, access_class) values
  ('a8000000-0000-0000-0000-000000000050', 'OEBPS/text/chapter1.xhtml', 'application/xhtml+xml', 'ed/asset-v1/OEBPS/text/chapter1.xhtml', 100, 'sha1', 'sample'),
  ('a8000000-0000-0000-0000-000000000050', 'OEBPS/text/chapter9.xhtml', 'application/xhtml+xml', 'ed/asset-v1/OEBPS/text/chapter9.xhtml', 100, 'sha9', 'paid');

insert into public.book_samples (publication_id, allowed_hrefs) values
  ('a8000000-0000-0000-0000-000000000050', '["OEBPS/text/chapter1.xhtml"]'::jsonb);

insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text) values
  ('book', 'a8000000-0000-0000-0000-000000000020', 'cover', 'covers/live.jpg', 'Reader Book cover'),
  ('book', 'a8000000-0000-0000-0000-000000000021', 'cover', 'covers/draft.jpg', 'Draft cover');

-- admin_grant rather than free_order so no order/order_item fixture is needed; the source
-- consistency CHECK requires an actor and a reason for this source type.
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select entitled_id, 'a8000000-0000-0000-0000-000000000020', 'admin_grant', entitled_id, 'test fixture', 'active' from t_readers;

insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status, revoked_at)
select revoked_id, 'a8000000-0000-0000-0000-000000000020', 'admin_grant', revoked_id, 'test fixture', 'revoked', now() from t_readers;

-- ============================================================================================
-- (1)-(6) Grants. Checked against the grant itself (Ruling AS): both functions raise or return
-- empty for an unauthorized caller, so a live call could not distinguish "no grant" from "the
-- function refused me".
-- ============================================================================================
select is(has_function_privilege('anon', 'public.create_reader_session(uuid, integer)', 'EXECUTE'), false, 'anon holds no EXECUTE on create_reader_session');
select is(has_function_privilege('authenticated', 'public.create_reader_session(uuid, integer)', 'EXECUTE'), true, 'authenticated holds EXECUTE on create_reader_session');
select is(has_function_privilege('anon', 'public.authorize_reader_session(uuid, uuid)', 'EXECUTE'), false, 'anon holds no EXECUTE on authorize_reader_session');
select is(has_function_privilege('authenticated', 'public.authorize_reader_session(uuid, uuid)', 'EXECUTE'), true, 'authenticated holds EXECUTE on authorize_reader_session');

-- reader_sessions stays writable only through the RPC: no browser role may insert one directly,
-- which is what stops a reader minting a session with an expiry or profile of their choosing.
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'reader_sessions'
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')$$,
  'no browser role may write reader_sessions directly'
);
select is(has_table_privilege('service_role', 'public.reader_sessions', 'INSERT'), true, 'service_role retains INSERT on reader_sessions');

-- ============================================================================================
-- (7)-(13) create_reader_session
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000001', true);

create temporary table t_session as
select * from public.create_reader_session('a8000000-0000-0000-0000-000000000050', 900);

select isnt((select id from t_session), null, 'an entitled reader receives a session id');
select is((select publication_version from t_session), 1, 'the session pins the publication version it was minted against');

-- Server-derived lifetime, clamped in SQL. The application already validates
-- READER_SESSION_TTL_SECONDS to 60-3600, but an authenticated user can call this RPC directly
-- through PostgREST with any value - the clamp, not the application, is what enforces the ceiling.
create temporary table t_session_long as
select * from public.create_reader_session('a8000000-0000-0000-0000-000000000050', 999999);
select ok(
  (select expires_at from t_session_long) <= now() + interval '3600 seconds',
  'an oversized caller-supplied TTL is clamped down to the one-hour ceiling'
);

create temporary table t_session_short as
select * from public.create_reader_session('a8000000-0000-0000-0000-000000000050', 1);
select ok(
  (select expires_at from t_session_short) >= now() + interval '59 seconds',
  'an undersized caller-supplied TTL is clamped up to the sixty-second floor'
);

-- A publication that does not exist and one the caller is not entitled to raise the SAME code,
-- so the error itself cannot be used to confirm a publication exists.
select throws_ok(
  $$select * from public.create_reader_session('a8000000-0000-0000-0000-0000000000ff', 900)$$,
  'EB008', null,
  'a publication that does not exist is refused with EB008'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select * from public.create_reader_session('a8000000-0000-0000-0000-000000000050', 900)$$,
  'EB008', null,
  'a reader with no entitlement is refused with the same EB008 a missing publication gives'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select * from public.create_reader_session('a8000000-0000-0000-0000-000000000050', 900)$$,
  'EB008', null,
  'a reader whose entitlement was revoked is refused'
);
reset role;

-- ============================================================================================
-- (14)-(21) authorize_reader_session: the per-request recheck
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000001', true);

select is(
  (select count(*) from public.authorize_reader_session((select id from t_session), 'a8000000-0000-0000-0000-000000000050'))::int,
  1,
  'a live session for an entitled reader authorizes its own publication'
);

-- Scoping: the session is tied to one publication, so presenting it against another resolves
-- nothing rather than falling back to the publication it was minted for.
select is(
  (select count(*) from public.authorize_reader_session((select id from t_session), 'a8000000-0000-0000-0000-0000000000ff'))::int,
  0,
  'a session presented against a different publication authorizes nothing'
);

select is(
  (select count(*) from public.authorize_reader_session('a8000000-0000-0000-0000-0000000000aa', 'a8000000-0000-0000-0000-000000000050'))::int,
  0,
  'a session id that does not exist authorizes nothing'
);

reset role;

-- Expired and revoked sessions, inserted directly as the elevated role so their state is exact.
insert into public.reader_sessions (id, profile_id, publication_id, publication_version, expires_at)
select 'a8000000-0000-0000-0000-0000000000b1', entitled_id, 'a8000000-0000-0000-0000-000000000050', 1, now() - interval '1 minute' from t_readers;
insert into public.reader_sessions (id, profile_id, publication_id, publication_version, expires_at, revoked_at)
select 'a8000000-0000-0000-0000-0000000000b2', entitled_id, 'a8000000-0000-0000-0000-000000000050', 1, now() + interval '15 minutes', now() from t_readers;
-- Another reader's live session, to prove ownership is enforced rather than assumed.
insert into public.reader_sessions (id, profile_id, publication_id, publication_version, expires_at)
select 'a8000000-0000-0000-0000-0000000000b3', unentitled_id, 'a8000000-0000-0000-0000-000000000050', 1, now() + interval '15 minutes' from t_readers;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000001', true);

select is(
  (select count(*) from public.authorize_reader_session('a8000000-0000-0000-0000-0000000000b1', 'a8000000-0000-0000-0000-000000000050'))::int,
  0,
  'an expired session authorizes nothing'
);
select is(
  (select count(*) from public.authorize_reader_session('a8000000-0000-0000-0000-0000000000b2', 'a8000000-0000-0000-0000-000000000050'))::int,
  0,
  'a revoked session authorizes nothing'
);
select is(
  (select count(*) from public.authorize_reader_session('a8000000-0000-0000-0000-0000000000b3', 'a8000000-0000-0000-0000-000000000050'))::int,
  0,
  'one reader cannot present another reader''s session id'
);

reset role;

-- Entitlement revoked after the session was minted: the very next request must fail, not wait
-- for the session's own expiry.
update public.entitlements set status = 'revoked', revoked_at = now()
where profile_id = (select entitled_id from t_readers)
  and book_id = 'a8000000-0000-0000-0000-000000000020'
  and status = 'active';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000001', true);
select is(
  (select count(*) from public.authorize_reader_session((select id from t_session), 'a8000000-0000-0000-0000-000000000050'))::int,
  0,
  'revoking the entitlement stops an already-minted session on its next request'
);
reset role;

-- Restore the entitlement, then supersede the publication: a superseded publication keeps its
-- (id, version) and therefore still satisfies reader_sessions' composite FK, which is exactly
-- why the per-request status recheck exists.
update public.entitlements set status = 'active', revoked_at = null
where profile_id = (select entitled_id from t_readers)
  and book_id = 'a8000000-0000-0000-0000-000000000020';
update public.ebook_publications set status = 'superseded' where id = 'a8000000-0000-0000-0000-000000000050';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000001', true);
select is(
  (select count(*) from public.authorize_reader_session((select id from t_session), 'a8000000-0000-0000-0000-000000000050'))::int,
  0,
  'a session outliving its publication''s activity authorizes nothing once superseded'
);
reset role;

update public.ebook_publications set status = 'published' where id = 'a8000000-0000-0000-0000-000000000050';

-- ============================================================================================
-- (22)-(25) create_reader_session's three publication-state guards, one at a time
--
-- create_reader_session refuses on a composite of THREE conditions
-- (20260911200000_reader_sessions.sql):
--
--     if v_publication_status <> 'published'
--        or v_active_publication_id is distinct from p_publication_id
--        or v_book_status <> 'published' then
--
-- Until these tests, removing any one of them left this file green: the refusal tests above
-- cover a publication that does not exist and a caller with no (or a revoked) entitlement, and
-- every one of those fails earlier in the function, before the composite is ever evaluated. So
-- the guard that stops an entitled reader opening a book that is *not currently published* was
-- held by nothing but the code itself.
--
-- Latent rather than exploitable today, because nothing in the application writes books.status
-- to a non-published value. That is exactly the reasoning that already proved wrong once in this
-- plan, so it is pinned rather than argued.
--
-- Each case mutates ONE input, asserts, and restores it immediately, so the three are genuinely
-- independent and the fourth test proves the restores worked. The same update-assert-restore
-- idiom as the entitlement and superseded-publication cases above; the parallel guards inside
-- authorize_reader_session are covered by (20)-(21).
-- ============================================================================================

-- (22) The publication's own status. Entitlement, book status and the active pointer all stay
-- correct, so this is the only failing condition.
update public.ebook_publications set status = 'superseded' where id = 'a8000000-0000-0000-0000-000000000050';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select * from public.create_reader_session('a8000000-0000-0000-0000-000000000050', 900)$$,
  'EB008', null,
  'an entitled reader cannot mint a session for a publication that is not published'
);
reset role;
update public.ebook_publications set status = 'published' where id = 'a8000000-0000-0000-0000-000000000050';

-- (23) The edition's active pointer. The publication stays 'published' and the book stays
-- 'published' - only the pointer moves away, which is the rollback case: a superseded-but-still-
-- published-looking publication must not remain openable after the book points elsewhere.
update public.books set active_publication_id = null where id = 'a8000000-0000-0000-0000-000000000020';
update public.editions set active_publication_id = null where id = 'a8000000-0000-0000-0000-000000000030';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select * from public.create_reader_session('a8000000-0000-0000-0000-000000000050', 900)$$,
  'EB008', null,
  'an entitled reader cannot mint a session for a publication its edition no longer points at'
);
reset role;
update public.books set active_publication_id = 'a8000000-0000-0000-0000-000000000050'
where id = 'a8000000-0000-0000-0000-000000000020';

-- (24) The book's own status (Ruling BL: a published book is the condition for the catalog being
-- visible at all). The publication stays published and actively pointed at.
update public.books set status = 'draft' where id = 'a8000000-0000-0000-0000-000000000020';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select * from public.create_reader_session('a8000000-0000-0000-0000-000000000050', 900)$$,
  'EB008', null,
  'an entitled reader cannot mint a session for a book that is not published'
);
reset role;
update public.books set status = 'published' where id = 'a8000000-0000-0000-0000-000000000020';

-- (25) The control the three above need: with every input restored, minting works again. Without
-- this a botched restore would silently turn the three tests into tautologies.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select * from public.create_reader_session('a8000000-0000-0000-0000-000000000050', 900)$$,
  'with all three conditions restored, an entitled reader can mint a session again'
);
reset role;

-- ============================================================================================
-- (26)-(30) Cover reads: the only new browser-visible privilege in this task
-- ============================================================================================

-- storage_key is withheld at the COLUMN grant, not merely omitted by the application's select:
-- a row-level policy cannot hide a column, and this is the one field on media_assets that names
-- a private object.
select is(has_column_privilege('authenticated', 'public.media_assets', 'storage_key', 'SELECT'), false, 'authenticated cannot select media_assets.storage_key');
select is(has_column_privilege('anon', 'public.media_assets', 'storage_key', 'SELECT'), false, 'anon cannot select media_assets.storage_key');
select is(has_column_privilege('authenticated', 'public.media_assets', 'alt_text', 'SELECT'), true, 'authenticated may select media_assets.alt_text');

set local role anon;
select is(
  (select count(*) from public.media_assets where owner_id = 'a8000000-0000-0000-0000-000000000020')::int,
  1,
  'anon reads the cover of a published book'
);
select is(
  (select count(*) from public.media_assets where owner_id = 'a8000000-0000-0000-0000-000000000021')::int,
  0,
  'anon cannot read the cover of a draft book'
);
reset role;

select * from finish();
rollback;
