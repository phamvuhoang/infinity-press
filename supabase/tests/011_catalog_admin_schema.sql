begin;
select plan(19);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's1-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's1-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name)
values ('c2000000-0000-0000-0000-000000000001', 's1-author', 'S1 Author'),
       ('c2000000-0000-0000-0000-000000000002', 's1-author-two', 'S1 Author Two');
insert into public.books (id, canonical_key, original_language, primary_author_id)
values ('c3000000-0000-0000-0000-000000000001', 's1-book', 'vi', 'c2000000-0000-0000-0000-000000000001');
insert into public.series (id, canonical_slug, display_name)
values ('c4000000-0000-0000-0000-000000000001', 's1-series', 'S1 Series');

-- (1)-(6) The new structure exists.
select has_table('public', 'series', 'series table exists');
select has_table('public', 'book_series', 'book_series table exists');
select has_table('public', 'author_localizations', 'author_localizations table exists');
select has_table('public', 'topic_localizations', 'topic_localizations table exists');
select has_table('public', 'series_localizations', 'series_localizations table exists');
select has_column('public', 'book_localizations', 'key_ideas', 'book_localizations has key_ideas');

-- (7) Covers are public; EPUB buckets are untouched by this migration.
select is((select public from storage.buckets where id = 'covers'), true, 'covers bucket is public');

-- (8) anon holds no SELECT on the new admin-only tables.
select is(has_table_privilege('anon', 'public.series', 'SELECT'), false, 'anon holds no SELECT on series');

-- (9)-(10) A signed-in non-admin can neither read nor write catalog admin data.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
select is((select count(*)::bigint from public.series), 0::bigint, 'non-admin sees no draft series');
select throws_ok(
  $$insert into public.authors (canonical_slug, display_name) values ('reader-author', 'Reader Author')$$,
  '42501',
  null,
  'non-admin cannot insert an author'
);

-- (11)-(12) An admin writes authors and series directly.
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$insert into public.authors (canonical_slug, display_name) values ('s1-new-author', 'S1 New Author')$$,
  'admin inserts an author'
);
select lives_ok(
  $$update public.series set display_name = 'S1 Series Renamed' where id = 'c4000000-0000-0000-0000-000000000001'$$,
  'admin renames a series'
);

-- (13)-(15) The audit trigger records inserts and real changes only.
reset role;
select is(
  (select count(*)::bigint from public.audit_logs where action = 'catalog_insert' and entity_type = 'authors'
     and entity_id = (select id from public.authors where canonical_slug = 's1-new-author')),
  1::bigint,
  'author insert is audited once'
);
select is(
  (select metadata #>> '{changes,display_name,to}' from public.audit_logs where action = 'catalog_update' and entity_id = 'c4000000-0000-0000-0000-000000000001'),
  'S1 Series Renamed',
  'series update audit records the new display name'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
update public.series set display_name = 'S1 Series Renamed' where id = 'c4000000-0000-0000-0000-000000000001';
reset role;
select is(
  (select count(*)::bigint from public.audit_logs where action = 'catalog_update' and entity_id = 'c4000000-0000-0000-0000-000000000001'),
  1::bigint,
  'an update that changes nothing writes no audit row'
);

-- (16)-(17) Book status stays RPC-only; the editable book columns are writable.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$update public.books set status = 'published' where id = 'c3000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'admin cannot set books.status directly'
);
select lives_ok(
  $$update public.books set primary_author_id = 'c2000000-0000-0000-0000-000000000002' where id = 'c3000000-0000-0000-0000-000000000001'$$,
  'admin changes the primary author directly'
);

-- (18) Admins can look users up.
select cmp_ok((select count(*)::bigint from public.profiles), '>=', 2::bigint, 'admin reads other users'' profiles');
reset role;

-- (19) Merchandising slot keys are constrained.
select throws_ok(
  $$insert into public.merchandising_slots (slot_key, book_id) values ('home-hero', 'c3000000-0000-0000-0000-000000000001')$$,
  '23514',
  null,
  'an unknown merchandising slot key is rejected'
);

select * from finish();
rollback;
