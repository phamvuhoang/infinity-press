-- catalog_book_card_by_id: the targeted single-row equivalent of catalog_book_cards, added for the
-- storefront static caching plan's action-state route handler (final review Minor 5).
begin;
select plan(7);

insert into public.authors (id, canonical_slug, display_name, status) values
  ('e2000000-0000-0000-0000-000000000001', 'e5-author', 'E5 Author', 'published');
insert into public.author_localizations (author_id, locale, slug, name) values
  ('e2000000-0000-0000-0000-000000000001', 'vi', 'e5-tac-gia', 'Tác giả E5'),
  ('e2000000-0000-0000-0000-000000000001', 'en', 'e5-author-en', 'E5 Author');

insert into public.books (id, canonical_key, original_language, primary_author_id, status, created_at) values
  ('e3000000-0000-0000-0000-000000000001', 'e5-published', 'vi', 'e2000000-0000-0000-0000-000000000001', 'published', '2026-09-01'),
  ('e3000000-0000-0000-0000-000000000002', 'e5-draft', 'vi', 'e2000000-0000-0000-0000-000000000001', 'draft', '2026-09-02');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e3000000-0000-0000-0000-000000000001', 'vi', 'e5-sach', 'Sách E5'),
  -- Localized in vi only, on purpose: the by-id lookup must not find it in en.
  ('e3000000-0000-0000-0000-000000000002', 'vi', 'e5-sach-nhap', 'Sách nháp E5');

insert into public.editions (id, book_id, language_code) values
  ('e6000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code) values
  ('e7000000-0000-0000-0000-000000000001', 'e6000000-0000-0000-0000-000000000001', 'e5-ebook');
insert into public.offers (sku_id, market_code, currency, price_minor) values
  ('e7000000-0000-0000-0000-000000000001', 'VN', 'VND', 149000);

-- Same shape catalog_book_cards returns, one row filtered by id: id, slug, title, subtitle,
-- short_description, author_name, author_slug, cover_path, cover_alt, price_minor, currency,
-- has_active_publication, has_sample, series_slug, series_name, series_position, topics,
-- featured, shelf_position, created_at.
select is(
  has_function_privilege('anon', 'public.catalog_book_card_by_id(text, uuid)', 'EXECUTE'),
  true,
  'anon can read a book card by id'
);

select is(
  (select slug from public.catalog_book_card_by_id('vi', 'e3000000-0000-0000-0000-000000000001')),
  'e5-sach',
  'resolves the published book by id in vi'
);

select is(
  (select price_minor from public.catalog_book_card_by_id('vi', 'e3000000-0000-0000-0000-000000000001')),
  149000::bigint,
  'the active offer price is returned'
);

select is(
  (select author_slug from public.catalog_book_card_by_id('vi', 'e3000000-0000-0000-0000-000000000001')),
  'e5-tac-gia',
  'the localized author slug is returned'
);

select is(
  (select count(*)::bigint from public.catalog_book_card_by_id('en', 'e3000000-0000-0000-0000-000000000001')),
  0::bigint,
  'a book not localized in the requested locale is not returned'
);

select is(
  (select count(*)::bigint from public.catalog_book_card_by_id('vi', 'e3000000-0000-0000-0000-000000000002')),
  0::bigint,
  'a draft book is not returned even by its own id'
);

select is(
  (select count(*)::bigint from public.catalog_book_card_by_id('vi', 'e3000000-0000-0000-0000-000000000099')),
  0::bigint,
  'an id that does not exist returns nothing, not an error'
);

select * from finish();
rollback;
