-- Persist private full-publication search indexes and digital positions in the same worker
-- transaction that makes a newly processed publication ready for preview. Existing versions
-- are indexed separately through the worker-only replacement RPC below.

create function public.complete_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_manifest_key text,
  p_toc jsonb,
  p_resources jsonb,
  p_sample_hrefs jsonb,
  p_search_chunks jsonb,
  p_positions jsonb
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

  select max(version) into v_max_version
  from public.ebook_assets
  where edition_id = v_edition_id
    and status <> 'uploading';

  if v_max_version > v_version then
    raise exception 'complete_processing_job: asset % (version %) is stale; edition % has version %',
      v_target_id, v_version, v_edition_id, v_max_version using errcode = 'EB001';
  end if;

  if jsonb_typeof(coalesce(p_resources, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_search_chunks, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_positions, '[]'::jsonb)) <> 'array' then
    raise exception 'complete_processing_job: resources, search chunks, and positions must be arrays' using errcode = '22023';
  end if;

  insert into public.ebook_publications (ebook_asset_id, version, manifest_key, toc_json, positions_json)
  values (v_target_id, v_version, p_manifest_key, coalesce(p_toc, '[]'::jsonb), coalesce(p_positions, '[]'::jsonb))
  returning id into v_publication_id;

  insert into public.ebook_resources (publication_id, href, media_type, storage_key, byte_size, sha256, access_class)
  select v_publication_id, r->>'href', r->>'media_type', r->>'storage_key', (r->>'byte_size')::bigint, r->>'sha256', r->>'access_class'
  from jsonb_array_elements(coalesce(p_resources, '[]'::jsonb)) as r;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_search_chunks, '[]'::jsonb)) as chunk
    where not exists (
      select 1 from public.ebook_resources resource
      where resource.publication_id = v_publication_id and resource.href = chunk->>'href'
    )
       or chunk #>> '{locator_json,href}' is distinct from chunk->>'href'
  ) then
    raise exception 'complete_processing_job: every search chunk href must be an existing publication resource' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_positions, '[]'::jsonb)) as position
    where not exists (
      select 1 from public.ebook_resources resource
      where resource.publication_id = v_publication_id and resource.href = position->>'href'
    )
  ) then
    raise exception 'complete_processing_job: every position href must be an existing publication resource' using errcode = '22023';
  end if;

  insert into public.ebook_search_chunks (publication_id, href, chapter_title, ordinal, plain_text, locator_json)
  select v_publication_id, chunk->>'href', chunk->>'chapter_title', (chunk->>'ordinal')::integer,
    chunk->>'plain_text', chunk->'locator_json'
  from jsonb_array_elements(coalesce(p_search_chunks, '[]'::jsonb)) as chunk;

  insert into public.book_samples (publication_id, allowed_hrefs)
  values (v_publication_id, coalesce(p_sample_hrefs, '[]'::jsonb));

  update public.processing_jobs
  set status = 'completed', lease_owner = null, lease_expires_at = null, updated_at = now()
  where id = p_job_id;
  update public.ebook_assets set status = 'ready_for_preview' where id = v_target_id;

  return v_publication_id;
end;
$$;

revoke execute on function public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

-- Do not preserve an index-bypassing legacy overload. All worker callers must provide the
-- sanitized index and positions that define a ready publication.
drop function public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb);

create function public.replace_publication_search(
  p_publication_id uuid,
  p_search_chunks jsonb,
  p_positions jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.ebook_publications where id = p_publication_id for update;
  if not found then
    raise exception 'replace_publication_search: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;

  if jsonb_typeof(coalesce(p_search_chunks, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_positions, '[]'::jsonb)) <> 'array' then
    raise exception 'replace_publication_search: search chunks and positions must be arrays' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_search_chunks, '[]'::jsonb)) as chunk
    where not exists (
      select 1 from public.ebook_resources resource
      where resource.publication_id = p_publication_id and resource.href = chunk->>'href'
    )
       or chunk #>> '{locator_json,href}' is distinct from chunk->>'href'
  ) then
    raise exception 'replace_publication_search: every search chunk href must be an existing publication resource' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_positions, '[]'::jsonb)) as position
    where not exists (
      select 1 from public.ebook_resources resource
      where resource.publication_id = p_publication_id and resource.href = position->>'href'
    )
  ) then
    raise exception 'replace_publication_search: every position href must be an existing publication resource' using errcode = '22023';
  end if;

  delete from public.ebook_search_chunks where publication_id = p_publication_id;
  insert into public.ebook_search_chunks (publication_id, href, chapter_title, ordinal, plain_text, locator_json)
  select p_publication_id, chunk->>'href', chunk->>'chapter_title', (chunk->>'ordinal')::integer,
    chunk->>'plain_text', chunk->'locator_json'
  from jsonb_array_elements(coalesce(p_search_chunks, '[]'::jsonb)) as chunk;
  update public.ebook_publications set positions_json = coalesce(p_positions, '[]'::jsonb) where id = p_publication_id;
end;
$$;

revoke execute on function public.replace_publication_search(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_publication_search(uuid, jsonb, jsonb) to service_role;
