begin;
select plan(5);

-- S20 edition record: what kind of text an edition is and how much of it was reviewed, saved by the
-- admin provenance RPC and shown on the public book page beside the existing provenance notes.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'f7100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'record-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role) select id, 'admin' from public.profiles where auth_user_id = 'f7100000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status) values ('f7200000-0000-0000-0000-000000000001', 'record-author', 'Record Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('f7300000-0000-0000-0000-000000000001', 'record-book', 'en', 'f7200000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values ('f7300000-0000-0000-0000-000000000001', 'en', 'record-book', 'Record Book');
insert into public.editions (id, book_id, language_code, status) values ('f7400000-0000-0000-0000-000000000001', 'f7300000-0000-0000-0000-000000000001', 'en', 'published');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values ('f7500000-0000-0000-0000-000000000001', 'f7400000-0000-0000-0000-000000000001', 'record/en.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language) values ('f7600000-0000-0000-0000-000000000001', 'f7500000-0000-0000-0000-000000000001', 1, 'record/en.json', 'published', 'en');
update public.editions set active_publication_id = 'f7600000-0000-0000-0000-000000000001' where id = 'f7400000-0000-0000-0000-000000000001';

select ok(
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'editions'
     and ((column_name = 'text_kind' and is_nullable = 'YES') or (column_name = 'review_scope' and is_nullable = 'NO' and column_default like '''none''%'))) = 2,
  'editions has a nullable text_kind and a review_scope that defaults to none'
);
select throws_ok(
  $$update public.editions set text_kind = 'poem' where id = 'f7400000-0000-0000-0000-000000000001'$$,
  '23514', null,
  'a text_kind outside literal, adapted and commentary is rejected'
);

-- An internal review note must never reach the book page.
update public.editions set review_note = 'internal: blocked for rights' where id = 'f7400000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7100000-0000-0000-0000-000000000001', true);
-- The old five-argument call still works and leaves the new fields at their defaults.
select lives_ok(
  $$select public.admin_save_edition_provenance('f7400000-0000-0000-0000-000000000001', 'Source', '', '', '')$$,
  'the provenance RPC still accepts its original arguments'
);
select public.admin_save_edition_provenance('f7400000-0000-0000-0000-000000000001', 'Source', 'Translator', '', '', 'literal', 'full', ' Fixed chapter 3. ');
reset role;

select is(
  (select text_kind || '|' || review_scope || '|' || public_version_note from public.editions where id = 'f7400000-0000-0000-0000-000000000001'),
  'literal|full|Fixed chapter 3.',
  'the provenance RPC persists text_kind, review_scope and the public version note'
);
select is(
  public.catalog_book_page('en', 'record-book') -> 'editions' -> 0 -> 'record',
  jsonb_build_object('textSourceNote', 'Source', 'translationSource', 'Translator', 'rightsNote', null, 'territoryNote', null,
    'textKind', 'literal', 'reviewScope', 'full', 'reviewedAt', null, 'versionNote', 'Fixed chapter 3.'),
  'the book page carries the edition record with its review scope and public version note, and no review note'
);

select * from finish();
rollback;
