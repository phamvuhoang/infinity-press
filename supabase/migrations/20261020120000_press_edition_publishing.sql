-- Infinity Books Press, Task 4: publishing is per edition.
--
-- publish_publication / rollback_publication keep their signatures (a publication already
-- identifies its edition) but now move the EDITION's pointer and supersede only that edition's
-- previous publication. Publishing Japanese can no longer replace the English text a reader has.
-- Until the readers move to the edition pointer (Tasks 5 and 8), books.active_publication_id is
-- kept in step as a bridge, but only while it names the same edition (or nothing): it never jumps
-- from one language to another. The contract migration (Task 10) drops it.

-- The language the worker read from the EPUB package, compared with the edition's declared language
-- before anything is published.
alter table public.ebook_publications add column epub_language text;

-- complete_processing_job gains p_epub_language (default null so an older worker still completes;
-- a publication with no recorded language cannot be published until it is verified).
drop function public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb);
create function public.complete_processing_job(p_job_id uuid, p_worker_id text, p_manifest_key text, p_toc jsonb, p_resources jsonb, p_sample_hrefs jsonb, p_search_chunks jsonb, p_positions jsonb, p_epub_language text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  insert into public.ebook_publications (ebook_asset_id, version, manifest_key, toc_json, positions_json, epub_language)
  values (v_target_id, v_version, p_manifest_key, coalesce(p_toc, '[]'::jsonb), coalesce(p_positions, '[]'::jsonb), nullif(btrim(p_epub_language), ''))
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
$function$

;
revoke all on function public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.complete_processing_job(uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text) to service_role;

-- What stops a publication going live. The EPUB's own language must match the edition's declared
-- language (primary subtag, so en-GB satisfies en); a language the worker never read cannot be
-- confirmed. Editorial provenance joins this list in Task 9.
create function public.publication_readiness_issues(p_publication_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select array_remove(array[
      case
        when p.epub_language is null or btrim(p.epub_language) = '' then 'epub_language_unverified'
        when lower(split_part(btrim(p.epub_language), '-', 1)) <> lower(split_part(e.language_code, '-', 1))
          then 'epub_language_mismatch'
      end
    ], null)
    from public.ebook_publications p
    join public.ebook_assets a on a.id = p.ebook_asset_id
    join public.editions e on e.id = a.edition_id
    where p.id = p_publication_id
  ), '{}'::text[]);
$$;
revoke all on function public.publication_readiness_issues(uuid) from public, anon;
grant execute on function public.publication_readiness_issues(uuid) to authenticated, service_role;

-- Moves one edition's live publication. Internal: callers have already checked the admin and the
-- publication's state. Returns the pointer it replaced.
create function public.press_move_edition_pointer(p_edition_id uuid, p_publication_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_id uuid;
  v_language text;
  v_previous uuid;
  v_asset_id uuid;
begin
  select e.book_id, e.language_code, e.active_publication_id
  into v_book_id, v_language, v_previous
  from public.editions e where e.id = p_edition_id for update;

  select p.ebook_asset_id into v_asset_id from public.ebook_publications p where p.id = p_publication_id;

  -- Only THIS edition's previous publication is superseded.
  if v_previous is not null and v_previous <> p_publication_id then
    update public.ebook_assets set status = 'superseded'
    where id = (select ebook_asset_id from public.ebook_publications where id = v_previous);
    update public.ebook_publications set status = 'superseded' where id = v_previous;
  end if;

  update public.ebook_publications set status = 'published' where id = p_publication_id;
  update public.ebook_assets set status = 'published' where id = v_asset_id;
  update public.editions set active_publication_id = p_publication_id, status = 'published' where id = p_edition_id;

  -- The first published edition of a language is that language's default; later ones are reached
  -- explicitly until an admin changes the default.
  insert into public.book_language_editions (book_id, language_code, edition_id)
  values (v_book_id, v_language, p_edition_id)
  on conflict (book_id, language_code) do nothing;

  -- Bridge for the book-only readers: follow only while it names this edition (or nothing).
  update public.books b set active_publication_id = p_publication_id
  where b.id = v_book_id
    and (b.active_publication_id is null
         or b.active_publication_id = v_previous
         or exists (
           select 1 from public.ebook_publications bp
           join public.ebook_assets ba on ba.id = bp.ebook_asset_id
           where bp.id = b.active_publication_id and ba.edition_id = p_edition_id));

  return v_previous;
end;
$$;
revoke all on function public.press_move_edition_pointer(uuid, uuid) from public, anon, authenticated;

create or replace function public.publish_publication(p_publication_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_id uuid;
  v_edition_id uuid;
  v_status public.publication_status;
  v_issues text[];
  v_previous uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'publish_publication: caller is not an admin' using errcode = '42501';
  end if;

  select e.book_id, e.id into v_book_id, v_edition_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where p.id = p_publication_id;

  if v_book_id is null then
    raise exception 'publish_publication: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;

  -- Book, then edition, then the publication: one lock order for every publishing call.
  perform 1 from public.books where id = v_book_id for update;
  perform 1 from public.editions where id = v_edition_id for update;

  select p.status into v_status from public.ebook_publications p where p.id = p_publication_id for update;
  if v_status <> 'ready_for_preview' then
    raise exception 'publish_publication: publication % is % and cannot be published', p_publication_id, v_status
      using errcode = 'EB002';
  end if;

  v_issues := public.publication_readiness_issues(p_publication_id);
  if cardinality(v_issues) > 0 then
    raise exception 'publish_publication: publication is not ready: %', array_to_string(v_issues, ',')
      using errcode = 'EB012';
  end if;

  v_previous := public.press_move_edition_pointer(v_edition_id, p_publication_id);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'publish_publication', 'ebook_publications', p_publication_id,
          jsonb_build_object('book_id', v_book_id, 'edition_id', v_edition_id, 'previous_active_publication_id', v_previous));
end;
$$;

create or replace function public.rollback_publication(p_book_id uuid, p_publication_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actual_book_id uuid;
  v_edition_id uuid;
  v_status public.publication_status;
  v_previous uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'rollback_publication: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'rollback_publication: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  select e.book_id, e.id into v_actual_book_id, v_edition_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where p.id = p_publication_id;

  if v_actual_book_id is null then
    raise exception 'rollback_publication: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;
  if v_actual_book_id <> p_book_id then
    raise exception 'rollback_publication: publication % does not belong to book %', p_publication_id, p_book_id
      using errcode = 'EB003';
  end if;

  perform 1 from public.editions where id = v_edition_id for update;
  select p.status into v_status from public.ebook_publications p where p.id = p_publication_id for update;
  if v_status <> 'superseded' then
    raise exception 'rollback_publication: publication % is % and is not eligible for rollback', p_publication_id, v_status
      using errcode = 'EB002';
  end if;

  -- Rolls back within the publication's own edition: another language's pointer is never involved.
  v_previous := public.press_move_edition_pointer(v_edition_id, p_publication_id);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'rollback_publication', 'ebook_publications', p_publication_id,
          jsonb_build_object('book_id', p_book_id, 'edition_id', v_edition_id, 'previous_active_publication_id', v_previous));
end;
$$;

-- Work readiness (publish_book): copy, author, cover and at least one published edition. An offer
-- is no longer required: a work with no offer is browsable, just not for sale (spec section 6).
create or replace function public.book_readiness_issues(p_book_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when not exists (
      select 1 from public.book_localizations bl
      where bl.book_id = p_book_id
        and length(trim(bl.title)) > 0
        and length(trim(bl.slug)) > 0
        and length(trim(coalesce(bl.description, ''))) > 0
    ) then 'missing_localization' end,
    case when not exists (
      select 1 from public.books b
      join public.authors a on a.id = b.primary_author_id
      join public.author_localizations al on al.author_id = a.id
      where b.id = p_book_id
        and length(trim(al.name)) > 0
        and length(trim(al.slug)) > 0
    ) then 'missing_author' end,
    case when not exists (
      select 1 from public.media_assets m
      where m.owner_type = 'book' and m.owner_id = p_book_id and m.kind = 'cover'
    ) then 'missing_cover' end,
    case when not exists (
      select 1 from public.editions e
      join public.ebook_publications p on p.id = e.active_publication_id
      where e.book_id = p_book_id and e.status = 'published' and p.status = 'published'
    ) then 'missing_publication' end
  ], null);
$$;

-- Edition administration. Every function checks is_admin() itself.
create function public.admin_create_edition(
  p_book_id uuid,
  p_language_code text,
  p_edition_number integer,
  p_isbn text,
  p_publication_date date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_number integer;
  v_edition_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_edition: caller is not an admin' using errcode = '42501';
  end if;

  select canonical_key into v_key from public.books where id = p_book_id for update;
  if v_key is null then
    raise exception 'admin_create_edition: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  v_number := coalesce(p_edition_number, (
    select coalesce(max(e.edition_number), 0) + 1
    from public.editions e where e.book_id = p_book_id and e.language_code = p_language_code));

  insert into public.editions (book_id, language_code, edition_number, isbn, publication_date)
  values (p_book_id, p_language_code, v_number, p_isbn, p_publication_date)
  returning id into v_edition_id;

  insert into public.skus (edition_id, sku_code)
  values (v_edition_id, v_key || '-' || p_language_code || '-ebook' || case when v_number > 1 then '-' || v_number else '' end);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'create_edition', 'editions', v_edition_id,
          jsonb_build_object('book_id', p_book_id, 'language_code', p_language_code, 'edition_number', v_number));
  return v_edition_id;
end;
$$;

create function public.admin_save_edition(
  p_edition_id uuid,
  p_isbn text,
  p_edition_number integer,
  p_publication_date date,
  p_introduction text,
  p_contributors jsonb,
  p_language_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_save_edition: caller is not an admin' using errcode = '42501';
  end if;
  if p_contributors is null or jsonb_typeof(p_contributors) <> 'array' then
    raise exception 'admin_save_edition: contributors must be a list' using errcode = '22023';
  end if;

  -- The identity trigger refuses a language change once the edition has orders or entitlements.
  update public.editions
  set isbn = p_isbn,
      edition_number = p_edition_number,
      publication_date = p_publication_date,
      introduction = p_introduction,
      contributors = p_contributors,
      language_code = p_language_code
  where id = p_edition_id;
  if not found then
    raise exception 'admin_save_edition: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'save_edition', 'editions', p_edition_id, jsonb_build_object('language_code', p_language_code));
end;
$$;

create function public.admin_set_default_edition(p_book_id uuid, p_language_code text, p_edition_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_default_edition: caller is not an admin' using errcode = '42501';
  end if;
  -- The composite foreign key rejects an edition of another book or language (23503).
  insert into public.book_language_editions (book_id, language_code, edition_id)
  values (p_book_id, p_language_code, p_edition_id)
  on conflict (book_id, language_code) do update set edition_id = excluded.edition_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_default_edition', 'books', p_book_id,
          jsonb_build_object('language_code', p_language_code, 'edition_id', p_edition_id));
end;
$$;

create function public.admin_create_offer(
  p_edition_id uuid,
  p_market_code text,
  p_currency text,
  p_price_minor bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku_id uuid;
  v_offer_id uuid;
  v_key text;
  v_language text;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_create_offer: caller is not an admin' using errcode = '42501';
  end if;
  -- A missing price must never become a free offer: free is an explicit 0.
  if p_price_minor is null or p_price_minor < 0 then
    raise exception 'admin_create_offer: a price is required' using errcode = '22023';
  end if;
  if p_currency !~ '^[A-Z]{3}$' or p_market_code !~ '^[A-Z]{2}$' then
    raise exception 'admin_create_offer: currency and market must be ISO codes' using errcode = '22023';
  end if;

  select b.canonical_key, e.language_code into v_key, v_language
  from public.editions e join public.books b on b.id = e.book_id
  where e.id = p_edition_id for update of e;
  if v_key is null then
    raise exception 'admin_create_offer: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  select id into v_sku_id from public.skus where edition_id = p_edition_id and format = 'ebook' order by sku_code limit 1;
  if v_sku_id is null then
    insert into public.skus (edition_id, sku_code)
    values (p_edition_id, v_key || '-' || v_language || '-ebook')
    returning id into v_sku_id;
  end if;

  insert into public.offers (sku_id, market_code, currency, price_minor)
  values (v_sku_id, p_market_code, p_currency, p_price_minor)
  returning id into v_offer_id;

  insert into public.edition_default_offers (edition_id, sku_id, offer_id)
  values (p_edition_id, v_sku_id, v_offer_id)
  on conflict (edition_id) do nothing;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'create_offer', 'offers', v_offer_id,
          jsonb_build_object('edition_id', p_edition_id, 'currency', p_currency, 'price_minor', p_price_minor));
  return v_offer_id;
end;
$$;

create function public.admin_set_default_offer(p_edition_id uuid, p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_default_offer: caller is not an admin' using errcode = '42501';
  end if;

  select o.sku_id into v_sku_id
  from public.offers o join public.skus s on s.id = o.sku_id
  where o.id = p_offer_id and s.edition_id = p_edition_id;
  if v_sku_id is null then
    raise exception 'admin_set_default_offer: offer % is not an offer of edition %', p_offer_id, p_edition_id
      using errcode = 'P0002';
  end if;

  insert into public.edition_default_offers (edition_id, sku_id, offer_id)
  values (p_edition_id, v_sku_id, p_offer_id)
  on conflict (edition_id) do update set sku_id = excluded.sku_id, offer_id = excluded.offer_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_default_offer', 'editions', p_edition_id, jsonb_build_object('offer_id', p_offer_id));
end;
$$;

revoke all on function public.admin_create_edition(uuid, text, integer, text, date) from public, anon;
revoke all on function public.admin_save_edition(uuid, text, integer, date, text, jsonb, text) from public, anon;
revoke all on function public.admin_set_default_edition(uuid, text, uuid) from public, anon;
revoke all on function public.admin_create_offer(uuid, text, text, bigint) from public, anon;
revoke all on function public.admin_set_default_offer(uuid, uuid) from public, anon;
grant execute on function public.admin_create_edition(uuid, text, integer, text, date) to authenticated, service_role;
grant execute on function public.admin_save_edition(uuid, text, integer, date, text, jsonb, text) to authenticated, service_role;
grant execute on function public.admin_set_default_edition(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.admin_create_offer(uuid, text, text, bigint) to authenticated, service_role;
grant execute on function public.admin_set_default_offer(uuid, uuid) to authenticated, service_role;
