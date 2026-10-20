begin;
select plan(10);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
('00000000-0000-0000-0000-000000000000', 'd8000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cover-admin@example.test', '', now(), '{}', '{}', now(), now()),
('00000000-0000-0000-0000-000000000000', 'd8000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cover-reader@example.test', '', now(), '{}', '{}', now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'd8000000-0000-4000-8000-000000000001';
insert into public.authors (id, canonical_slug, display_name)
values ('d8100000-0000-4000-8000-000000000001', 'cover-test-author', 'Cover Test');
insert into public.books (id, canonical_key, original_language, primary_author_id)
values ('d8200000-0000-4000-8000-000000000001', 'cover-test-book', 'vi', 'd8100000-0000-4000-8000-000000000001');
insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
values
('book', 'd8200000-0000-4000-8000-000000000001', 'cover', 'books/cover-test/cover.png', 'Current cover'),
('author', 'd8200000-0000-4000-8000-000000000001', 'author_image', 'authors/cover-test/photo.png', 'Not a cover'),
('book', 'd8200000-0000-4000-8000-000000000002', 'cover', 'books/other/cover.png', 'Other book');

select has_function('public', 'admin_get_book_cover', array['uuid'], 'admin cover RPC exists');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd8000000-0000-4000-8000-000000000002', true);
select throws_ok($$select * from public.admin_get_book_cover('d8200000-0000-4000-8000-000000000001')$$, '42501', null, 'reader cannot read cover keys');
select set_config('request.jwt.claim.sub', '', true);
select throws_ok($$select * from public.admin_get_book_cover('d8200000-0000-4000-8000-000000000001')$$, '42501', null, 'missing identity cannot read cover keys');
select set_config('request.jwt.claim.sub', 'd8000000-0000-4000-8000-000000000001', true);
select results_eq($$select storage_key, alt_text from public.admin_get_book_cover('d8200000-0000-4000-8000-000000000001')$$,
 $$values ('books/cover-test/cover.png'::text, 'Current cover'::text)$$, 'admin receives only selected book cover fields');
select is((select count(*) from public.admin_get_book_cover('d8200000-0000-4000-8000-000000000003')), 0::bigint, 'absent cover returns no rows');
select throws_ok($$select storage_key from public.media_assets$$, '42501', null, 'storage_key stays unavailable through direct table reads');
reset role;
set local role anon;
select throws_ok($$select * from public.admin_get_book_cover('d8200000-0000-4000-8000-000000000001')$$, '42501', null, 'anon cannot execute RPC');
reset role;
select ok(not exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) a where p.oid = 'public.admin_get_book_cover(uuid)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'), 'PUBLIC has no execute grant');
select is((select prosecdef from pg_proc where oid = 'public.admin_get_book_cover(uuid)'::regprocedure), true, 'RPC is security definer');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.admin_get_book_cover(uuid)'::regprocedure), 'search path is empty');
select * from finish();
rollback;
