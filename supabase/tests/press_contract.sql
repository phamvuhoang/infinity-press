begin;
select plan(12);

-- Press contract migration: the book-scoped shapes are gone and edition scope is required.
select col_not_null('public', 'entitlements', 'edition_id', 'entitlements are edition-scoped');
select col_not_null('public', 'library_items', 'edition_id', 'library items are edition-scoped');
select col_not_null('public', 'order_items', 'edition_id', 'order lines are edition-scoped');
select col_not_null('public', 'book_reviews', 'edition_id', 'reviews are edition-scoped');
select hasnt_column('public', 'books', 'active_publication_id', 'the edition, not the book, owns the live publication');
select hasnt_function('public', 'create_ebook_order', array['uuid'], 'no book-only order entry point');
select hasnt_function('public', 'acquire_free_ebook', array['uuid'], 'no book-only free claim');
select hasnt_function('public', 'press_edition_backfill', array['boolean'], 'the one-off backfill is gone');
select hasnt_table('public', 'bundle_books', 'bundle membership is only by edition');
select has_view('public', 'bundle_works', 'the works in a bundle are derived from its editions');

-- bundle_works can never disagree with bundle_editions.
insert into public.authors (id, canonical_slug, display_name, status) values ('f1000000-0000-0000-0000-000000000001', 'pc-author', 'PC Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('f2000000-0000-0000-0000-000000000001', 'pc-book', 'en', 'f1000000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code) values
  ('f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'en'),
  ('f3000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', 'ja');
insert into public.bundles (id, status) values ('f4000000-0000-0000-0000-000000000001', 'draft');
insert into public.bundle_editions (bundle_id, edition_id, position) values
  ('f4000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 1),
  ('f4000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000002', 2);
select is((select count(*) from public.bundle_works where bundle_id = 'f4000000-0000-0000-0000-000000000001'), 1::bigint, 'two editions of one work are one work');
select is((select position from public.bundle_works where bundle_id = 'f4000000-0000-0000-0000-000000000001'), 1, 'at the first edition''s position');

select * from finish();
rollback;
