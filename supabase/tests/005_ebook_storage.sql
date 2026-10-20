begin;
select plan(21);

-- Fixtures: one author/book/edition, an admin and a non-admin auth user. Inserted with elevated
-- privileges before switching roles, mirroring 004_admin_create_ebook.sql.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '90000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'ebook-storage-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '90000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'ebook-storage-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = '90000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name) values
  ('91000000-0000-0000-0000-000000000001', 'storage-test-author', 'Storage Test Author');
insert into public.books (id, canonical_key, original_language, primary_author_id) values
  ('91000000-0000-0000-0000-000000000002', 'storage-test-book', 'en', '91000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code, edition_number) values
  ('91000000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000002', 'en', 1);

-- (a) both new buckets exist and are private. Asserted directly, not assumed - the same
-- discipline the wave1-style bucket migration and Tasks 5-6's grant pgTAP applied to their own
-- privilege posture.
select is(
  (select public from storage.buckets where id = 'ebook-source'),
  false,
  'ebook-source bucket exists and is private'
);
select is(
  (select public from storage.buckets where id = 'ebook-derived'),
  false,
  'ebook-derived bucket exists and is private'
);

-- (b) no storage.objects policy grants any browser role direct read or write on either bucket -
-- uploads and reads happen only through server code (signed upload URLs, and later a service-role
-- read), never a policy.
select is(
  (
    select count(*)::bigint from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (qual like '%ebook-source%' or with_check like '%ebook-source%')
  ),
  0::bigint,
  'no storage.objects policy references the ebook-source bucket'
);
select is(
  (
    select count(*)::bigint from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (qual like '%ebook-derived%' or with_check like '%ebook-derived%')
  ),
  0::bigint,
  'no storage.objects policy references the ebook-derived bucket'
);

-- (c) anon holds no EXECUTE on admin_reserve_ebook_asset - checked directly against the grant
-- rather than by calling the function. The function's own is_admin() check also raises 42501
-- (see (d) below), so a call that actually reached the function body would look identical, from
-- throws_ok's point of view, to one rejected at the grant - proving nothing about Ruling R's
-- revoke specifically. has_function_privilege() asks the one question that matters here.
select is(
  has_function_privilege('anon', 'public.admin_reserve_ebook_asset(uuid)', 'EXECUTE'),
  false,
  'anon holds no EXECUTE on admin_reserve_ebook_asset'
);

-- (d) a signed-in non-admin passes the grant but is rejected by the function's own is_admin()
-- check.
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select * from public.admin_reserve_ebook_asset('91000000-0000-0000-0000-000000000003')$$,
  '42501',
  'admin_reserve_ebook_asset: caller is not an admin',
  'authenticated non-admin: admin_reserve_ebook_asset is rejected'
);

-- (e) an admin reserving an edition that does not exist is rejected, distinctly from the
-- authorization failure above.
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select * from public.admin_reserve_ebook_asset('99999999-9999-9999-9999-999999999999')$$,
  'P0002',
  'admin_reserve_ebook_asset: edition 99999999-9999-9999-9999-999999999999 does not exist',
  'admin: reserving a nonexistent edition is rejected'
);

-- (f) an admin reserves the edition's first asset version. Captured into a temp table so later
-- assertions (and the finalize calls below) can reference the asset id the function generated,
-- without a client-supplied id or storage key ever entering the picture.
create temporary table t_reservation_1 as
select * from public.admin_reserve_ebook_asset('91000000-0000-0000-0000-000000000003');

select isnt((select asset_id from t_reservation_1), null, 'admin: first reservation returns an asset id');
select is(
  (select storage_key from t_reservation_1),
  '91000000-0000-0000-0000-000000000003/' || (select asset_id from t_reservation_1)::text || '/source.epub',
  'admin: first reservation''s storage key is bucket-relative and derived from the edition and asset ids, server-side'
);
select is((select version from t_reservation_1), 1, 'admin: first reservation is version 1');

reset role;
select results_eq(
  $$select status, edition_id, source_storage_key from public.ebook_assets
    where id = (select asset_id from t_reservation_1)$$,
  $$select 'uploading'::public.ebook_asset_status, '91000000-0000-0000-0000-000000000003'::uuid,
    (select storage_key from t_reservation_1)$$,
  'admin: the reserved row lands in ebook_assets as uploading, with the exact reserved key'
);

-- (g) Abandoned-upload decision: a second reservation for the same edition - standing in for a
-- client that abandoned the first without ever calling finalize - is not blocked. It gets the
-- next version, proves the first "uploading" row does not hold the edition hostage, and leaves the
-- first row exactly as an inert, orphaned artifact (this task adds no reaper for it).
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
create temporary table t_reservation_2 as
select * from public.admin_reserve_ebook_asset('91000000-0000-0000-0000-000000000003');

select is((select version from t_reservation_2), 2, 'admin: an abandoned first reservation does not block a second - it gets the next version');
reset role;
select is(
  (select count(*)::bigint from public.ebook_assets where edition_id = '91000000-0000-0000-0000-000000000003'),
  2::bigint,
  'admin: both reservations persist as separate ebook_assets rows'
);

-- (h) anon holds no EXECUTE on admin_finalize_ebook_asset - same direct-grant check as (c), and
-- for the same reason: calling the function would be rejected by its own is_admin() check too,
-- so only the grant itself proves Ruling R's revoke stuck.
select is(
  has_function_privilege('anon', 'public.admin_finalize_ebook_asset(uuid, text, text)', 'EXECUTE'),
  false,
  'anon holds no EXECUTE on admin_finalize_ebook_asset'
);

-- (i) a signed-in non-admin is rejected by the function's own is_admin() check.
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.admin_finalize_ebook_asset('91000000-0000-0000-0000-000000000003', 'deadbeef', 'req-reader-1')$$,
  '42501',
  'admin_finalize_ebook_asset: caller is not an admin',
  'authenticated non-admin: admin_finalize_ebook_asset is rejected'
);

-- (j) an admin finalizing an asset id that was never reserved (still not 'uploading') is rejected.
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.admin_finalize_ebook_asset('99999999-9999-9999-9999-999999999999', 'deadbeef', 'req-missing-1')$$,
  'P0002',
  'admin_finalize_ebook_asset: asset 99999999-9999-9999-9999-999999999999 is not awaiting upload',
  'admin: finalizing an asset that was never reserved is rejected'
);

-- (k) an admin finalizes the first reservation: records the checksum, moves it to 'queued', and
-- creates exactly one queued processing_jobs row carrying the correlation id.
create temporary table t_finalize_1 as
select public.admin_finalize_ebook_asset(
  (select asset_id from t_reservation_1), 'checksum-one', 'req-finalize-1'
) as job_id;

select isnt((select job_id from t_finalize_1), null, 'admin: finalizing the first reservation returns a job id');
reset role;
select results_eq(
  $$select status, source_checksum from public.ebook_assets where id = (select asset_id from t_reservation_1)$$,
  $$values ('queued'::public.ebook_asset_status, 'checksum-one'::text)$$,
  'admin: the finalized asset is queued with the reported checksum recorded'
);
select results_eq(
  $$select target_id, status, correlation_id from public.processing_jobs
    where target_id = (select asset_id from t_reservation_1)$$,
  $$select (select asset_id from t_reservation_1), 'queued'::public.processing_job_status, 'req-finalize-1'::text$$,
  'admin: exactly one queued processing job was created, carrying the correlation id'
);

-- (l) finalizing the same asset again - a stale retry after the first response was lost, or a
-- caller mistake - is rejected outright, and does not create a second job. This is the retry
-- safety the migration's header comment claims for admin_finalize_ebook_asset.
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select throws_ok(
  format(
    $$select public.admin_finalize_ebook_asset('%s', 'checksum-one-retry', 'req-finalize-1-retry')$$,
    (select asset_id from t_reservation_1)
  ),
  'P0002',
  format('admin_finalize_ebook_asset: asset %s is not awaiting upload', (select asset_id from t_reservation_1)),
  'admin: re-finalizing an already-queued asset is rejected'
);
reset role;
select is(
  (select count(*)::bigint from public.processing_jobs where target_id = (select asset_id from t_reservation_1)),
  1::bigint,
  'admin: the rejected retry left exactly one processing job behind, not two'
);

select * from finish();
rollback;
