-- The three RPCs Task 5's local CLI worker calls to claim, complete, and fail a
-- processing_jobs row. Ruling AV: named 20260911170000, not the brief's 20260911130000 -
-- that timestamp sorts BEFORE 20260911160000_ebook_storage.sql despite landing one task
-- later, which is exactly the hosted-project hazard 20260911160000_ebook_storage.sql's own
-- header describes: the single hosted project this ships to applies migrations
-- incrementally as they land and would never go back to pick up a newly added,
-- earlier-sorting file.
--
-- Ruling AK: the CLI worker runs as a plain Node/tsx process holding only the service-role
-- credential - there is no `auth.uid()`, so `is_admin()` (which resolves through it) can
-- never be true for this caller. These three functions are not gated by is_admin() at all;
-- their trust boundary is possession of the service-role credential plus the lease check
-- inside complete_processing_job/fail_processing_job. EXECUTE is revoked from public, anon,
-- AND authenticated, and granted to service_role alone - the first RPC pair in this project
-- (admin_reserve_ebook_asset, admin_finalize_ebook_asset - Ruling R) that instead runs
-- through the *user session* because it depends on is_admin(); this is the opposite case,
-- and there is no session to fall back to if the grant were wrong.

-- claim_processing_job(): claims the oldest eligible job (p_target_id is null) or one
-- specific job by its target asset id (p_target_id given), under `for update skip locked` so
-- two concurrently-polling workers can never lock the same row. Eligible with no target:
-- `queued`, or `processing` with an expired lease. Eligible *with* an explicit target: those
-- two, plus `failed` - only an operator who already knows the specific asset id (via
-- `process --asset <uuid>` or `retry --job <uuid>`, which resolves the job's target id
-- first) can reclaim a failed job; a bare poll for "whatever's next" never retries something
-- an operator hasn't looked at.
create function public.claim_processing_job(
  p_worker_id text,
  p_lease_seconds integer,
  p_target_id uuid default null
)
returns table (
  job_id uuid,
  target_id uuid,
  edition_id uuid,
  version integer,
  source_storage_key text,
  source_checksum text,
  attempt integer,
  correlation_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  select pj.id into v_job_id
  from public.processing_jobs pj
  where (
    p_target_id is null
    and (pj.status = 'queued' or (pj.status = 'processing' and pj.lease_expires_at < now()))
  ) or (
    p_target_id is not null
    and pj.target_id = p_target_id
    and (pj.status = 'queued' or pj.status = 'failed' or (pj.status = 'processing' and pj.lease_expires_at < now()))
  )
  order by pj.created_at asc
  -- `skip locked` matters for two workers racing a concurrent transaction on the *same*
  -- row (e.g. two poll loops hitting claim_processing_job at the same instant) - a scenario
  -- a single pgTAP session cannot construct, so 006_processing_jobs.sql's two-workers
  -- assertion (10) verifies the *status* predicate excludes an actively-leased row, not
  -- `skip locked` itself. This clause is inspection-verified, not test-covered.
  for update of pj skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  update public.processing_jobs pj
  set status = 'processing',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      -- Qualified: this function's `returns table (..., attempt integer, ...)` declares an
      -- output parameter also named `attempt`, which plpgsql would otherwise prefer over the
      -- column of the same name here.
      attempt = pj.attempt + 1,
      error_code = null,
      error_message = null,
      updated_at = now()
  where pj.id = v_job_id;

  update public.ebook_assets a
  set status = 'processing'
  from public.processing_jobs pj
  where pj.id = v_job_id and a.id = pj.target_id;

  return query
  select pj.id, pj.target_id, a.edition_id, a.version, a.source_storage_key, a.source_checksum, pj.attempt, pj.correlation_id
  from public.processing_jobs pj
  join public.ebook_assets a on a.id = pj.target_id
  where pj.id = v_job_id;
end;
$$;

revoke execute on function public.claim_processing_job(text, integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_processing_job(text, integer, uuid) to service_role;

-- complete_processing_job(): records a successful run - one new ebook_publications row, its
-- ebook_resources, and its book_samples allowlist - all in the one statement PostgREST
-- wraps per RPC call, so a failure partway through leaves neither an orphan publication row
-- nor resources with no publication.
--
-- Stale-version check: after locking the job and the target asset, this compares the
-- asset's version against the current max version for its edition. If a newer asset already
-- exists for the same edition, this job's output is moot - a newer upload supersedes an
-- older one's in-flight processing immediately, without waiting for the newer job to
-- finish. This function only *detects* that and raises (errcode 'EB001') - it never mutates
-- processing_jobs or ebook_assets itself. The transaction rolls back to nothing happening,
-- and the caller (job-store.ts) maps the raise to a STALE_VERSION ProcessingError, which the
-- worker's single catch-and-fail path turns into a real fail_processing_job call. That keeps
-- exactly one code path that ever writes a failure, and guarantees a stale completion can
-- never overwrite (or race) whatever newer publication already exists for the edition.
create function public.complete_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_manifest_key text,
  p_toc jsonb,
  p_resources jsonb,
  p_sample_hrefs jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_id uuid;
  v_edition_id uuid;
  v_version integer;
  v_max_version integer;
  v_publication_id uuid;
begin
  select pj.target_id into v_target_id
  from public.processing_jobs pj
  where pj.id = p_job_id
  for update of pj;

  if v_target_id is null then
    raise exception 'complete_processing_job: job % does not exist', p_job_id using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.processing_jobs
    where id = p_job_id
      and status = 'processing'
      and lease_owner = p_worker_id
      and lease_expires_at > now()
  ) then
    raise exception 'complete_processing_job: worker % does not hold the lease for job %', p_worker_id, p_job_id using errcode = '42501';
  end if;

  select a.edition_id, a.version into v_edition_id, v_version
  from public.ebook_assets a
  where a.id = v_target_id
  for update of a;

  -- Fix round 1, Ruling BA: excludes 'uploading' rows. admin_reserve_ebook_asset assigns a
  -- version and inserts the row at *reservation* time, before any bytes exist
  -- (20260911160000_ebook_storage.sql) - an abandoned reservation (a closed browser tab, or
  -- the local storage-limit interaction docs/runbooks/epub-processing.md documents) leaves a
  -- permanent 'uploading' row behind with no reaper. Without this filter, that phantom
  -- version would count as "newer" here and permanently fail the in-flight job for the real
  -- current version with a non-retryable STALE_VERSION - exactly the mechanism the runbook's
  -- own orphan section describes, just never connected to this check before. A row only
  -- counts once it has actually reached 'queued' or later, i.e. once admin_finalize_ebook_
  -- asset has run and a processing_jobs row genuinely exists for it.
  select max(version) into v_max_version
  from public.ebook_assets
  where edition_id = v_edition_id
    and status <> 'uploading';

  if v_max_version > v_version then
    raise exception 'complete_processing_job: asset % (version %) is stale; edition % has version %',
      v_target_id, v_version, v_edition_id, v_max_version
      using errcode = 'EB001';
  end if;

  insert into public.ebook_publications (ebook_asset_id, version, manifest_key, toc_json)
  values (v_target_id, v_version, p_manifest_key, coalesce(p_toc, '[]'::jsonb))
  returning id into v_publication_id;

  insert into public.ebook_resources (publication_id, href, media_type, storage_key, byte_size, sha256, access_class)
  select v_publication_id, r->>'href', r->>'media_type', r->>'storage_key', (r->>'byte_size')::bigint, r->>'sha256', r->>'access_class'
  from jsonb_array_elements(coalesce(p_resources, '[]'::jsonb)) as r;

  insert into public.book_samples (publication_id, allowed_hrefs)
  values (v_publication_id, coalesce(p_sample_hrefs, '[]'::jsonb));

  update public.processing_jobs
  set status = 'completed',
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_job_id;

  update public.ebook_assets
  set status = 'ready_for_preview'
  where id = v_target_id;

  return v_publication_id;
end;
$$;

revoke execute on function public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb) to service_role;

-- fail_processing_job(): records a failed run. Always moves the job (and its target asset)
-- to 'failed', regardless of the failure's retryable flag - the CLI's retryable/non-retryable
-- distinction is advisory to the operator, not an automatic requeue. An operator retries
-- explicitly via `retry --job <uuid>`, which resolves the job's target id and calls
-- claim_processing_job with that target - the same lease-acquisition path as any other
-- claim, just one that is also allowed to pick up a `failed` row.
create function public.fail_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_id uuid;
begin
  select pj.target_id into v_target_id
  from public.processing_jobs pj
  where pj.id = p_job_id
  for update of pj;

  if v_target_id is null then
    raise exception 'fail_processing_job: job % does not exist', p_job_id using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.processing_jobs
    where id = p_job_id
      and status = 'processing'
      and lease_owner = p_worker_id
      and lease_expires_at > now()
  ) then
    raise exception 'fail_processing_job: worker % does not hold the lease for job %', p_worker_id, p_job_id using errcode = '42501';
  end if;

  update public.processing_jobs
  set status = 'failed',
      error_code = p_error_code,
      error_message = p_error_message,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_job_id;

  update public.ebook_assets
  set status = 'failed'
  where id = v_target_id;
end;
$$;

revoke execute on function public.fail_processing_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fail_processing_job(uuid, text, text, text) to service_role;
