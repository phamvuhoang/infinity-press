begin;

-- Editorial columns are not granted to the API roles; the test reads them as the table owner.
create function public.t_edition_row(p_id uuid) returns public.editions language sql security definer set search_path = '' as $f$
  select * from public.editions where id = p_id $f$;
grant execute on function public.t_edition_row(uuid) to authenticated, anon;
select plan(41);

-- Press Task 9: provenance, editorial approval before publishing, and reader error reports.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'ec100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ed-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'ec100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ed-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'ec100000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'ed-stranger@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'ec100000-0000-0000-0000-000000000001';
create temporary table t_p as
select (select id from public.profiles where auth_user_id = 'ec100000-0000-0000-0000-000000000001') as admin_id,
       (select id from public.profiles where auth_user_id = 'ec100000-0000-0000-0000-000000000002') as reader_id;
grant select on t_p to public;
update public.customer_identities set verified_at = now();

insert into public.authors (id, canonical_slug, display_name, status) values ('ec200000-0000-0000-0000-000000000001', 'ed-author', 'ED Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('ec300000-0000-0000-0000-000000000001', 'ed-book', 'en', 'ec200000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values ('ec300000-0000-0000-0000-000000000001', 'en', 'ed-book', 'ED Book');
insert into public.editions (id, book_id, language_code, status) values
  ('ec400000-0000-0000-0000-000000000001', 'ec300000-0000-0000-0000-000000000001', 'en', 'draft'),
  ('ec400000-0000-0000-0000-000000000002', 'ec300000-0000-0000-0000-000000000001', 'ja', 'draft');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('ec500000-0000-0000-0000-000000000001', 'ec400000-0000-0000-0000-000000000001', 'ed/en.epub', 1, 'ready_for_preview'),
  ('ec500000-0000-0000-0000-000000000002', 'ec400000-0000-0000-0000-000000000002', 'ed/ja.epub', 1, 'ready_for_preview');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language) values
  ('ec600000-0000-0000-0000-000000000001', 'ec500000-0000-0000-0000-000000000001', 1, 'ed/en.json', 'ready_for_preview', 'en'),
  ('ec600000-0000-0000-0000-000000000002', 'ec500000-0000-0000-0000-000000000002', 1, 'ed/ja.json', 'ready_for_preview', 'ja');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ec100000-0000-0000-0000-000000000001', true);

-- (1)-(4) An unreviewed edition cannot be published; the reason is named.
select throws_ok($$select public.publish_publication('ec600000-0000-0000-0000-000000000001')$$, 'EB012', null, 'an unreviewed edition cannot go live');
select is(public.publication_readiness_issues('ec600000-0000-0000-0000-000000000001'), array['editorial_unreviewed'], 'and the readiness list says why');
select is((select editorial_state from public.t_edition_row('ec400000-0000-0000-0000-000000000001')), 'unreviewed', 'new editions start unreviewed');
select is((select status::text from public.editions where id = 'ec400000-0000-0000-0000-000000000001'), 'draft', 'and nothing changed');

-- (5)-(9) Provenance is recorded by admins only, and approval needs the evidence.
select throws_ok($$select public.admin_set_edition_review('ec400000-0000-0000-0000-000000000001', 'approved', null)$$, 'EB044', null, 'approval needs the translation source, rights note and territories');
select lives_ok($$select public.admin_save_edition_provenance('ec400000-0000-0000-0000-000000000001', 'Original text: 1912 edition', 'Translated 1925 by T. Translator', 'Public domain in the origin country; see file.', 'Worldwide except where local law differs')$$, 'an admin records the provenance');
select lives_ok($$select public.admin_set_edition_review('ec400000-0000-0000-0000-000000000001', 'approved', 'Checked against the scan.')$$, 'and approves it');
select is((select reviewed_by from public.t_edition_row('ec400000-0000-0000-0000-000000000001')), (select admin_id from t_p), 'the reviewer is the acting admin');
select ok((select reviewed_at is not null from public.t_edition_row('ec400000-0000-0000-0000-000000000001')), 'and the date is recorded');

-- (10)-(12) Approved: it publishes. The other edition is untouched.
select lives_ok($$select public.publish_publication('ec600000-0000-0000-0000-000000000001')$$, 'an approved edition publishes');
select is((select status::text from public.editions where id = 'ec400000-0000-0000-0000-000000000001'), 'published', 'it is published');
select throws_ok($$select public.publish_publication('ec600000-0000-0000-0000-000000000002')$$, 'EB012', null, 'the Japanese edition still cannot, it was not reviewed');

-- (13)-(16) Blocking needs a reason and stops publishing.
select throws_ok($$select public.admin_set_edition_review('ec400000-0000-0000-0000-000000000002', 'blocked', '  ')$$, '22023', null, 'a block needs a reason');
select lives_ok($$select public.admin_set_edition_review('ec400000-0000-0000-0000-000000000002', 'blocked', 'Rights unclear for the Japanese translation.')$$, 'a block with a reason is recorded');
select is(public.publication_readiness_issues('ec600000-0000-0000-0000-000000000002'), array['editorial_blocked'], 'and reads as blocked');
select throws_ok($$select public.admin_set_edition_review('ec400000-0000-0000-0000-000000000002', 'maybe', null)$$, '22023', null, 'an unknown state is refused');

-- (17)-(19) Changing the evidence after approval withdraws the approval.
select lives_ok($$select public.admin_save_edition_provenance('ec400000-0000-0000-0000-000000000001', 'Original text: 1912 edition', 'Translated 1925 by T. Translator', 'Rights note revised.', 'Worldwide')$$, 'the rights note is revised after approval');
select is((select editorial_state from public.t_edition_row('ec400000-0000-0000-0000-000000000001')), 'unreviewed', 'the approval no longer stands');
select ok((select reviewed_by is null and reviewed_at is null from public.t_edition_row('ec400000-0000-0000-0000-000000000001')), 'and its reviewer and date are cleared with it');

-- (20)-(21) Re-saving identical evidence changes nothing; non-admins cannot decide.
select lives_ok($$select public.admin_set_edition_review('ec400000-0000-0000-0000-000000000001', 'approved', null)$$, 'it is approved again');
select lives_ok($$select public.admin_save_edition_provenance('ec400000-0000-0000-0000-000000000001', 'Original text: 1912 edition', 'Translated 1925 by T. Translator', 'Rights note revised.', 'Worldwide')$$, 'saving the same evidence again');
select is((select editorial_state from public.t_edition_row('ec400000-0000-0000-0000-000000000001')), 'approved', 'keeps the approval');

reset role;
-- The reader holds the Japanese... no: the English edition, now published and approved.
insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status)
values ((select reader_id from t_p), 'ec300000-0000-0000-0000-000000000001', 'ec400000-0000-0000-0000-000000000001', 'admin_grant', (select admin_id from t_p), 'ed fixture', 'active');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ec100000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.admin_set_edition_review('ec400000-0000-0000-0000-000000000001', 'approved', null)$$, '42501', null, 'a reader cannot review an edition');
select throws_ok($$select public.admin_save_edition_provenance('ec400000-0000-0000-0000-000000000001', 'x', 'x', 'x', 'x')$$, '42501', null, 'or edit its provenance');

-- (24)-(30) Error reports: owners only, plain text, small locator, rate limited.
select lives_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', '{"href":"OEBPS/text/chapter1.xhtml","progression":0.4}'::jsonb, 'The second sentence drops a clause.')$$, 'an owner reports an error with its place');
select throws_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', null, '<b>bold</b>')$$, '22023', null, 'markup is refused');
select throws_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', null, repeat('a', 2001))$$, '22023', null, 'the message is limited to 2000 characters');
select throws_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', '[1]'::jsonb, 'ok')$$, '22023', null, 'the location must be an object');
select throws_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000002', null, 'A report about an edition I do not own')$$, 'EB008', null, 'an edition the reader cannot read cannot be reported');
select lives_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', null, 'Second')$$, 'a second report is allowed');
select lives_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', null, 'Third')$$, 'and a third');

select lives_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', null, 'Fourth')$$, 'a fourth');
select lives_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', null, 'Fifth')$$, 'a fifth');
select throws_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', null, 'Sixth')$$, 'EB045', null, 'the sixth within the hour is rate limited');

-- (35)-(39) The inbox: admins read and resolve; readers do not.
select is(public.admin_list_edition_feedback('new'), null::jsonb, 'a reader gets nothing from the inbox');
select set_config('request.jwt.claim.sub', 'ec100000-0000-0000-0000-000000000001', true);
select is(jsonb_array_length(public.admin_list_edition_feedback('new')), 5, 'an admin sees the five reports');
select is((select count(*) from jsonb_array_elements(public.admin_list_edition_feedback('new')) e where e ->> 'message' = 'The second sentence drops a clause.' and e -> 'locator' ->> 'href' = 'OEBPS/text/chapter1.xhtml'), 1::bigint, 'with the reader''s words and their place');
select lives_ok($$select public.admin_resolve_edition_feedback((select id from public.edition_feedback order by created_at, id limit 1), 'resolved', 'Fixed in v2.')$$, 'an admin resolves one');
select is(jsonb_array_length(public.admin_list_edition_feedback('new')), 4, 'and it leaves the new list');

-- (40)-(41) Nothing is open to visitors.
reset role;
set local role anon;
select throws_ok($$select public.submit_edition_feedback('ec600000-0000-0000-0000-000000000001', null, 'anon')$$, '42501', null, 'a visitor cannot submit');
select throws_ok($$select count(*) from public.edition_feedback$$, '42501', null, 'or read the reports');

select * from finish();
rollback;
