begin;
select plan(42);

-- The work-level order entry point was removed by the contract migration. This fixture stands in for
-- it (one edition on sale -> that edition's best payable offer) so these older tests keep exercising
-- the order machinery through create_edition_order.
create function public.create_ebook_order(p_book_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $f$
declare v_edition_ids uuid[]; v_offer_id uuid;
begin
  select array_agg(distinct s.edition_id) into v_edition_ids
  from public.offers o join public.skus s on s.id = o.sku_id and s.active
  join public.editions ed on ed.id = s.edition_id
  where ed.book_id = p_book_id and ed.status = 'published' and ed.active_publication_id is not null
    and o.active and public.offer_effective_price_minor(o) > 0
    and (o.starts_at is null or o.starts_at <= now()) and (o.ends_at is null or o.ends_at > now());
  if coalesce(cardinality(v_edition_ids), 0) = 0 then
    raise exception 'create_ebook_order: book % is not purchasable', p_book_id using errcode = 'EB012';
  end if;
  if cardinality(v_edition_ids) > 1 then
    raise exception 'create_ebook_order: book % has several editions on sale; name one', p_book_id using errcode = 'EB042';
  end if;
  select o.id into v_offer_id from public.offers o join public.skus s on s.id = o.sku_id and s.active
  where s.edition_id = v_edition_ids[1] and o.active and public.offer_effective_price_minor(o) > 0
    and (o.starts_at is null or o.starts_at <= now()) and (o.ends_at is null or o.ends_at > now())
  order by public.currency_is_payable(o.currency) desc, public.offer_effective_price_minor(o), o.currency limit 1;
  return public.create_edition_order(v_edition_ids[1], v_offer_id, null);
end $f$;
revoke all on function public.create_ebook_order(uuid) from public, anon;
grant execute on function public.create_ebook_order(uuid) to authenticated;


-- Press Task 6: manual-transfer orders are per edition. English and Japanese of one work are
-- separate products, orders, payments and entitlements; only VND can be paid by transfer.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e7100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'eo-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e7100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'eo-r1@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e7100000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'eo-unverified@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e7100000-0000-0000-0000-000000000001';
create temporary table t_p as
select (select id from public.profiles where auth_user_id = 'e7100000-0000-0000-0000-000000000002') as r1;
grant select on t_p to public;
update public.customer_identities set verified_at = now() where profile_id = (select r1 from t_p);
update public.customer_identities set verified_at = null
where profile_id = (select id from public.profiles where auth_user_id = 'e7100000-0000-0000-0000-000000000003');
update public.customer_identities set verified_at = now()
where profile_id = (select id from public.profiles where auth_user_id = 'e7100000-0000-0000-0000-000000000001');

insert into public.authors (id, canonical_slug, display_name, status) values ('e7200000-0000-0000-0000-000000000001', 'eo-author', 'EO Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e7300000-0000-0000-0000-000000000001', 'eo-two', 'en', 'e7200000-0000-0000-0000-000000000001', 'published'),
  ('e7300000-0000-0000-0000-000000000002', 'eo-one', 'en', 'e7200000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e7300000-0000-0000-0000-000000000001', 'en', 'eo-two', 'Two Languages'),
  ('e7300000-0000-0000-0000-000000000001', 'ja', 'eo-two-ja', '二つの言語'),
  ('e7300000-0000-0000-0000-000000000002', 'en', 'eo-one', 'One Language');
insert into public.editions (id, book_id, language_code, status) values
  ('e7400000-0000-0000-0000-000000000001', 'e7300000-0000-0000-0000-000000000001', 'en', 'published'),
  ('e7400000-0000-0000-0000-000000000002', 'e7300000-0000-0000-0000-000000000001', 'ja', 'published'),
  ('e7400000-0000-0000-0000-000000000003', 'e7300000-0000-0000-0000-000000000002', 'en', 'published'),
  ('e7400000-0000-0000-0000-000000000004', 'e7300000-0000-0000-0000-000000000002', 'ja', 'draft');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('e7500000-0000-0000-0000-000000000001', 'e7400000-0000-0000-0000-000000000001', 'eo/en.epub', 1, 'published'),
  ('e7500000-0000-0000-0000-000000000002', 'e7400000-0000-0000-0000-000000000002', 'eo/ja.epub', 1, 'published'),
  ('e7500000-0000-0000-0000-000000000003', 'e7400000-0000-0000-0000-000000000003', 'eo/one.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language) values
  ('e7600000-0000-0000-0000-000000000001', 'e7500000-0000-0000-0000-000000000001', 1, 'eo/en.json', 'published', 'en'),
  ('e7600000-0000-0000-0000-000000000002', 'e7500000-0000-0000-0000-000000000002', 1, 'eo/ja.json', 'published', 'ja'),
  ('e7600000-0000-0000-0000-000000000003', 'e7500000-0000-0000-0000-000000000003', 1, 'eo/one.json', 'published', 'en');
update public.editions set active_publication_id = 'e7600000-0000-0000-0000-000000000001' where id = 'e7400000-0000-0000-0000-000000000001';
update public.editions set active_publication_id = 'e7600000-0000-0000-0000-000000000002' where id = 'e7400000-0000-0000-0000-000000000002';
update public.editions set active_publication_id = 'e7600000-0000-0000-0000-000000000003' where id = 'e7400000-0000-0000-0000-000000000003';
insert into public.skus (id, edition_id, sku_code) values
  ('e7700000-0000-0000-0000-000000000001', 'e7400000-0000-0000-0000-000000000001', 'EO-EN'),
  ('e7700000-0000-0000-0000-000000000002', 'e7400000-0000-0000-0000-000000000002', 'EO-JA'),
  ('e7700000-0000-0000-0000-000000000003', 'e7400000-0000-0000-0000-000000000003', 'EO-ONE'),
  ('e7700000-0000-0000-0000-000000000004', 'e7400000-0000-0000-0000-000000000004', 'EO-DRAFT');
insert into public.offers (id, sku_id, market_code, currency, price_minor) values
  ('e7800000-0000-0000-0000-000000000001', 'e7700000-0000-0000-0000-000000000001', 'VN', 'VND', 50000),
  ('e7800000-0000-0000-0000-000000000002', 'e7700000-0000-0000-0000-000000000002', 'VN', 'VND', 70000),
  ('e7800000-0000-0000-0000-000000000003', 'e7700000-0000-0000-0000-000000000002', 'JP', 'JPY', 500),
  ('e7800000-0000-0000-0000-000000000004', 'e7700000-0000-0000-0000-000000000001', 'US', 'USD', 500),
  ('e7800000-0000-0000-0000-000000000005', 'e7700000-0000-0000-0000-000000000003', 'VN', 'VND', 30000),
  ('e7800000-0000-0000-0000-000000000006', 'e7700000-0000-0000-0000-000000000004', 'VN', 'VND', 30000),
  ('e7800000-0000-0000-0000-000000000007', 'e7700000-0000-0000-0000-000000000003', 'ZZ', 'VND', 0);
update public.offers set active = false where id = 'e7800000-0000-0000-0000-000000000007';

-- (1)-(3) Settings: manual is the default provider and only VND can be paid. The row itself is set
-- here, because an earlier file in the suite commits its own settings from another connection.
update public.commerce_settings set payment_provider = 'manual', payments_enabled = false, payable_currencies = array['VND'];
select is((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'commerce_settings' and column_name = 'payment_provider'), '''manual''::text', 'the database default provider is manual');
select is((select payable_currencies from public.commerce_settings), array['VND'], 'only VND is payable by transfer');
select ok(public.currency_is_payable('VND') and not public.currency_is_payable('USD') and not public.currency_is_payable('JPY'), 'the currency gate says VND yes, USD and JPY no');

-- Payments are off until the release step turns them on.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.create_edition_order('e7400000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000001')$$, 'EB011', null, '(4) with payments off no order is created');
reset role;
update public.commerce_settings set payments_enabled = true;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000002', true);

-- (5)-(11) The English order and its snapshot.
create temporary table t_o as select public.create_edition_order('e7400000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000001', 50000) as en;
grant select on t_o to public;
select is((select count(*) from public.order_items where order_id = (select en from t_o)), 1::bigint, 'the English order has one line');
select is((select edition_id from public.order_items where order_id = (select en from t_o)), 'e7400000-0000-0000-0000-000000000001'::uuid, 'the line names the edition');
select is((select language_code from public.order_items where order_id = (select en from t_o)), 'en', 'and snapshots its language');
select is((select offer_id from public.order_items where order_id = (select en from t_o)), 'e7800000-0000-0000-0000-000000000001'::uuid, 'and the offer');
select is((select unit_price_minor from public.order_items where order_id = (select en from t_o)), 50000::bigint, 'and the amount');
select is((select title_snapshot from public.order_items where order_id = (select en from t_o)), 'Two Languages', 'and the title');
select is((select currency || ':' || payment_provider from public.orders where id = (select en from t_o)), 'VND:manual', 'the order is VND under the manual provider');
reset role;
select is((select amount_minor || ':' || provider || ':' || status from public.payments where order_id = (select en from t_o)), '50000:manual:pending', 'its payment row matches');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000002', true);

-- (12) Pressing Buy again returns the same order.
select is(public.create_edition_order('e7400000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000001', 50000), (select en from t_o), 'a second request returns the open order');

-- (13)-(20) Everything the chain refuses.
select throws_ok($$select public.create_edition_order('e7400000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000001', 49999)$$, 'EB040', null, 'a changed price is EB040, not a surprise charge');
select throws_ok($$select public.create_edition_order('e7400000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000005')$$, 'EB012', null, 'an offer of another edition is not purchasable here');
select throws_ok($$select public.create_edition_order('e7400000-0000-0000-0000-000000000003', 'e7800000-0000-0000-0000-000000000007')$$, 'EB012', null, 'an inactive zero-price offer is not purchasable');
select throws_ok($$select public.create_edition_order('e7400000-0000-0000-0000-000000000004', 'e7800000-0000-0000-0000-000000000006')$$, 'EB012', null, 'a draft edition is not purchasable');
select throws_ok($$select public.create_edition_order('e7400000-0000-0000-0000-000000000002', 'e7800000-0000-0000-0000-000000000003')$$, 'EB041', null, 'a JPY offer cannot be paid by transfer');
select throws_ok($$select public.create_edition_order('e7400000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000004')$$, 'EB041', null, 'a USD offer cannot be paid by transfer');
select is((select count(*) from public.orders where profile_id = (select r1 from t_p)), 1::bigint, 'and none of those left an order behind');
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000003', true);
select throws_ok($$select public.create_edition_order('e7400000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000001')$$, 'EB005', null, 'a reader with no verified email cannot buy');
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000002', true);

-- (21)-(24) A Japanese order is separate, beside the pending English one.
create temporary table t_j as select public.create_edition_order('e7400000-0000-0000-0000-000000000002', 'e7800000-0000-0000-0000-000000000002', 70000) as ja;
grant select on t_j to public;
select isnt((select ja from t_j), (select en from t_o), 'Japanese gets its own order');
select is((select language_code || ':' || unit_price_minor from public.order_items where order_id = (select ja from t_j)), 'ja:70000', 'snapshotting its language and price');
select is((select title_snapshot from public.order_items where order_id = (select ja from t_j)), '二つの言語', 'and the Japanese title');
select is((select count(*) from public.orders where profile_id = (select r1 from t_p) and status = 'pending'), 2::bigint, 'both orders are open at once');


-- (27) A stale order is replaced when the price moves.
reset role;
update public.offers set price_minor = 55000 where id = 'e7800000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000002', true);
create temporary table t_o2 as select public.create_edition_order('e7400000-0000-0000-0000-000000000001', 'e7800000-0000-0000-0000-000000000001', 55000) as en;
grant select on t_o2 to public;
select isnt((select en from t_o2), (select en from t_o), 'a new price makes a new order');
reset role;
select is((select status::text from public.orders where id = (select en from t_o)), 'cancelled', 'and the old one is cancelled');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000002', true);

-- A work-level order for the one-edition book, to settle later.
create temporary table t_w as select public.create_ebook_order('e7300000-0000-0000-0000-000000000002') as id;
grant select on t_w to public;

-- Owning English must not stop a reader paying for Japanese.
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.grant_complimentary_entitlement((select r1 from t_p), 'e7400000-0000-0000-0000-000000000001', 'eo owns english')$$, 'the reader is given English');
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.claim_manual_transfer((select ja from t_j), null)$$, 'owning English does not stop them reporting the Japanese transfer');
select throws_ok($$select public.claim_manual_transfer((select en from t_o2), null)$$, 'EB017', null, 'but reporting a transfer for the English they own is refused');

-- Admin confirmation: amount, reference, and exactly one edition granted.
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000001', true);
select throws_ok($$select * from public.confirm_manual_payment((select ja from t_j), 69000, 'BANK-1', null, false)$$, 'EB021', null, 'a short transfer is refused without an explicit override');
select lives_ok($$select * from public.confirm_manual_payment((select ja from t_j), 70000, 'BANK-1', null, false)$$, 'the right amount confirms the Japanese order');
select is((select count(*) from public.entitlements where profile_id = (select r1 from t_p) and edition_id = 'e7400000-0000-0000-0000-000000000002' and status = 'active' and source_type = 'manual_payment'), 1::bigint, 'it grants the Japanese edition');
select is((select source_type::text from public.entitlements where profile_id = (select r1 from t_p) and edition_id = 'e7400000-0000-0000-0000-000000000001' and status = 'active'), 'admin_grant', 'and leaves the English grant exactly as it was');
select lives_ok($$select * from public.confirm_manual_payment((select ja from t_j), 70000, 'BANK-1', null, false)$$, 'confirming the same order again is a no-op');
select is((select count(*) from public.entitlements where profile_id = (select r1 from t_p) and status = 'active'), 2::bigint, 'and grants nothing twice');
select throws_ok($$select * from public.confirm_manual_payment((select id from t_w), 30000, 'bank-1 ', null, false)$$, 'EB043', null, 'one bank statement line cannot settle a second order');
select lives_ok($$select * from public.confirm_manual_payment((select id from t_w), 30000, 'BANK-2', null, false)$$, 'a different reference settles it');

-- A pending order in a currency the transfer cannot settle is not claimable, whatever wrote it.
reset role;
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, payment_provider)
values ('e7900000-0000-0000-0000-000000000001', (select r1 from t_p), 'pending', 'pending', 'US', 'USD', 500, 500, 'manual');
insert into public.payments (order_id, provider, status, amount_minor, currency)
values ('e7900000-0000-0000-0000-000000000001', 'manual', 'pending', 500, 'USD');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7100000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.claim_manual_transfer('e7900000-0000-0000-0000-000000000001', null)$$, 'EB020', null, 'a USD order cannot be reported as transferred');

-- Order lines carry their edition even when a writer does not say.
reset role;
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
values ((select ja from t_j), 'e7700000-0000-0000-0000-000000000001', 'e7300000-0000-0000-0000-000000000001', 'x', 1, 9);
select is((select edition_id::text || ':' || language_code from public.order_items where order_id = (select ja from t_j) and position = 9), 'e7400000-0000-0000-0000-000000000001:en', 'a line written without an edition takes its SKU''s edition and language');

-- Privileges: a visitor cannot order.
select ok(not has_function_privilege('anon', 'public.create_edition_order(uuid, uuid, bigint)', 'execute'), 'anon cannot create an order');
select ok(has_function_privilege('authenticated', 'public.create_edition_order(uuid, uuid, bigint)', 'execute'), 'a signed-in reader can');

select * from finish();
rollback;
