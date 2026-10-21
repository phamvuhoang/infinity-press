-- Owners keep reading after unpublish or rollback
-- (docs/superpowers/specs/2026-10-21-owner-reads-unpublished-design.md).
--
-- Rule: a reader with an active entitlement to an edition can always read it; revoking the
-- entitlement is the only way to remove access. books.status and editions.status play no part.
-- Each edition has one readable publication:
--   1. editions.active_publication_id, while that publication is 'published';
--   2. else the edition's latest 'published' or 'superseded' publication (processed_at, id desc);
--   3. else none.
--
-- public.reader_edition_for_publication stays the single reader gate. It now asks
-- reader_publication_for_edition instead of checking book, edition and pointer state, so every
-- caller inherits the rule with its opaque denial unchanged: create_reader_session (EB008),
-- authorize_reader_session (zero rows, which search and annotations also use),
-- save_reading_progress (EB009), submit_edition_feedback, and the four reader_annotations policies.
-- create_shared_quote also asked this rule; it re-checks books.status itself in
-- 20261021120000_shared_quote_published_book.sql, because a public share card needs a published book.

create or replace function public.reader_publication_for_edition(p_edition_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (
      select pub.id
      from public.editions e
      join public.ebook_publications pub on pub.id = e.active_publication_id
      where e.id = p_edition_id and pub.status = 'published'
    ),
    (
      select pub.id
      from public.ebook_publications pub
      join public.ebook_assets a on a.id = pub.ebook_asset_id
      where a.edition_id = p_edition_id and pub.status in ('published', 'superseded')
      order by pub.processed_at desc, pub.id desc
      limit 1
    )
  );
$function$;

-- Granting this would turn any edition id into its publication id; only definer functions call it.
revoke execute on function public.reader_publication_for_edition(uuid) from public, anon, authenticated, service_role;

create or replace function public.reader_edition_for_publication(p_profile_id uuid, p_publication_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select e.id
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where pub.id = p_publication_id
    and pub.id = public.reader_publication_for_edition(e.id)
    -- A signed-in caller can ask only about themselves; the service role (no auth.uid()) can ask about anyone.
    and (auth.uid() is null or p_profile_id = (select pr.id from public.profiles pr where pr.auth_user_id = auth.uid()))
    and exists (
      select 1 from public.entitlements en
      where en.profile_id = p_profile_id and en.edition_id = e.id and en.status = 'active'
    );
$function$;
