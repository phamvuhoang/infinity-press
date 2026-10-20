-- The caller's own editions with an active entitlement, whatever the book or edition status
-- (docs/superpowers/specs/2026-10-21-owner-reads-unpublished-design.md). The library and the
-- reader take titles, covers, language codes and the readable publication from here instead of
-- the published catalog, so an owner keeps their books after "Unpublish book".
--
-- Filtered on auth.uid(), not on RLS: an admin sees only their own entitlements. It is a definer
-- function because media_assets.storage_key is withheld from browser roles.
create or replace function public.my_library_editions(p_locale text)
returns table (
  book_id uuid,
  edition_id uuid,
  language_code text,
  slug text,
  title text,
  author_name text,
  cover_storage_key text,
  cover_alt_text text,
  publication_id uuid,
  in_catalog boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    e.id,
    e.language_code,
    bl.slug,
    bl.title,
    coalesce(al.name, a.display_name),
    cover.storage_key,
    cover.alt_text,
    public.reader_publication_for_edition(e.id),
    exists (select 1 from public.catalog_resolved_editions(p_locale, b.id))
  from public.profiles p
  join public.entitlements en on en.profile_id = p.id and en.status = 'active' and en.edition_id is not null
  join public.editions e on e.id = en.edition_id
  join public.books b on b.id = e.book_id
  -- Requested locale, then the platform default, then the book's original language, then any other.
  join lateral (
    select l.slug, l.title
    from public.book_localizations l
    where l.book_id = b.id
    order by (l.locale = p_locale) desc,
             (l.locale = (select s.default_metadata_locale from public.platform_settings s)) desc,
             (l.locale = b.original_language) desc,
             l.locale
    limit 1
  ) bl on true
  join public.authors a on a.id = b.primary_author_id
  left join lateral public.catalog_entity_copy('author', p_locale, a.id) al on true
  left join lateral (
    -- The edition's own cover, else the work's.
    select m.storage_key, m.alt_text
    from public.media_assets m
    where (m.owner_type = 'edition' and m.owner_id = e.id and m.kind = 'cover')
       or (m.owner_type = 'book' and m.owner_id = b.id and m.kind = 'cover')
    order by (m.owner_type = 'edition') desc
    limit 1
  ) cover on true
  where p.auth_user_id = auth.uid();
$$;

revoke execute on function public.my_library_editions(text) from public, anon, service_role;
grant execute on function public.my_library_editions(text) to authenticated;
