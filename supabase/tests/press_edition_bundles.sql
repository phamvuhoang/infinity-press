begin;
select plan(23);

-- Press Task 7: a bundle holds editions. English + Japanese of one work is an intentional bundle;
-- ownership, snapshots and staleness are per edition.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e8100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'eb-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e8100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'eb-buyer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e8100000-0000-0000-0000-000000000001';
create temporary table t_p as
select (select id from public.profiles where auth_user_id = 'e8100000-0000-0000-0000-000000000002') as buyer;
grant select on t_p to public;
update public.customer_identities set verified_at = now() where profile_id = (select buyer from t_p);

insert into public.authors (id, canonical_slug, display_name, status) values ('e8200000-0000-0000-0000-000000000001', 'eb-author', 'EB Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e8300000-0000-0000-0000-000000000001', 'eb-one', 'en', 'e8200000-0000-0000-0000-000000000001', 'published'),
  ('e8300000-0000-0000-0000-000000000002', 'eb-two', 'en', 'e8200000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e8300000-0000-0000-0000-000000000001', 'en', 'eb-one', 'Work One'),
  ('e8300000-0000-0000-0000-000000000001', 'ja', 'eb-one-ja', '作品その一'),
  ('e8300000-0000-0000-0000-000000000002', 'en', 'eb-two', 'Work Two');
insert into public.editions (id, book_id, language_code, status) values
  ('e8400000-0000-0000-0000-000000000001', 'e8300000-0000-0000-0000-000000000001', 'en', 'published'),
  ('e8400000-0000-0000-0000-000000000002', 'e8300000-0000-0000-0000-000000000001', 'ja', 'published'),
  ('e8400000-0000-0000-0000-000000000003', 'e8300000-0000-0000-0000-000000000002', 'en', 'published'),
  ('e8400000-0000-0000-0000-000000000004', 'e8300000-0000-0000-0000-000000000002', 'ja', 'draft');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
select ('e8500000-0000-0000-0000-00000000000' || n)::uuid, ('e8400000-0000-0000-0000-00000000000' || n)::uuid, 'eb/' || n || '.epub', 1, 'published'
from generate_series(1, 3) n;
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language)
select ('e8600000-0000-0000-0000-00000000000' || n)::uuid, ('e8500000-0000-0000-0000-00000000000' || n)::uuid, 1, 'eb/' || n || '.json', 'published', case when n = 2 then 'ja' else 'en' end
from generate_series(1, 3) n;
update public.editions e set active_publication_id = ('e8600000-0000-0000-0000-00000000000' || right(e.id::text, 1))::uuid where right(e.id::text, 1) in ('1', '2', '3');
insert into public.skus (id, edition_id, sku_code)
select ('e8700000-0000-0000-0000-00000000000' || n)::uuid, ('e8400000-0000-0000-0000-00000000000' || n)::uuid, 'EB-SKU-' || n from generate_series(1, 4) n;

insert into public.bundles (id, status) values
  ('e8800000-0000-0000-0000-000000000001', 'published'),
  ('e8800000-0000-0000-0000-000000000002', 'published');
insert into public.bundle_localizations (bundle_id, locale, slug, title, description) values
  ('e8800000-0000-0000-0000-000000000001', 'en', 'eb-bilingual', 'Bilingual Pair', 'Both languages'),
  ('e8800000-0000-0000-0000-000000000002', 'en', 'eb-usd', 'Dollar Pair', 'In dollars');
insert into public.offers (id, bundle_id, market_code, currency, price_minor, active) values
  ('e8900000-0000-0000-0000-000000000001', 'e8800000-0000-0000-0000-000000000001', 'VN', 'VND', 200000, true),
  ('e8900000-0000-0000-0000-000000000002', 'e8800000-0000-0000-0000-000000000002', 'US', 'USD', 1500, true);

update public.commerce_settings set payments_enabled = true, payment_provider = 'manual', payable_currencies = array['VND'];

-- (1)-(4) Membership is editions; the same work can appear twice in two languages.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e8100000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.admin_set_bundle_members('e8800000-0000-0000-0000-000000000001', array['e8400000-0000-0000-0000-000000000001', 'e8400000-0000-0000-0000-000000000002', 'e8400000-0000-0000-0000-000000000003']::uuid[])$$, 'an admin sets a bilingual membership');
select lives_ok($$select public.admin_set_bundle_members('e8800000-0000-0000-0000-000000000002', array['e8400000-0000-0000-0000-000000000001', 'e8400000-0000-0000-0000-000000000003']::uuid[])$$, 'and a second bundle');
reset role;
select is((select count(*) from public.bundle_editions where bundle_id = 'e8800000-0000-0000-0000-000000000001'), 3::bigint, 'three editions are members');
select is((select count(*) from public.bundle_books where bundle_id = 'e8800000-0000-0000-0000-000000000001'), 2::bigint, 'the work-level read model has the two works, not three rows');

-- (5)-(6) The lines are the editions, with languages and per-edition SKUs.
select is((select string_agg(language_code, ',' order by line_position) from public.bundle_order_lines('e8800000-0000-0000-0000-000000000001')), 'en,ja,en', 'lines carry each edition''s language in membership order');
select is((select title_snapshot from public.bundle_order_lines('e8800000-0000-0000-0000-000000000001') where language_code = 'ja'), '作品その一', 'and the title in that language');

-- (7) A draft or unpublished edition is not sellable, so readiness counts only sellable editions.
select ok(public.bundle_edition_is_sellable('e8400000-0000-0000-0000-000000000001') and not public.bundle_edition_is_sellable('e8400000-0000-0000-0000-000000000004'), 'only published editions with a live publication are sellable');

-- (8)-(14) Ordering.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e8100000-0000-0000-0000-000000000002', true);
create temporary table t_o as select public.create_bundle_order('e8800000-0000-0000-0000-000000000001') as id;
grant select on t_o to public;
select is((select string_agg(edition_id::text || ':' || language_code, ',' order by position) from public.order_items where order_id = (select id from t_o)),
  'e8400000-0000-0000-0000-000000000001:en,e8400000-0000-0000-0000-000000000002:ja,e8400000-0000-0000-0000-000000000003:en', 'the order snapshots every edition and its language');
select is((select sum(unit_price_minor) from public.order_items where order_id = (select id from t_o)), 200000::numeric, 'the bundle price is carried once');
select is(public.create_bundle_order('e8800000-0000-0000-0000-000000000001'), (select id from t_o), 'a second request returns the open order');
select throws_ok($$select public.create_bundle_order('e8800000-0000-0000-0000-000000000002')$$, 'EB041', null, 'a USD bundle cannot be bought by transfer');

-- (12) Editing the bundle makes the open order stale: a different product is a different order.
reset role;
update public.commerce_settings set payments_enabled = true;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e8100000-0000-0000-0000-000000000001', true);
select public.admin_set_bundle_members('e8800000-0000-0000-0000-000000000001', array['e8400000-0000-0000-0000-000000000001', 'e8400000-0000-0000-0000-000000000002']::uuid[]);
select set_config('request.jwt.claim.sub', 'e8100000-0000-0000-0000-000000000002', true);
create temporary table t_o2 as select public.create_bundle_order('e8800000-0000-0000-0000-000000000001') as id;
grant select on t_o2 to public;
select isnt((select id from t_o2), (select id from t_o), 'a bundle that changed makes a new order');
reset role;
select is((select status::text from public.orders where id = (select id from t_o)), 'cancelled', 'and the old one is cancelled');
select is((select count(*) from public.order_items where order_id = (select id from t_o2)), 2::bigint, 'the new order holds the new membership');

-- (15)-(17) Ownership is per edition.
insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status)
values ((select buyer from t_p), 'e8300000-0000-0000-0000-000000000001', 'e8400000-0000-0000-0000-000000000001', 'admin_grant', (select buyer from t_p), 'eb fixture', 'active');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e8100000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.create_bundle_order('e8800000-0000-0000-0000-000000000001')$$, 'owning English leaves the bundle buyable for the Japanese edition');
reset role;
insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status)
values ((select buyer from t_p), 'e8300000-0000-0000-0000-000000000001', 'e8400000-0000-0000-0000-000000000002', 'admin_grant', (select buyer from t_p), 'eb fixture', 'active');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e8100000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.create_bundle_order('e8800000-0000-0000-0000-000000000001')$$, 'EB013', null, 'owning every edition leaves nothing to buy');

-- (18)-(19) Membership validation.
select set_config('request.jwt.claim.sub', 'e8100000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.admin_set_bundle_members('e8800000-0000-0000-0000-000000000001', array['e8400000-0000-0000-0000-000000000001', 'e8400000-0000-0000-0000-000000000001']::uuid[])$$, '22023', null, 'an edition can be listed once');
select throws_ok($$select public.admin_set_bundle_members('e8800000-0000-0000-0000-000000000001', array['e8300000-0000-0000-0000-000000000001']::uuid[])$$, 'P0002', null, 'a book id is not an edition id');

-- (20)-(21) Readiness counts sellable editions.
reset role;
select ok('too_few_published_members' = any (public.bundle_readiness_issues('e8800000-0000-0000-0000-000000000002')) is not true, 'a two-edition bundle with sellable editions is not short of members');
update public.editions set status = 'archived' where id = 'e8400000-0000-0000-0000-000000000003';
select ok('too_few_published_members' = any (public.bundle_readiness_issues('e8800000-0000-0000-0000-000000000002')), 'losing a sellable edition makes it short of members');

-- (22)-(24) Privileges.
select ok(not has_function_privilege('anon', 'public.admin_set_bundle_members(uuid, uuid[])', 'execute'), 'anon cannot set members');
select ok(has_function_privilege('authenticated', 'public.create_bundle_order(uuid)', 'execute'), 'a reader can order a bundle');
select ok(not has_function_privilege('authenticated', 'public.bundle_order_lines(uuid)', 'execute'), 'but cannot read the line builder directly');

select * from finish();
rollback;
