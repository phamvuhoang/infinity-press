-- Private EPUB upload: storage buckets, and the reserve/finalize RPCs that create an immutable
-- ebook_assets version and the queued processing_jobs row a later CLI worker will claim.
--
-- Ruling P: this migration is named 20260911160000, not the plan's 20260911110000 - that
-- timestamp sorts BEFORE 20260911120000_admin_create_ebook.sql despite running one task later. A
-- fresh `db reset` applies migrations in filename order either way, but the single hosted
-- Supabase project this ships to applies migrations incrementally as they land: it would already
-- have applied 120000 and would never go back to pick up a newly added, earlier-sorting 110000.

-- Both buckets are private (`public = false`) and carry no storage.objects policy for anon or
-- authenticated at all - not even a read policy. Uploads happen only through a signed upload URL
-- minted by the service-role client after requireAdmin() (Ruling AD: this is a legitimate
-- service-role use, since the whole point is that browser roles have no write access to a private
-- bucket, so it cannot be expressed as a policy). Reads of the source/derived objects happen only
-- through trusted server code - this task's admin upload flow only ever writes; a later task's
-- processing worker and admin preview stream are the only intended readers. Browser roles get no
-- direct storage access to either bucket, in either direction.
-- `on conflict ... do update`, not `do nothing`: this is the repo's first bucket-creating
-- migration, and if either bucket already existed - created by hand in the dashboard, or by an
-- earlier experiment - a plain `do nothing` would leave it exactly as it was, silently keeping
-- `public = true` if that's what it already had. Every pgTAP check here only ever runs against a
-- fresh local reset and would stay green regardless, so this insert has to be self-healing on its
-- own: re-running it always drives both buckets back to the private, size-limited state below,
-- even against a database where they already exist.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('ebook-source', 'ebook-source', false, 104857600, array['application/epub+zip']),
  ('ebook-derived', 'ebook-derived', false, null, null)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- public.admin_reserve_ebook_asset(): reserves the next immutable version of one edition's EPUB
-- asset, in 'uploading' state, before any bytes exist. The asset id and its source storage key
-- are generated in here, not accepted as parameters - the calling application layer never gets to
-- choose either, so a compromised or buggy caller cannot make this function write to a storage key
-- it did not derive itself (self-review requirement: the storage key is derived server-side from
-- the asset and edition ids, never accepted from the client).
--
-- Abandoned-upload decision: this inserts a row before the caller has uploaded any bytes, so a
-- browser that abandons the upload (closed tab, dead network) after this call but before
-- admin_finalize_ebook_asset leaves that row behind in 'uploading' state forever - there is no
-- reaper in this task. That is a deliberate, non-blocking gap: ebook_assets carries no partial
-- unique index on (edition_id) the way processing_jobs carries one on (target_id) for active jobs
-- (20260911090000_mvp_catalog_publishing.sql:161-163) - only unique(edition_id, version) - so the
-- *next* reservation for the same edition simply computes the next version number and proceeds
-- normally; it is never blocked by an orphaned row. An abandoned 'uploading' row can also never
-- become the active/published asset: only admin_finalize_ebook_asset moves a row out of
-- 'uploading', and it does so by primary key (the exact asset id the caller reserved), never "the
-- latest uploading row for this edition" - so an abandoned reservation this function created is
-- inert. It is, at worst, a dead row and - if the browser actually PUT bytes to the signed URL
-- before abandoning - an orphaned object in the ebook-source bucket. Both are an accepted,
-- explicit gap; a sweep of stale 'uploading' rows (older than the signed URL's TTL) is left to a
-- later task, not built speculatively here.
create function public.admin_reserve_ebook_asset(p_edition_id uuid)
returns table (asset_id uuid, storage_key text, version integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset_id uuid := gen_random_uuid();
  v_version integer;
  v_storage_key text;
begin
  if not public.is_admin() then
    raise exception 'admin_reserve_ebook_asset: caller is not an admin' using errcode = '42501';
  end if;

  if not exists (select 1 from public.editions e where e.id = p_edition_id) then
    raise exception 'admin_reserve_ebook_asset: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  select coalesce(max(a.version), 0) + 1 into v_version
  from public.ebook_assets a
  where a.edition_id = p_edition_id;

  -- Bucket-relative, matching every other storage key in this repo (e.g.
  -- supabase/tests/002_access_rls.sql's 'a/source.epub') - storage-js's uploadToSignedUrl/download
  -- already prepend the bucket id to whatever path is stored here, so a key that itself begins
  -- with 'ebook-source/' would put that segment in the object's address twice. The full object
  -- address a caller resolves through the ebook-source bucket is still exactly
  -- ebook-source/{editionId}/{assetId}/source.epub, matching the plan; this column just doesn't
  -- repeat the bucket name inside the path handed to it.
  v_storage_key := p_edition_id::text || '/' || v_asset_id::text || '/source.epub';

  insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
  values (v_asset_id, p_edition_id, v_storage_key, v_version, 'uploading');

  return query select v_asset_id, v_storage_key, v_version;
end;
$$;

-- Ruling R: EXECUTE goes to authenticated only, matching admin_create_ebook (Ruling W's trap
-- applies here too - is_admin() resolves through auth.uid(), null under service_role, so a
-- service-role grant would be a permission that can never succeed).
revoke execute on function public.admin_reserve_ebook_asset(uuid) from public, anon;
grant execute on function public.admin_reserve_ebook_asset(uuid) to authenticated;

-- public.admin_finalize_ebook_asset(): verifies the asset is still 'uploading', records the
-- caller-reported checksum, moves it to 'queued', and creates exactly one queued processing_jobs
-- row for it - all inside the one statement PostgREST wraps per request, so a failure at any step
-- leaves neither a half-finalized asset nor an orphan job.
--
-- The `where status = 'uploading'` guard makes this retry-safe the way admin_create_ebook (Task
-- 2) deliberately is not: calling it twice for the same asset id only ever queues one job. The
-- first call moves the row to 'queued' and returns a job id; a second call finds no 'uploading'
-- row to update, updates zero rows, and is rejected outright (P0002) rather than silently creating
-- a second job or handing back the first call's job id - a legitimate retry after success has no
-- reason to call this again, since the caller already holds the job id from the first response.
--
-- This does not re-verify the uploaded bytes against p_checksum - it records whatever the caller
-- reports. The processing worker (a later task) reads the source object directly and is the
-- actual point where corrupt or tampered bytes get caught; this checksum is provenance, not a
-- verified integrity gate.
create function public.admin_finalize_ebook_asset(
  p_asset_id uuid,
  p_checksum text,
  p_correlation_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_edition_id uuid;
  v_job_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_finalize_ebook_asset: caller is not an admin' using errcode = '42501';
  end if;

  update public.ebook_assets
  set source_checksum = p_checksum,
      status = 'queued'
  where id = p_asset_id
    and status = 'uploading'
  returning edition_id into v_edition_id;

  if v_edition_id is null then
    raise exception 'admin_finalize_ebook_asset: asset % is not awaiting upload', p_asset_id using errcode = 'P0002';
  end if;

  insert into public.processing_jobs (target_id, status, correlation_id)
  values (p_asset_id, 'queued', p_correlation_id)
  returning id into v_job_id;

  return v_job_id;
end;
$$;

-- Ruling R.
revoke execute on function public.admin_finalize_ebook_asset(uuid, text, text) from public, anon;
grant execute on function public.admin_finalize_ebook_asset(uuid, text, text) to authenticated;
