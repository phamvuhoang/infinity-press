begin;
select plan(9);
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
values ('d1000000-0000-4000-8000-000000000001', 'author-reuse-admin@example.test', '{}'::jsonb, '{}'::jsonb);
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'd1000000-0000-4000-8000-000000000001';
insert into public.authors (id, canonical_slug, display_name)
values ('d2000000-0000-4000-8000-000000000001', 'custom-canonical-author', 'Tác Giả Có Tên');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select lives_ok($$select public.admin_create_book('custom-author-book', ' tác giả có tên ', 'vi', 'vi', 'A book', 'custom-author-book', 'VN', 'VND', 0)$$, 'an operator can create a book using a manually created author name');
reset role;
select is((select primary_author_id from public.books where canonical_key = 'custom-author-book'), 'd2000000-0000-4000-8000-000000000001'::uuid, 'exact trimmed name reuses an author with a custom slug');
select is((select count(*) from public.authors where lower(trim(display_name)) = lower('Tác Giả Có Tên')), 1::bigint, 'book creation does not duplicate the existing author');
select is((select count(*) from public.audit_logs where action = 'create_book' and entity_id = (select id from public.books where canonical_key = 'custom-author-book')), 1::bigint, 'exactly one explicit create_book audit records the outcome');
select is((select actor_profile_id from public.audit_logs where action = 'create_book' and entity_id = (select id from public.books where canonical_key = 'custom-author-book')), (select id from public.profiles where auth_user_id = 'd1000000-0000-4000-8000-000000000001'), 'create_book audit attributes the operator');
insert into public.authors (canonical_slug, display_name) values ('second-custom-author', 'Tác Giả Có Tên');
set local role authenticated;
select throws_ok($$select public.admin_create_book('ambiguous-author-book', 'Tác Giả Có Tên', 'vi', 'vi', 'Ambiguous', 'ambiguous-author-book', 'VN', 'VND', 0)$$, '22023', 'admin_create_book: author name matches multiple authors', 'ambiguous names are rejected instead of choosing the wrong author');
reset role;
select is((select count(*) from public.books where canonical_key = 'ambiguous-author-book'), 0::bigint, 'ambiguous author rejection writes no book');
insert into public.authors (id, canonical_slug, display_name)
values ('d2000000-0000-4000-8000-000000000002', 'legacy-author-name', 'Renamed author');
set local role authenticated;
select lives_ok($$select public.admin_create_book('legacy-author-book', 'Legacy Author Name', 'vi', 'vi', 'Legacy', 'legacy-author-book', 'VN', 'VND', 0)$$, 'derived-slug lookup remains available when no name matches');
reset role;
select is((select primary_author_id from public.books where canonical_key = 'legacy-author-book'), 'd2000000-0000-4000-8000-000000000002'::uuid, 'legacy slug fallback reuses its original author');
select * from finish();
rollback;
