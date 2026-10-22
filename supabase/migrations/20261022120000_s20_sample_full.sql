-- Whole-book free sample. ["*"] in book_samples.allowed_hrefs opens every resource of the publication
-- to anonymous readers (lib/reader/session.ts sampleAllows); false puts back the worker's default
-- list. complete_processing_job wrote that list from the same set the worker marked
-- access_class = 'sample' (lib/epub/process.ts derives both from one set), so re-deriving it from
-- ebook_resources restores exactly what processing produced.
create function public.admin_set_sample_full(p_publication_id uuid, p_full boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_edition_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_sample_full: caller is not an admin' using errcode = '42501';
  end if;

  -- Only a free edition opens in full. Free means the offer readers are shown
  -- (catalog_edition_offer: the default offer, or the sole active one) costs 0, or the edition has
  -- no active offer at all. Closing is always allowed, so an admin can undo it after a price change.
  select a.edition_id into v_edition_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  where p.id = p_publication_id;
  if p_full and not (
    exists (select 1 from public.catalog_edition_offer(v_edition_id) o where o.price_minor = 0)
    or not exists (
      select 1 from public.offers o
      join public.skus s on s.id = o.sku_id
      where s.edition_id = v_edition_id and o.active and s.active
    )
  ) then
    raise exception 'admin_set_sample_full: only a free edition can open its whole book as a sample' using errcode = '22023';
  end if;

  update public.book_samples
  set allowed_hrefs = case
    when p_full then '["*"]'::jsonb
    else coalesce(
      (select jsonb_agg(r.href order by r.href) from public.ebook_resources r
       where r.publication_id = p_publication_id and r.access_class = 'sample'),
      '[]'::jsonb)
  end
  where publication_id = p_publication_id;
  if not found then
    raise exception 'admin_set_sample_full: publication % has no sample row', p_publication_id using errcode = 'P0002';
  end if;

  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'set_sample_full', 'ebook_publications', p_publication_id, jsonb_build_object('full', p_full));
end;
$$;
revoke all on function public.admin_set_sample_full(uuid, boolean) from public, anon;
grant execute on function public.admin_set_sample_full(uuid, boolean) to authenticated, service_role;
