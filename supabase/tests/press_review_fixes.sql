begin;
select plan(13);

-- Final-review fixes: the offer sold is the one shown, a blocked edition stops selling, editorial notes
-- are not public, and a bundle order can be claimed by a reader who owns one of its editions.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'f5100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'rf-r1@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
update public.customer_identities set verified_at = now() where profile_id = (select id from public.profiles where auth_user_id = 'f5100000-0000-0000-0000-000000000001');
insert into public.authors (id, canonical_slug, display_name, status) values ('f5200000-0000-0000-0000-000000000001', 'rf-author', 'RF Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('f5300000-0000-0000-0000-000000000001', 'rf-book', 'en', 'f5200000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values ('f5300000-0000-0000-0000-000000000001', 'en', 'rf-book', 'RF Book');
insert into public.editions (id, book_id, language_code, status) values
  ('f5400000-0000-0000-0000-000000000001', 'f5300000-0000-0000-0000-000000000001', 'en', 'published'),
  ('f5400000-0000-0000-0000-000000000002', 'f5300000-0000-0000-0000-000000000001', 'ja', 'published');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('f5500000-0000-0000-0000-000000000001', 'f5400000-0000-0000-0000-000000000001', 'rf/en.epub', 1, 'published'),
  ('f5500000-0000-0000-0000-000000000002', 'f5400000-0000-0000-0000-000000000002', 'rf/ja.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language) values
  ('f5600000-0000-0000-0000-000000000001', 'f5500000-0000-0000-0000-000000000001', 1, 'rf/en.json', 'published', 'en'),
  ('f5600000-0000-0000-0000-000000000002', 'f5500000-0000-0000-0000-000000000002', 1, 'rf/ja.json', 'published', 'ja');
update public.editions set active_publication_id = 'f5600000-0000-0000-0000-000000000001' where id = 'f5400000-0000-0000-0000-000000000001';
update public.editions set active_publication_id = 'f5600000-0000-0000-0000-000000000002' where id = 'f5400000-0000-0000-0000-000000000002';
insert into public.skus (id, edition_id, sku_code) values
  ('f5700000-0000-0000-0000-000000000001', 'f5400000-0000-0000-0000-000000000001', 'RF-EN'),
  ('f5700000-0000-0000-0000-000000000002', 'f5400000-0000-0000-0000-000000000002', 'RF-JA');
-- English: an old VND 50,000 offer is still active, and the default is the new VND 80,000 one.
insert into public.offers (id, sku_id, market_code, currency, price_minor) values
  ('f5800000-0000-0000-0000-000000000001', 'f5700000-0000-0000-0000-000000000001', 'VN', 'VND', 50000),
  ('f5800000-0000-0000-0000-000000000002', 'f5700000-0000-0000-0000-000000000001', 'VX', 'VND', 80000),
  ('f5800000-0000-0000-0000-000000000003', 'f5700000-0000-0000-0000-000000000002', 'VN', 'VND', 70000),
  ('f5800000-0000-0000-0000-000000000004', 'f5700000-0000-0000-0000-000000000002', 'VY', 'VND', 0);
insert into public.edition_default_offers (edition_id, sku_id, offer_id) values
  ('f5400000-0000-0000-0000-000000000001', 'f5700000-0000-0000-0000-000000000001', 'f5800000-0000-0000-0000-000000000002'),
  ('f5400000-0000-0000-0000-000000000002', 'f5700000-0000-0000-0000-000000000002', 'f5800000-0000-0000-0000-000000000003');
update public.commerce_settings set payment_provider = 'manual', payments_enabled = true, payable_currencies = array['VND'];

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f5100000-0000-0000-0000-000000000001', true);

-- (1)-(2) Only the displayed offer sells, whatever else is active.
select throws_ok($$select public.create_edition_order('f5400000-0000-0000-0000-000000000001', 'f5800000-0000-0000-0000-000000000001', 50000)$$, 'EB012', null, 'an old active offer that is not the default cannot be bought');
select lives_ok($$select public.create_edition_order('f5400000-0000-0000-0000-000000000001', 'f5800000-0000-0000-0000-000000000002', 80000)$$, 'the default offer can');
-- (3) A free offer that is not the displayed one grants nothing on a paid edition.
select throws_ok($$select public.acquire_free_edition('f5400000-0000-0000-0000-000000000002')$$, 'EB006', null, 'a free offer that is not the displayed offer grants nothing');

-- (4)-(6) A blocked edition stops selling, giving away, and listing.
reset role;
update public.editions set editorial_state = 'blocked', reviewed_at = now(), review_note = 'rights', reviewed_by = (select id from public.profiles limit 1)
where id = 'f5400000-0000-0000-0000-000000000002';
update public.offers set price_minor = 0 where id = 'f5800000-0000-0000-0000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f5100000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.create_edition_order('f5400000-0000-0000-0000-000000000002', 'f5800000-0000-0000-0000-000000000003', null)$$, 'EB012', null, 'a blocked edition cannot be ordered');
select throws_ok($$select public.acquire_free_edition('f5400000-0000-0000-0000-000000000002')$$, 'EB006', null, 'a blocked free edition cannot be acquired');
reset role;
select is((select count(*) from public.catalog_resolved_editions('ja', 'f5300000-0000-0000-0000-000000000001') where language_code = 'ja' and not is_fallback), 0::bigint, 'a blocked edition is not listed as the Japanese edition');

-- (7)-(8) Editorial notes are not readable by the public.
set local role anon;
select throws_ok($$select review_note from public.editions$$, '42501', null, 'anon cannot read editorial review notes');
select lives_ok($$select id, language_code, status from public.editions$$, 'anon still reads the public edition columns');
reset role;

-- (9)-(10) A pending bundle order is not touched by, nor returned as, a single-edition order.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, payment_provider)
select 'f5900000-0000-0000-0000-000000000001', id, 'pending', 'pending', 'VN', 'VND', 100000, 100000, 'manual' from public.profiles where auth_user_id = 'f5100000-0000-0000-0000-000000000001';
insert into public.bundles (id, status) values ('f5a00000-0000-0000-0000-000000000001', 'published');
update public.orders set bundle_id = 'f5a00000-0000-0000-0000-000000000001' where id = 'f5900000-0000-0000-0000-000000000001';
insert into public.order_items (order_id, sku_id, book_id, edition_id, language_code, offer_id, title_snapshot, unit_price_minor, quantity, position)
values ('f5900000-0000-0000-0000-000000000001', 'f5700000-0000-0000-0000-000000000001', 'f5300000-0000-0000-0000-000000000001', 'f5400000-0000-0000-0000-000000000001', 'en', null, 'RF Book', 100000, 1, 1);
insert into public.payments (order_id, provider, status, amount_minor, currency) values ('f5900000-0000-0000-0000-000000000001', 'manual', 'pending', 100000, 'VND');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f5100000-0000-0000-0000-000000000001', true);
select isnt(public.create_edition_order('f5400000-0000-0000-0000-000000000001', 'f5800000-0000-0000-0000-000000000002', 80000), 'f5900000-0000-0000-0000-000000000001'::uuid, 'a bundle order is not returned as the single-edition order');
reset role;
select is((select status::text from public.orders where id = 'f5900000-0000-0000-0000-000000000001'), 'pending', 'and it is not cancelled');

-- (11)-(13) Owning one edition of a bundle does not stop the reader reporting its transfer.
insert into public.entitlements (profile_id, book_id, edition_id, source_type, status, reason, actor_profile_id)
select p.id, 'f5300000-0000-0000-0000-000000000001', 'f5400000-0000-0000-0000-000000000001', 'admin_grant', 'active', 'owns english', p.id
from public.profiles p where auth_user_id = 'f5100000-0000-0000-0000-000000000001';
insert into public.order_items (order_id, sku_id, book_id, edition_id, language_code, offer_id, title_snapshot, unit_price_minor, quantity, position)
values ('f5900000-0000-0000-0000-000000000001', 'f5700000-0000-0000-0000-000000000002', 'f5300000-0000-0000-0000-000000000001', 'f5400000-0000-0000-0000-000000000002', 'ja', null, 'RF Book', 0, 1, 2);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f5100000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.claim_manual_transfer('f5900000-0000-0000-0000-000000000001', 'sent')$$, 'a reader who owns one of the bundle''s editions can report the transfer');
reset role;
update public.order_items set edition_id = 'f5400000-0000-0000-0000-000000000001', language_code = 'en', sku_id = 'f5700000-0000-0000-0000-000000000001' where order_id = 'f5900000-0000-0000-0000-000000000001' and position = 2;
delete from public.manual_transfer_claims;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f5100000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.claim_manual_transfer('f5900000-0000-0000-0000-000000000001', 'sent')$$, 'EB017', null, 'a reader who owns every edition on the order cannot');
reset role;
select is((select count(*) from public.manual_transfer_claims), 0::bigint, 'and no claim was recorded');

select * from finish();
rollback;
