begin;
select plan(24);

-- Second review pass: one sellable predicate, comp beside paid, claimed bundle orders survive a re-buy,
-- no ownership probe, free claims need a sellable edition, rollback never revives an archived edition,
-- a null feedback locator, and the shown edition's ISBN.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'f6100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'rf2-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f6100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'rf2-r1@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f6100000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'rf2-r2@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role) select id, 'admin' from public.profiles where auth_user_id = 'f6100000-0000-0000-0000-000000000001';
update public.customer_identities set verified_at = now();
create temporary table t_p as select
  (select id from public.profiles where auth_user_id = 'f6100000-0000-0000-0000-000000000001') as admin,
  (select id from public.profiles where auth_user_id = 'f6100000-0000-0000-0000-000000000002') as r1,
  (select id from public.profiles where auth_user_id = 'f6100000-0000-0000-0000-000000000003') as r2;
grant select on t_p to public;

insert into public.authors (id, canonical_slug, display_name, status) values ('f6200000-0000-0000-0000-000000000001', 'rf2-author', 'RF2 Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('f6300000-0000-0000-0000-000000000001', 'rf2-book', 'en', 'f6200000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('f6300000-0000-0000-0000-000000000001', 'en', 'rf2-book', 'RF2 Book'),
  ('f6300000-0000-0000-0000-000000000001', 'ja', 'rf2-book-ja', 'RF2 本');
insert into public.editions (id, book_id, language_code, isbn, status) values
  ('f6400000-0000-0000-0000-000000000001', 'f6300000-0000-0000-0000-000000000001', 'en', '9780000000001', 'published'),
  ('f6400000-0000-0000-0000-000000000002', 'f6300000-0000-0000-0000-000000000001', 'ja', '9780000000002', 'published');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('f6500000-0000-0000-0000-000000000001', 'f6400000-0000-0000-0000-000000000001', 'rf2/en.epub', 1, 'published'),
  ('f6500000-0000-0000-0000-000000000002', 'f6400000-0000-0000-0000-000000000002', 'rf2/ja.epub', 1, 'published'),
  ('f6500000-0000-0000-0000-000000000003', 'f6400000-0000-0000-0000-000000000001', 'rf2/en2.epub', 2, 'superseded');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language) values
  ('f6600000-0000-0000-0000-000000000001', 'f6500000-0000-0000-0000-000000000001', 1, 'rf2/en.json', 'published', 'en'),
  ('f6600000-0000-0000-0000-000000000002', 'f6500000-0000-0000-0000-000000000002', 1, 'rf2/ja.json', 'published', 'ja'),
  ('f6600000-0000-0000-0000-000000000003', 'f6500000-0000-0000-0000-000000000003', 2, 'rf2/en2.json', 'superseded', 'en');
update public.editions set active_publication_id = 'f6600000-0000-0000-0000-000000000001' where id = 'f6400000-0000-0000-0000-000000000001';
update public.editions set active_publication_id = 'f6600000-0000-0000-0000-000000000002' where id = 'f6400000-0000-0000-0000-000000000002';
insert into public.skus (id, edition_id, sku_code) values
  ('f6700000-0000-0000-0000-000000000001', 'f6400000-0000-0000-0000-000000000001', 'RF2-EN'),
  ('f6700000-0000-0000-0000-000000000002', 'f6400000-0000-0000-0000-000000000002', 'RF2-JA');
insert into public.offers (id, sku_id, market_code, currency, price_minor) values
  ('f6800000-0000-0000-0000-000000000001', 'f6700000-0000-0000-0000-000000000001', 'VN', 'VND', 50000),
  ('f6800000-0000-0000-0000-000000000002', 'f6700000-0000-0000-0000-000000000002', 'VN', 'VND', 70000);
insert into public.edition_default_offers (edition_id, sku_id, offer_id) values
  ('f6400000-0000-0000-0000-000000000001', 'f6700000-0000-0000-0000-000000000001', 'f6800000-0000-0000-0000-000000000001'),
  ('f6400000-0000-0000-0000-000000000002', 'f6700000-0000-0000-0000-000000000002', 'f6800000-0000-0000-0000-000000000002');
update public.commerce_settings set payment_provider = 'manual', payments_enabled = true, payable_currencies = array['VND'];

-- (2)-(4) A blocked edition leaves the selector and cannot be resolved by id.
update public.editions set editorial_state = 'blocked', reviewed_at = now(), review_note = 'rights', reviewed_by = (select admin from t_p)
where id = 'f6400000-0000-0000-0000-000000000002';
select is(jsonb_array_length(public.catalog_book_page('en', 'rf2-book') -> 'editions'), 1, 'a blocked edition is not in the selector');
-- The Japanese page now shows the English edition, so it names the English ISBN.
select is(public.catalog_book_page('ja', 'rf2-book-ja') ->> 'isbn', '9780000000001', 'the page names the ISBN of the edition it shows, not of a blocked one');
select is((select count(*) from public.catalog_resolve_edition('f6300000-0000-0000-0000-000000000001', 'ja', 'f6400000-0000-0000-0000-000000000002')), 0::bigint, 'nor resolvable by its id');
select ok(not public.edition_is_sellable('f6400000-0000-0000-0000-000000000002') and public.edition_is_sellable('f6400000-0000-0000-0000-000000000001'), 'edition_is_sellable agrees');
update public.editions set editorial_state = 'approved', reviewed_at = now(), reviewed_by = (select admin from t_p) where id = 'f6400000-0000-0000-0000-000000000002';

-- (5)-(6) Free claims need a sellable edition.
insert into public.offers (id, sku_id, market_code, currency, price_minor) values ('f6800000-0000-0000-0000-000000000009', 'f6700000-0000-0000-0000-000000000002', 'VF', 'VND', 0);
update public.editions set status = 'draft' where id = 'f6400000-0000-0000-0000-000000000002';
update public.edition_default_offers set offer_id = 'f6800000-0000-0000-0000-000000000009' where edition_id = 'f6400000-0000-0000-0000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.acquire_free_edition('f6400000-0000-0000-0000-000000000002')$$, 'EB006', null, 'a draft edition with a free offer cannot be claimed');
reset role;
update public.editions set status = 'published' where id = 'f6400000-0000-0000-0000-000000000002';
update public.edition_default_offers set offer_id = 'f6800000-0000-0000-0000-000000000002' where edition_id = 'f6400000-0000-0000-0000-000000000002';

-- (7)-(14) A complimentary grant sits beside a bought entitlement.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, payment_provider)
values ('f6900000-0000-0000-0000-000000000001', (select r1 from t_p), 'pending', 'pending', 'VN', 'VND', 50000, 50000, 'manual');
insert into public.order_items (order_id, sku_id, book_id, edition_id, language_code, offer_id, title_snapshot, unit_price_minor, quantity)
values ('f6900000-0000-0000-0000-000000000001', 'f6700000-0000-0000-0000-000000000001', 'f6300000-0000-0000-0000-000000000001', 'f6400000-0000-0000-0000-000000000001', 'en', 'f6800000-0000-0000-0000-000000000001', 'RF2 Book', 50000, 1);
insert into public.payments (order_id, provider, status, amount_minor, currency) values ('f6900000-0000-0000-0000-000000000001', 'manual', 'pending', 50000, 'VND');
set local role service_role;
select public.apply_payment_event('manual', 'rf2-evt-1', 'f6900000-0000-0000-0000-000000000001', 'rf2-ext-1', 'succeeded', 50000, 'VND', now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.grant_complimentary_entitlement((select r1 from t_p), 'f6400000-0000-0000-0000-000000000001', 'courtesy')$$, 'an admin can comp an edition the reader bought');
reset role;
select is((select count(*) from public.entitlements where profile_id = (select r1 from t_p) and edition_id = 'f6400000-0000-0000-0000-000000000001' and status = 'active'), 2::bigint, 'two active rows: bought and complimentary');
select is((select source_type::text from public.entitlements where source_order_id = 'f6900000-0000-0000-0000-000000000001'), 'manual_payment', 'the bought entitlement keeps its source');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.revoke_complimentary_entitlement((select r1 from t_p), (select id from public.entitlements where source_type = 'admin_grant' and profile_id = (select r1 from t_p)), 'done')$$, 'revoking the comp works');
reset role;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000002', true);
select is(public.reader_edition_for_publication((select r1 from t_p), 'f6600000-0000-0000-0000-000000000001'), 'f6400000-0000-0000-0000-000000000001'::uuid, 'the bought access survives');
select is((select e.source_type::text from public.library_items li join public.entitlements e on e.id = li.entitlement_id where li.profile_id = (select r1 from t_p)), 'manual_payment', 'and the shelf entry follows it');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.grant_complimentary_entitlement((select r1 from t_p), 'f6400000-0000-0000-0000-000000000001', 'again')$$, 'the comp can be given again');
select lives_ok($$select public.revoke_order_entitlement('f6900000-0000-0000-0000-000000000001', 'refund')$$, 'revoking the order works');
reset role;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000002', true);
select is(public.reader_edition_for_publication((select r1 from t_p), 'f6600000-0000-0000-0000-000000000001'), 'f6400000-0000-0000-0000-000000000001'::uuid, 'the comp keeps the reader in');

-- (15)-(16) No ownership probe.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000003', true);
select is(public.reader_edition_for_publication((select r1 from t_p), 'f6600000-0000-0000-0000-000000000001'), null, 'another reader cannot ask whether r1 holds an edition');
reset role;

-- (17)-(18) A bundle order with a reported transfer survives a re-buy after the price moves.
insert into public.bundles (id, status) values ('f6a00000-0000-0000-0000-000000000001', 'published');
insert into public.bundle_editions (bundle_id, edition_id, position) values
  ('f6a00000-0000-0000-0000-000000000001', 'f6400000-0000-0000-0000-000000000001', 1),
  ('f6a00000-0000-0000-0000-000000000001', 'f6400000-0000-0000-0000-000000000002', 2);
insert into public.offers (id, bundle_id, market_code, currency, price_minor) values ('f6b00000-0000-0000-0000-000000000001', 'f6a00000-0000-0000-0000-000000000001', 'VN', 'VND', 100000);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000003', true);
create temporary table t_b as select public.create_bundle_order('f6a00000-0000-0000-0000-000000000001') as id;
grant select on t_b to public;
select lives_ok($$select public.claim_manual_transfer((select id from t_b), 'sent')$$, 'the reader reports the transfer');
reset role;
update public.offers set price_minor = 120000 where id = 'f6b00000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000003', true);
select is(public.create_bundle_order('f6a00000-0000-0000-0000-000000000001'), (select id from t_b), 'buying again returns the same order');
reset role;
select is((select status::text from public.orders where id = (select id from t_b)), 'pending', 'and it is still pending, not cancelled');

-- (21) Rollback never revives an archived edition.
update public.editions set status = 'archived' where id = 'f6400000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.rollback_publication('f6300000-0000-0000-0000-000000000001', 'f6600000-0000-0000-0000-000000000003')$$, 'EB012', null, 'an archived edition cannot be rolled back to life');
reset role;
select is((select status::text from public.editions where id = 'f6400000-0000-0000-0000-000000000001'), 'archived', 'and stays archived');

-- (23) The default cannot be a blocked or archived edition.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.admin_set_default_edition('f6300000-0000-0000-0000-000000000001', 'en', 'f6400000-0000-0000-0000-000000000001')$$, 'EB012', null, 'an archived edition cannot be made the language default');
reset role;

-- (24) A feedback report without a locator is accepted.
update public.editions set status = 'published' where id = 'f6400000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.submit_edition_feedback('f6600000-0000-0000-0000-000000000001', null, 'A clause is missing.')$$, 'a report with no locator is saved');
reset role;

-- Changing the language of an approved edition withdraws its approval.
update public.editions set editorial_state = 'approved', reviewed_by = (select admin from t_p), reviewed_at = now() where id = 'f6400000-0000-0000-0000-000000000001';
update public.entitlements set status = 'revoked', revoked_at = now() where edition_id = 'f6400000-0000-0000-0000-000000000001' and status = 'active';
delete from public.library_items where edition_id = 'f6400000-0000-0000-0000-000000000001';
delete from public.order_items where edition_id = 'f6400000-0000-0000-0000-000000000001';
delete from public.entitlements where edition_id = 'f6400000-0000-0000-0000-000000000001';
delete from public.edition_feedback;
delete from public.book_language_editions where edition_id = 'f6400000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f6100000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.admin_save_edition('f6400000-0000-0000-0000-000000000001', null, 1, null, null, '[]'::jsonb, 'vi')$$, 'the language of a never-sold edition can change');
reset role;
select is((select editorial_state from public.editions where id = 'f6400000-0000-0000-0000-000000000001'), 'unreviewed', 'and that withdraws its approval');

select * from finish();
rollback;
