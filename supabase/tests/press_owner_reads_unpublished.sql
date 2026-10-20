begin;
select plan(19);

-- Owners keep reading after unpublish or rollback
-- (docs/superpowers/specs/2026-10-21-owner-reads-unpublished-design.md). Every reader gate follows
-- public.reader_publication_for_edition, never books.status or editions.status. Revoking the
-- entitlement is the only way to remove access, and a reader without one still gets the single
-- opaque EB008.

-- ============================================================================================
-- Fixtures
-- ============================================================================================

-- A holds an active entitlement to the en edition, B none, C a revoked one. D is the admin who rolls back.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e7300000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'pub-unpub-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e7300000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'pub-unpub-stranger@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e7300000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'pub-unpub-revoked@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e7300000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'pub-unpub-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved once as the connecting role: "owner reads own profile" RLS would hide other rows later.
create temporary table t_readers as
select
  (select id from public.profiles where auth_user_id = 'e7300000-0000-0000-0000-000000000001') as owner_id,
  (select id from public.profiles where auth_user_id = 'e7300000-0000-0000-0000-000000000003') as revoked_id,
  (select id from public.profiles where auth_user_id = 'e7300000-0000-0000-0000-000000000004') as admin_id;
grant select on t_readers to public;

insert into public.user_roles (profile_id, role)
select admin_id, 'admin' from t_readers;

insert into public.authors (id, canonical_slug, display_name, status)
values ('e7300000-0000-0000-0000-000000000010', 'pub-unpub-author', 'Unpub Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e7300000-0000-0000-0000-000000000020', 'pub-unpub-book', 'vi', 'e7300000-0000-0000-0000-000000000010', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e7300000-0000-0000-0000-000000000020', 'vi', 'pub-unpub-book', 'Sách đã gỡ');
insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text) values
  ('book', 'e7300000-0000-0000-0000-000000000020', 'cover', 'covers/pub-unpub.jpg', 'Unpub cover');
insert into public.editions (id, book_id, language_code, status) values
  ('e7300000-0000-0000-0000-000000000030', 'e7300000-0000-0000-0000-000000000020', 'en', 'published'),
  ('e7300000-0000-0000-0000-000000000031', 'e7300000-0000-0000-0000-000000000020', 'ja', 'published');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('e7300000-0000-0000-0000-000000000041', 'e7300000-0000-0000-0000-000000000030', 'pub-unpub/en-v1.epub', 1, 'superseded'),
  ('e7300000-0000-0000-0000-000000000042', 'e7300000-0000-0000-0000-000000000030', 'pub-unpub/en-v2.epub', 2, 'published'),
  ('e7300000-0000-0000-0000-000000000043', 'e7300000-0000-0000-0000-000000000031', 'pub-unpub/ja-v1.epub', 1, 'published');
-- processed_at is explicit: the rule orders by it, and now() is identical inside one transaction.
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, processed_at) values
  ('e7300000-0000-0000-0000-000000000051', 'e7300000-0000-0000-0000-000000000041', 1, 'pub-unpub/en-v1.json', 'superseded', now() - interval '1 day'),
  ('e7300000-0000-0000-0000-000000000052', 'e7300000-0000-0000-0000-000000000042', 2, 'pub-unpub/en-v2.json', 'published', now()),
  ('e7300000-0000-0000-0000-000000000053', 'e7300000-0000-0000-0000-000000000043', 1, 'pub-unpub/ja-v1.json', 'published', now());
update public.editions set active_publication_id = 'e7300000-0000-0000-0000-000000000052' where id = 'e7300000-0000-0000-0000-000000000030';
update public.editions set active_publication_id = 'e7300000-0000-0000-0000-000000000053' where id = 'e7300000-0000-0000-0000-000000000031';

insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status)
select owner_id, 'e7300000-0000-0000-0000-000000000020', 'e7300000-0000-0000-0000-000000000030', 'admin_grant', owner_id, 'test fixture', 'active' from t_readers;
insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status, revoked_at)
select revoked_id, 'e7300000-0000-0000-0000-000000000020', 'e7300000-0000-0000-0000-000000000030', 'admin_grant', revoked_id, 'test fixture', 'revoked', now() from t_readers;

-- The admin "Unpublish book" action.
update public.books set status = 'draft' where id = 'e7300000-0000-0000-0000-000000000020';

-- Browser roles hold no table privilege on reader_annotations (nor EXECUTE on the locator check
-- its CHECK constraint calls); every app write goes through the definer RPC. Granted here, inside
-- the rolled-back transaction, so (c) exercises the RLS policy itself.
grant select, insert on public.reader_annotations to authenticated;
grant execute on function public.reader_locator_is_valid(jsonb) to authenticated;

-- ============================================================================================
-- (a)-(c) The owner keeps reading the unpublished book
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7300000-0000-0000-0000-000000000001', true);

create temporary table t_session as
select * from public.create_reader_session('e7300000-0000-0000-0000-000000000052', 900);
grant select on t_session to public;
select isnt((select id from t_session), null, 'an entitled owner mints a session after the book is unpublished');
select is(
  (select count(*) from public.authorize_reader_session((select id from t_session), 'e7300000-0000-0000-0000-000000000052'))::int,
  1,
  'the owner''s session authorizes the unpublished book''s publication'
);
select lives_ok(
  $$select public.save_reading_progress('e7300000-0000-0000-0000-000000000052', '{"href":"OEBPS/text/ch1.xhtml","progression":0.5,"totalProgression":0.1,"locations":{}}'::jsonb, 0.5, 0.1, 'device-a', 1)$$,
  'the owner saves progress after the book is unpublished'
);
select lives_ok(
  $$select * from public.reader_annotation_request((select id from t_session), 'e7300000-0000-0000-0000-000000000052', 'list')$$,
  'the owner lists annotations after the book is unpublished'
);
select lives_ok(
  $$insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, label) values ((select owner_id from t_readers), 'e7300000-0000-0000-0000-000000000052', 'bookmark', '{"href":"OEBPS/text/ch1.xhtml","progression":0.5,"totalProgression":null,"locations":{}}'::jsonb, 'Mark')$$,
  'the annotation insert policy admits the owner of an unpublished book'
);
reset role;

-- ============================================================================================
-- (d)-(e) Readers without an active entitlement still get the single opaque denial
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7300000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select * from public.create_reader_session('e7300000-0000-0000-0000-000000000052', 900)$$,
  'EB008', null,
  'a reader with no entitlement is refused with EB008'
);
select throws_ok(
  $$insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, label) values ((select id from public.profiles where auth_user_id = auth.uid()), 'e7300000-0000-0000-0000-000000000052', 'bookmark', '{"href":"OEBPS/text/ch1.xhtml","progression":0.5,"totalProgression":null,"locations":{}}'::jsonb, 'Mark')$$,
  '42501', null,
  'the annotation insert policy refuses a reader with no entitlement'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7300000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select * from public.create_reader_session('e7300000-0000-0000-0000-000000000052', 900)$$,
  'EB008', null,
  'a reader with a revoked entitlement is refused with EB008'
);
reset role;

-- ============================================================================================
-- (f) No active pointer: the latest published or superseded publication stays readable
-- ============================================================================================
update public.editions set active_publication_id = null where id = 'e7300000-0000-0000-0000-000000000030';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7300000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select * from public.create_reader_session('e7300000-0000-0000-0000-000000000052', 900)$$,
  'without an active pointer the owner still reads the latest publication'
);
select throws_ok(
  $$select * from public.create_reader_session('e7300000-0000-0000-0000-000000000051', 900)$$,
  'EB008', null,
  'without an active pointer an older publication is not readable'
);
reset role;
update public.editions set active_publication_id = 'e7300000-0000-0000-0000-000000000052' where id = 'e7300000-0000-0000-0000-000000000030';

-- ============================================================================================
-- (g) Rollback moves owners to the older version, and old-version sessions stop authorizing
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7300000-0000-0000-0000-000000000004', true);
select lives_ok(
  $$select public.rollback_publication('e7300000-0000-0000-0000-000000000020', 'e7300000-0000-0000-0000-000000000051')$$,
  'admin rolls the unpublished book back to v1'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7300000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select * from public.create_reader_session('e7300000-0000-0000-0000-000000000051', 900)$$,
  'after rollback the owner reads v1'
);
select throws_ok(
  $$select * from public.create_reader_session('e7300000-0000-0000-0000-000000000052', 900)$$,
  'EB008', null,
  'after rollback v2 is no longer readable'
);
select is(
  (select count(*) from public.authorize_reader_session((select id from t_session), 'e7300000-0000-0000-0000-000000000052'))::int,
  0,
  'after rollback a v2 session authorizes nothing'
);
reset role;

-- ============================================================================================
-- (h) The rule itself is private: granting it would turn any edition id into its publication id
-- ============================================================================================
select is(has_function_privilege('authenticated', 'public.reader_publication_for_edition(uuid)', 'EXECUTE'), false, 'authenticated cannot call reader_publication_for_edition');
select is(has_function_privilege('anon', 'public.reader_publication_for_edition(uuid)', 'EXECUTE'), false, 'anon cannot call reader_publication_for_edition');
select is(has_function_privilege('service_role', 'public.reader_publication_for_edition(uuid)', 'EXECUTE'), false, 'service_role cannot call reader_publication_for_edition');

-- ============================================================================================
-- (i) Owning English never opens Japanese of the same unpublished book
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7300000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select * from public.create_reader_session('e7300000-0000-0000-0000-000000000053', 900)$$,
  'EB008', null,
  'owning English does not open the Japanese edition of an unpublished book'
);
reset role;

-- ============================================================================================
-- (j) Edition status plays no part: a draft edition with a readable publication stays readable
-- ============================================================================================
update public.editions set status = 'draft' where id = 'e7300000-0000-0000-0000-000000000030';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7300000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select * from public.create_reader_session('e7300000-0000-0000-0000-000000000051', 900)$$,
  'a draft edition with a readable publication stays readable by its owner'
);
reset role;
update public.editions set status = 'published' where id = 'e7300000-0000-0000-0000-000000000030';

select * from finish();
rollback;
