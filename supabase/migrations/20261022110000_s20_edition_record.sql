-- S20 edition record. An edition says what kind of text it is and how much of it an editor
-- reviewed; the book page shows that beside the provenance notes from 20261020200000 ("About this
-- edition"). The record stays evidence for the reader, not a legal determination.

alter table public.editions
  add column text_kind text check (text_kind in ('literal', 'adapted', 'commentary')),
  add column review_scope text not null default 'none' check (review_scope in ('full', 'sample', 'none')),
  -- The public "Version notes". review_note stays internal: it can hold a block reason.
  add column public_version_note text check (char_length(public_version_note) <= 2000);

-- The five-argument version is replaced by one with three defaulted arguments, so existing callers
-- keep working. text_kind, review_scope and the public version note describe the edition; changing
-- them does not withdraw an approval, which covers the four notes only.
drop function public.admin_save_edition_provenance(uuid, text, text, text, text);

create function public.admin_save_edition_provenance(
  p_edition_id uuid,
  p_text_source_note text,
  p_translation_source text,
  p_rights_note text,
  p_territory_note text,
  p_text_kind text default null,
  p_review_scope text default 'none',
  p_public_version_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_old public.editions;
  v_text text := nullif(btrim(p_text_source_note), '');
  v_translation text := nullif(btrim(p_translation_source), '');
  v_rights text := nullif(btrim(p_rights_note), '');
  v_territory text := nullif(btrim(p_territory_note), '');
  v_kind text := nullif(btrim(p_text_kind), '');
  v_scope text := coalesce(nullif(btrim(p_review_scope), ''), 'none');
  v_version_note text := nullif(btrim(p_public_version_note), '');
  v_changed boolean;
begin
  if not public.is_admin() then
    raise exception 'admin_save_edition_provenance: caller is not an admin' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(array[v_text, v_translation, v_rights, v_territory, v_version_note]) t(v) where length(coalesce(v, '')) > 2000) then
    raise exception 'admin_save_edition_provenance: each note is limited to 2000 characters' using errcode = '22023';
  end if;
  if v_kind is not null and v_kind not in ('literal', 'adapted', 'commentary') then
    raise exception 'admin_save_edition_provenance: unknown text kind %', v_kind using errcode = '22023';
  end if;
  if v_scope not in ('full', 'sample', 'none') then
    raise exception 'admin_save_edition_provenance: unknown review scope %', v_scope using errcode = '22023';
  end if;

  select * into v_old from public.editions where id = p_edition_id for update;
  if not found then
    raise exception 'admin_save_edition_provenance: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  -- Evidence changed after an approval: the approval no longer describes it, so it must be given
  -- again (and its reviewer and date go with it). A block stays a block until someone lifts it.
  v_changed := v_old.text_source_note is distinct from v_text
    or v_old.translation_source is distinct from v_translation
    or v_old.rights_note is distinct from v_rights
    or v_old.territory_note is distinct from v_territory;

  update public.editions
  set text_source_note = v_text, translation_source = v_translation, rights_note = v_rights, territory_note = v_territory,
      text_kind = v_kind, review_scope = v_scope, public_version_note = v_version_note,
      editorial_state = case when v_changed and editorial_state = 'approved' then 'unreviewed' else editorial_state end,
      reviewed_by = case when v_changed and editorial_state = 'approved' then null else reviewed_by end,
      reviewed_at = case when v_changed and editorial_state = 'approved' then null else reviewed_at end
  where id = p_edition_id;

  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'save_edition_provenance', 'editions', p_edition_id, '{}'::jsonb);
end;
$$;
revoke all on function public.admin_save_edition_provenance(uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.admin_save_edition_provenance(uuid, text, text, text, text, text, text, text) to authenticated, service_role;

-- catalog_book_page builds its edition list here, so the record is added once, per edition option.
-- Body otherwise identical to 20261020230000. The record is null when the edition says nothing yet
-- (no note, no text kind, no review scope); reviewedAt alone is the approval date, not a record.
-- review_note is never public: it is the reviewer's internal note and can hold a block reason.
CREATE OR REPLACE FUNCTION public.catalog_book_editions(p_book_id uuid, p_locale text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'editionId', e.id,
    'languageCode', e.language_code,
    'epubLanguage', pub.epub_language,
    'isDefault', e.id = (select r.edition_id from public.catalog_resolved_editions(p_locale, p_book_id) r),
    'offerId', o.offer_id,
    'priceMinor', o.price_minor,
    'currency', o.currency,
    'listPriceMinor', o.list_price_minor,
    'saleEndsAt', o.sale_ends_at,
    'hasSample', exists (
      select 1 from public.book_samples s
      where s.publication_id = e.active_publication_id and jsonb_array_length(s.allowed_hrefs) > 0),
    'record', case
      when coalesce(e.text_source_note, e.translation_source, e.rights_note, e.territory_note, e.text_kind, e.public_version_note) is null
        and e.review_scope = 'none' then null
      else jsonb_build_object(
        'textSourceNote', e.text_source_note,
        'translationSource', e.translation_source,
        'rightsNote', e.rights_note,
        'territoryNote', e.territory_note,
        'textKind', e.text_kind,
        'reviewScope', e.review_scope,
        'reviewedAt', e.reviewed_at,
        'versionNote', e.public_version_note)
    end
  ) order by (e.id = (select r.edition_id from public.catalog_resolved_editions(p_locale, p_book_id) r)) desc, e.language_code, e.edition_number), '[]'::jsonb)
  from public.editions e
  join public.ebook_publications pub on pub.id = e.active_publication_id
  left join lateral public.catalog_edition_offer(e.id) o on true
  where e.book_id = p_book_id and public.edition_is_sellable(e.id);
$function$;
