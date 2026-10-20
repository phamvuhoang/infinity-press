-- Legacy (book-scoped) data that must upgrade cleanly. Loaded by scripts/rehearse-upgrade.sh into a
-- LOCAL database migrated up to the last pre-Press migration. Synthetic: no real customers or books.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'legacy-r1@example.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'legacy-r2@example.test', '', now(), '{}', '{}', now(), now());

insert into public.authors (id, canonical_slug, display_name, status) values ('f2000000-0000-0000-0000-000000000001', 'legacy-author', 'Legacy Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('f3000000-0000-0000-0000-000000000001', 'legacy-single', 'en', 'f2000000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code) values ('f4000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'en');
-- Two assets (versions) of the same edition: the older superseded, the newer published.
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('f5000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'legacy/v1.epub', 1, 'superseded'),
  ('f5000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000001', 'legacy/v2.epub', 2, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('f6000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000001', 1, 'legacy/v1.json', 'superseded'),
  ('f6000000-0000-0000-0000-000000000002', 'f5000000-0000-0000-0000-000000000002', 2, 'legacy/v2.json', 'published');
update public.books set active_publication_id = 'f6000000-0000-0000-0000-000000000002' where id = 'f3000000-0000-0000-0000-000000000001';
insert into public.skus (id, edition_id, sku_code) values ('f7000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'LEGACY-EN');
insert into public.offers (id, sku_id, market_code, currency, price_minor) values ('f8000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000001', 'VN', 'VND', 90000);

-- r1: completed paid order + entitlement + library + progress + annotation (on the old publication).
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, reference_code)
values
  ('f9000000-0000-0000-0000-000000000001', (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000001'), 'completed', 'succeeded', 'VN', 'VND', 90000, 90000, 'IB-GY001'),
  -- r2: a pending order that must survive untouched, plus a pending gift on it.
  ('f9000000-0000-0000-0000-000000000002', (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000002'), 'pending', 'pending', 'VN', 'VND', 90000, 90000, 'IB-GY002');
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor) values
  ('f9000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'Legacy Single', 90000),
  ('f9000000-0000-0000-0000-000000000002', 'f7000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'Legacy Single', 90000);
insert into public.entitlements (id, profile_id, book_id, source_type, source_order_id) values
  ('fa000000-0000-0000-0000-000000000001', (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000001'), 'f3000000-0000-0000-0000-000000000001', 'simulated_payment', 'f9000000-0000-0000-0000-000000000001');
insert into public.library_items (id, profile_id, book_id, entitlement_id) values
  ('fb000000-0000-0000-0000-000000000001', (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000001'), 'f3000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001');
insert into public.reading_progress (profile_id, publication_id, locator_json, progression, device_id, client_sequence) values
  ((select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000001'), 'f6000000-0000-0000-0000-000000000001', '{"href":"c1"}', 0.4, 'dev', 1);
insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, label) values
  ((select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000001'), 'f6000000-0000-0000-0000-000000000001', 'bookmark', '{"href":"c1","progression":0.1,"locations":{}}', 'old bookmark');
insert into public.gifts (order_id, purchaser_profile_id, recipient_email, claim_token_hash, status) values
  ('f9000000-0000-0000-0000-000000000002', (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000002'), 'friend@example.test', repeat('a', 64), 'pending');
insert into public.bundles (id, status) values ('fc000000-0000-0000-0000-000000000001', 'published');
insert into public.bundle_books (bundle_id, book_id, position) values ('fc000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 1);
