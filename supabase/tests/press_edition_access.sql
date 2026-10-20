begin;
select plan(42);

-- Press Task 5: access is per edition. Owning English never opens Japanese, whatever route is
-- tried: session, authorization, progress, annotations, shared quotes.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e6100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ea-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e6100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ea-r1@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e6100000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'ea-r2@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e6100000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'ea-r3@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e6100000-0000-0000-0000-000000000001';
create temporary table t_p as
select (select id from public.profiles where auth_user_id = 'e6100000-0000-0000-0000-000000000001') as admin_id,
       (select id from public.profiles where auth_user_id = 'e6100000-0000-0000-0000-000000000002') as r1,
       (select id from public.profiles where auth_user_id = 'e6100000-0000-0000-0000-000000000003') as r2,
       (select id from public.profiles where auth_user_id = 'e6100000-0000-0000-0000-000000000004') as r3;
grant select on t_p to public;
-- Every reader has a verified email, so grants and free claims are allowed for them.
update public.customer_identities set verified_at = now()
where profile_id in (select r1 from t_p union select r2 from t_p union select r3 from t_p);

insert into public.authors (id, canonical_slug, display_name, status) values ('e6200000-0000-0000-0000-000000000001', 'ea-author', 'EA Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e6300000-0000-0000-0000-000000000001', 'ea-book', 'en', 'e6200000-0000-0000-0000-000000000001', 'published'),
  ('e6300000-0000-0000-0000-000000000002', 'ea-single', 'en', 'e6200000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values ('e6300000-0000-0000-0000-000000000001', 'en', 'ea-book', 'EA Book');
insert into public.editions (id, book_id, language_code, status) values
  ('e6400000-0000-0000-0000-000000000001', 'e6300000-0000-0000-0000-000000000001', 'en', 'published'),
  ('e6400000-0000-0000-0000-000000000002', 'e6300000-0000-0000-0000-000000000001', 'ja', 'published'),
  ('e6400000-0000-0000-0000-000000000003', 'e6300000-0000-0000-0000-000000000002', 'en', 'published');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('e6500000-0000-0000-0000-000000000001', 'e6400000-0000-0000-0000-000000000001', 'ea/en.epub', 1, 'published'),
  ('e6500000-0000-0000-0000-000000000002', 'e6400000-0000-0000-0000-000000000002', 'ea/ja.epub', 1, 'published'),
  ('e6500000-0000-0000-0000-000000000003', 'e6400000-0000-0000-0000-000000000003', 'ea/single.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language) values
  ('e6600000-0000-0000-0000-000000000001', 'e6500000-0000-0000-0000-000000000001', 1, 'ea/en.json', 'published', 'en'),
  ('e6600000-0000-0000-0000-000000000002', 'e6500000-0000-0000-0000-000000000002', 1, 'ea/ja.json', 'published', 'ja'),
  ('e6600000-0000-0000-0000-000000000003', 'e6500000-0000-0000-0000-000000000003', 1, 'ea/single.json', 'published', 'en');
update public.editions set active_publication_id = 'e6600000-0000-0000-0000-000000000001' where id = 'e6400000-0000-0000-0000-000000000001';
update public.editions set active_publication_id = 'e6600000-0000-0000-0000-000000000002' where id = 'e6400000-0000-0000-0000-000000000002';
update public.editions set active_publication_id = 'e6600000-0000-0000-0000-000000000003' where id = 'e6400000-0000-0000-0000-000000000003';
-- Both languages are free to acquire, so the work-level entry point cannot pick one for the reader.
insert into public.skus (id, edition_id, sku_code) values
  ('e6700000-0000-0000-0000-000000000001', 'e6400000-0000-0000-0000-000000000001', 'EA-EN'),
  ('e6700000-0000-0000-0000-000000000002', 'e6400000-0000-0000-0000-000000000002', 'EA-JA');
insert into public.offers (sku_id, market_code, currency, price_minor) values
  ('e6700000-0000-0000-0000-000000000001', 'VN', 'VND', 0),
  ('e6700000-0000-0000-0000-000000000002', 'JP', 'JPY', 0);

-- R1 owns English (an admin grant), R2 owns Japanese.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000001', true);
select public.grant_complimentary_entitlement((select r1 from t_p), 'e6400000-0000-0000-0000-000000000001', 'ea fixture');
select public.grant_complimentary_entitlement((select r2 from t_p), 'e6400000-0000-0000-0000-000000000002', 'ea fixture');

-- (1)-(4) A reader opens exactly the edition they own.
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000002', true);
select lives_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000001', 900)$$, 'the English owner opens English');
select throws_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000002', 900)$$, 'EB008', null, 'the English owner cannot open Japanese');
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000003', true);
select lives_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000002', 900)$$, 'the Japanese owner opens Japanese');
select throws_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000001', 900)$$, 'EB008', null, 'the Japanese owner cannot open English');

-- (5)-(6) A reader owning neither, and a visitor with no profile, are refused.
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000004', true);
select throws_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000001', 900)$$, 'EB008', null, 'a reader who owns nothing is refused');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ff', true);
select throws_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000002', 900)$$, 'EB008', null, 'a session with no profile is refused');

-- (7)-(8) A session minted for English cannot authorize a Japanese read.
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000002', true);
create temporary table t_s as select id, publication_version from public.create_reader_session('e6600000-0000-0000-0000-000000000001', 900);
grant select on t_s to public;
select is((select count(*) from public.authorize_reader_session((select id from t_s), 'e6600000-0000-0000-0000-000000000001')), 1::bigint, 'the English session authorizes English');
select is((select count(*) from public.authorize_reader_session((select id from t_s), 'e6600000-0000-0000-0000-000000000002')), 0::bigint, 'the same session never authorizes Japanese');

-- (9)-(10) Progress is saved only where the reader owns the edition.
select lives_ok($$select * from public.save_reading_progress('e6600000-0000-0000-0000-000000000001', '{"href":"a","progression":0.2,"locations":{}}'::jsonb, 0.2, 0.2, 'dev', 1)$$, 'English progress saves');
select throws_ok($$select * from public.save_reading_progress('e6600000-0000-0000-0000-000000000002', '{"href":"a","progression":0.2,"locations":{}}'::jsonb, 0.2, 0.2, 'dev', 1)$$, 'EB009', null, 'Japanese progress is refused for an English owner');

-- (11)-(13) Annotations follow the same rule. The annotation policies call this very function; clients hold
-- no table grants (the reader API reads and writes through the service role after authorizing), so the
-- rule itself is what is asserted here.
select is(public.reader_edition_for_publication((select r1 from t_p), 'e6600000-0000-0000-0000-000000000001'), 'e6400000-0000-0000-0000-000000000001'::uuid, 'an English owner may use English annotations');
select is(public.reader_edition_for_publication((select r1 from t_p), 'e6600000-0000-0000-0000-000000000002'), null, 'but not Japanese ones');
select is((select count(*) from pg_policies where tablename = 'reader_annotations' and (qual like '%reader_edition_for_publication%' or with_check like '%reader_edition_for_publication%')), 4::bigint, 'and every annotation policy asks that rule, not the work');

-- (14)-(15) Shared quotes.
select lives_ok($$select public.create_shared_quote('e6600000-0000-0000-0000-000000000001', 'a line', 'en')$$, 'an owner shares a quote from their edition');
select throws_ok($$select public.create_shared_quote('e6600000-0000-0000-0000-000000000002', 'a line', 'en')$$, 'EB039', null, 'a quote from an edition they do not own is refused');

-- (16)-(22) Granting Japanese too: both editions are held independently.
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000001', true);
create temporary table t_g as select public.grant_complimentary_entitlement((select r1 from t_p), 'e6400000-0000-0000-0000-000000000002', 'adds Japanese') as id;
grant select on t_g to public;
select is(public.grant_complimentary_entitlement((select r1 from t_p), 'e6400000-0000-0000-0000-000000000002', 'again'), (select id from t_g), 'granting the same edition again returns the same entitlement');
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000002', true);
select lives_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000002', 900)$$, 'with a Japanese grant the reader opens Japanese too');
select lives_ok($$select * from public.save_reading_progress('e6600000-0000-0000-0000-000000000002', '{"href":"b","progression":0.5,"locations":{}}'::jsonb, 0.5, 0.5, 'dev', 1)$$, 'and saves Japanese progress');
select is((select count(*) from public.reading_progress where profile_id = (select r1 from t_p)), 2::bigint, 'progress is kept per publication: two rows, independent');
select is((select count(*) from public.library_items where profile_id = (select r1 from t_p)), 2::bigint, 'the library holds both editions');
select is((select count(distinct edition_id) from public.entitlements where profile_id = (select r1 from t_p) and status = 'active'), 2::bigint, 'two active entitlements for one work, one per edition');
select is(public.reader_edition_for_publication((select r1 from t_p), 'e6600000-0000-0000-0000-000000000002'), 'e6400000-0000-0000-0000-000000000002'::uuid, 'and may now use Japanese annotations');

-- (23)-(27) Revoking the Japanese grant removes Japanese only.
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.revoke_complimentary_entitlement((select r1 from t_p), (select id from t_g), 'ea revoke')$$, 'the Japanese grant is revoked');
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000002', true);
select throws_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000002', 900)$$, 'EB008', null, 'Japanese closes');
select lives_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000001', 900)$$, 'English stays open');
select is((select count(*) from public.library_items where profile_id = (select r1 from t_p)), 1::bigint, 'the library keeps the English item only');
select throws_ok(
  $$select * from public.save_reading_progress('e6600000-0000-0000-0000-000000000002', '{"href":"b","progression":0.6,"locations":{}}'::jsonb, 0.6, 0.6, 'dev', 2)$$,
  'EB009', null, 'revoked access stops progress writes at once');

-- (28)-(31) Edition and work state decide whether an owner can read.
reset role;
update public.editions set status = 'archived' where id = 'e6400000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000002', true);
select lives_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000001', 900)$$, 'an archived edition stays readable by its owners');
reset role;
update public.editions set status = 'draft' where id = 'e6400000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000002', true);
select throws_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000001', 900)$$, 'EB008', null, 'a draft edition is not readable even by an owner');
reset role;
update public.editions set status = 'published' where id = 'e6400000-0000-0000-0000-000000000001';
update public.books set status = 'draft' where id = 'e6300000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000002', true);
select throws_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000001', 900)$$, 'EB008', null, 'an unpublished work closes every edition');
reset role;
update public.books set status = 'published' where id = 'e6300000-0000-0000-0000-000000000001';
update public.editions set active_publication_id = null where id = 'e6400000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000002', true);
select throws_ok($$select * from public.create_reader_session('e6600000-0000-0000-0000-000000000001', 900)$$, 'EB008', null, 'a publication that is not live is not readable');
reset role;
update public.editions set active_publication_id = 'e6600000-0000-0000-0000-000000000001' where id = 'e6400000-0000-0000-0000-000000000001';

-- (32)-(36) No book-only write can silently choose a language.
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason) select r3, 'e6300000-0000-0000-0000-000000000001', 'admin_grant', admin_id, 'no edition' from t_p$$,
  '23514', null, 'a book-only entitlement for a two-language work is refused');
select lives_ok(
  $$insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason) select 'e6800000-0000-0000-0000-000000000001', r3, 'e6300000-0000-0000-0000-000000000002', 'admin_grant', admin_id, 'single' from t_p$$,
  'a book-only entitlement for a one-edition work is scoped to that edition');
select is((select edition_id from public.entitlements where id = 'e6800000-0000-0000-0000-000000000001'), 'e6400000-0000-0000-0000-000000000003'::uuid, 'and names the only edition');
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason) select r1, 'e6300000-0000-0000-0000-000000000001', 'e6400000-0000-0000-0000-000000000001', 'admin_grant', admin_id, 'dup' from t_p$$,
  '23505', null, 'two active entitlements for one edition are refused');
select is(has_function_privilege('authenticated', 'public.press_grant_edition_access(uuid, uuid, public.entitlement_source, uuid, uuid, text)', 'EXECUTE'), false, 'the grant primitive is not callable by clients');

-- (37)-(40) Granting needs an admin and a real edition.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.grant_complimentary_entitlement((select r3 from t_p), 'e6400000-0000-0000-0000-000000000002', 'x')$$, '42501', null, 'a reader cannot grant');
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.grant_complimentary_entitlement((select r3 from t_p), 'e6400000-0000-0000-0000-0000000000ff', 'x')$$, 'P0002', null, 'granting an unknown edition fails');

-- (41)-(44) Free acquisition names one edition and grants that one only.
select set_config('request.jwt.claim.sub', 'e6100000-0000-0000-0000-000000000004', true);
select throws_ok($$select public.acquire_free_ebook('e6300000-0000-0000-0000-000000000001')$$, 'EB006', null, 'the work-level entry point refuses to pick between two free editions');
select lives_ok($$select public.acquire_free_edition('e6400000-0000-0000-0000-000000000002')$$, 'a reader acquires the Japanese edition by name');
select is((select count(*) from public.entitlements where profile_id = (select r3 from t_p) and edition_id = 'e6400000-0000-0000-0000-000000000002' and status = 'active'), 1::bigint, 'and holds Japanese');
select is((select count(*) from public.entitlements where profile_id = (select r3 from t_p) and edition_id = 'e6400000-0000-0000-0000-000000000001'), 0::bigint, 'but not English');

select * from finish();
rollback;
