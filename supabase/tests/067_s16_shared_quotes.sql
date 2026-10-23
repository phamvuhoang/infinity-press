begin;
select plan(34);

-- S16 shared quote cards: entitlement-gated creation through the publication, random codes, a
-- per-profile cap, public reads of active cards of published books only, owner and admin removal
-- that never reissues a code, and a share_quote analytics row written with the card.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1600000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's16-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1600000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's16-stranger@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1600000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's16-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1600000-0000-0000-0000-000000000003';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1630000-0000-0000-0000-000000000001', 's16-author', 'S16 Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e1620000-0000-0000-0000-000000000001', 's16-book', 'vi', 'e1630000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values ('e1620000-0000-0000-0000-000000000001', 'vi', 's16-book', 'Sách S16');
-- Publication chain as reader_annotations.test.sql seeds it: edition -> asset -> publication.
insert into public.editions (id, book_id, language_code)
values ('e1610000-0000-0000-0000-000000000001', 'e1620000-0000-0000-0000-000000000001', 'vi');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('e1660000-0000-0000-0000-000000000001', 'e1610000-0000-0000-0000-000000000001', 's16/live.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('e1640000-0000-0000-0000-000000000001', 'e1660000-0000-0000-0000-000000000001', 1, 's16/live.json', 'published');
update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'e1640000-0000-0000-0000-000000000001' and (b.id = 'e1620000-0000-0000-0000-000000000001');
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select 'e1650000-0000-0000-0000-000000000001', p.id, 'e1620000-0000-0000-0000-000000000001', 'admin_grant', p.id, 'fixture', 'active'
from public.profiles p where p.auth_user_id = 'e1600000-0000-0000-0000-000000000001';

-- Privileges --------------------------------------------------------------------------------------
select is(has_table_privilege('anon', 'public.shared_quotes', 'select'), false, 'anon cannot read the table');
select is(has_table_privilege('authenticated', 'public.shared_quotes', 'select'), false, 'authenticated cannot read the table');
select is(has_function_privilege('anon', 'public.catalog_shared_quote(text)', 'execute'), true, 'anon can read a card through the RPC');
select is(has_function_privilege('anon', 'public.create_shared_quote(uuid, text, text, text, text, integer)', 'execute'), false, 'anon cannot create');
select is(has_function_privilege('authenticated', 'public.shared_quote_graphemes(text)', 'execute'), false, 'the grapheme counter is internal');
select is(public.shared_quote_graphemes(repeat(E'e\u0302\u0301', 300)), 300, 'decomposed Vietnamese counts one per grapheme');

-- Creation ----------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', 'Một câu.', 'vi')$$, 'EB039', null, 'a stranger cannot share');
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', '   ', 'vi')$$, 'EB039', null, 'an empty quote is refused');
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', '<b>x</b>', 'vi')$$, 'EB039', null, 'html is refused');
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', repeat('x', 1201), 'vi')$$, 'EB039', null, 'an over-long quote is refused');
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', repeat('x', 301), 'vi')$$, 'EB039', null, 'a direct call cannot skip the 300-grapheme rule');
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', 'x', 'fr')$$, 'EB039', null, 'an unknown locale is refused');
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-0000000000ff', 'x', 'vi')$$, 'EB039', null, 'an unknown publication is refused with the same code');

create temporary table t_created as
select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', '  Một câu đáng nhớ.  ', 'vi') as card;
grant select on t_created to public;
select matches((select card ->> 'code' from t_created), '^[A-Za-z0-9_-]{10}$', 'the code is 10 base64url characters');
reset role;
select results_eq(
  $$select q.quote, q.locale, q.status, q.book_id from public.shared_quotes q where q.code = (select card ->> 'code' from t_created)$$,
  $$values ('Một câu đáng nhớ.', 'vi', 'active', 'e1620000-0000-0000-0000-000000000001'::uuid)$$,
  'the row is trimmed, active, and tied to the publication''s book');
select results_eq(
  $$select e.event_name, e.book_id, e.locale, e.shared_quote_id::text from public.analytics_events e where e.dedupe_key = 'share/' || (select card ->> 'id' from t_created)$$,
  $$values ('share_quote', 'e1620000-0000-0000-0000-000000000001'::uuid, 'vi', (select card ->> 'id' from t_created))$$,
  'creation writes one share_quote event carrying ids only');

-- Public read -------------------------------------------------------------------------------------
set local role anon;
select is((select public.catalog_shared_quote((select card ->> 'code' from t_created)) ->> 'quote'), 'Một câu đáng nhớ.', 'anon reads the active card');
select is(public.catalog_shared_quote('nope-nope-'), null, 'an unknown code is null');
reset role;

-- Cap ---------------------------------------------------------------------------------------------
insert into public.shared_quotes (code, book_id, publication_id, profile_id, quote, locale)
select 'cap' || lpad(g::text, 7, '0'), 'e1620000-0000-0000-0000-000000000001', 'e1640000-0000-0000-0000-000000000001', p.id, 'cap ' || g, 'vi'
from generate_series(1, 199) g, public.profiles p where p.auth_user_id = 'e1600000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', 'one more', 'vi')$$, 'EB038', null, 'the 201st active card is refused');

-- Owner list and removal --------------------------------------------------------------------------
select is(jsonb_array_length(public.my_shared_quotes()), 200, 'the owner lists their cards');
select is((select e ->> 'viewCount' from jsonb_array_elements(public.my_shared_quotes()) e where e ->> 'code' = (select card ->> 'code' from t_created)), '0', 'a fresh card has zero views');
reset role;
insert into public.analytics_events (event_name, shared_quote_id, book_id, locale)
select 'view_quote', (card ->> 'id')::uuid, 'e1620000-0000-0000-0000-000000000001', 'vi' from t_created;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select is((select e ->> 'viewCount' from jsonb_array_elements(public.my_shared_quotes()) e where e ->> 'code' = (select card ->> 'code' from t_created)), '1', 'views come from analytics');
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000002', true);
select lives_ok($$select public.remove_shared_quote((select card ->> 'code' from t_created))$$, 'a stranger''s removal is a silent no-op');
reset role;
select results_eq($$select status from public.shared_quotes where code = (select card ->> 'code' from t_created)$$, array['active'], 'the stranger changed nothing');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.remove_shared_quote((select card ->> 'code' from t_created))$$, 'the owner removes');
select is(public.catalog_shared_quote((select card ->> 'code' from t_created)), null, 'a removed card is gone from the public read');
select lives_ok($$select public.create_shared_quote('e1640000-0000-0000-0000-000000000001', 'room again', 'vi')$$, 'removing frees a slot under the cap');
reset role;
select results_eq($$select removed_by from public.shared_quotes where code = (select card ->> 'code' from t_created)$$, array['owner'], 'removal records who removed');

-- Admin -------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000001', true);
select is(public.admin_list_shared_quotes(null), null, 'a reader gets null from the admin list');
select throws_ok($$select public.admin_remove_shared_quote('cap0000001')$$, '42501', null, 'a reader cannot take down');
select set_config('request.jwt.claim.sub', 'e1600000-0000-0000-0000-000000000003', true);
select is(jsonb_array_length(public.admin_list_shared_quotes('e1620000-0000-0000-0000-000000000001')), 200, 'the admin lists active cards for a book');
select lives_ok($$select public.admin_remove_shared_quote('cap0000001')$$, 'the admin takes a card down');
reset role;
select results_eq(
  $$select action, entity_type, (metadata ? 'quote')::text from public.audit_logs where entity_id = (select id from public.shared_quotes where code = 'cap0000001')$$,
  $$values ('shared_quote.remove'::text, 'shared_quotes'::text, 'false')$$, 'one audit row, no quote text');

-- Unpublished book --------------------------------------------------------------------------------
update public.books set status = 'draft' where id = 'e1620000-0000-0000-0000-000000000001';
select is(public.catalog_shared_quote('cap0000002'), null, 'a card of an unpublished book is not readable');

select * from finish();
rollback;
