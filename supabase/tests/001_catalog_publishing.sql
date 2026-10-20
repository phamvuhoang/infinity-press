begin;
select plan(13);
select has_table('public', 'books'::name);
select has_table('public', 'book_localizations'::name);
select has_table('public', 'editions'::name);
select has_table('public', 'skus'::name);
select has_table('public', 'offers'::name);
select has_table('public', 'ebook_assets'::name);
select has_table('public', 'processing_jobs'::name);
select has_table('public', 'ebook_publications'::name);
select has_table('public', 'ebook_resources'::name);
select has_table('public', 'book_samples'::name);
select col_is_pk('public', 'books', 'id'::name);
select has_index('public', 'book_localizations', 'book_localizations_locale_slug_key', 'Index book_localizations_locale_slug_key should exist on book_localizations');

-- Fixtures for the ebook_publications <-> ebook_assets version-integrity FK.
insert into public.authors (id, canonical_slug, display_name, status) values
  ('10000000-0000-0000-0000-000000000001', 'fk-test-author', 'FK Test Author', 'draft');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('10000000-0000-0000-0000-000000000002', 'fk-test-book', 'en', '10000000-0000-0000-0000-000000000001', 'draft');
insert into public.editions (id, book_id, language_code, edition_number) values
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'en', 1);
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003', 'assets/fk-test-v1.epub', 1, 'ready_for_preview');

select throws_ok(
  $$insert into public.ebook_publications (ebook_asset_id, version, manifest_key) values ('10000000-0000-0000-0000-000000000004', 2, 'manifests/fk-test-mismatch.json')$$,
  '23503',
  null,
  'ebook_publications version must match its ebook_asset version'
);

select * from finish();
rollback;
