-- Task 8: the two reader-session RPCs - create_reader_session and authorize_reader_session -
-- plus the narrow cover read the library page needs.
--
-- Renumbering note: named 20260911200000, not an earlier timestamp. Same hosted-project hazard
-- Rulings P/AV and the Task 6/7 migrations all closed already: a migration timestamped before one
-- that has already been applied is never picked up by a hosted project applying migrations
-- incrementally as they land. The latest applied migration is 20260911190000_entitlement_rpcs.sql.
--
-- Custom SQLSTATE introduced here, continuing the EB0xx series:
--   EB008 - create_reader_session: the caller may not open a reader session for this
--           publication. Deliberately ONE code for every reason - no profile, no active
--           entitlement, publication does not exist, is not 'published', is not the book's
--           active publication, or the book itself is not published. The application layer
--           (lib/reader/session.ts) maps it to a single opaque denial, and the route handlers
--           map that to one 404. Splitting this into per-reason codes would hand a caller an
--           existence oracle: "you lack entitlement to this real publication" is exactly the
--           signal that must be indistinguishable from "no such publication".
--
-- authorize_reader_session takes the opposite shape on purpose: it RAISES nothing and returns
-- zero rows for every refusal, so it cannot leak which of the six per-request checks failed even
-- through an error code.

-- ============================================================================================
-- create_reader_session: mints one short-lived, opaque session for the caller's OWN profile.
--
-- Ruling AO's customer-authorization model, matching acquire_free_ebook exactly: the profile is
-- derived from auth.uid() inside the function, and there is deliberately NO p_profile_id
-- parameter for a caller to substitute another reader's id into. This is reachable from a Route
-- Handler, so a caller-supplied profile id would be a direct IDOR primitive. EXECUTE goes to
-- authenticated (every signed-in reader may call it), never to anon or service_role - auth.uid()
-- is null under service_role (Ruling W's trap), so a service-role grant would be a permission
-- that can never succeed.
--
-- Session lifetime is server-derived and clamped twice. The application passes
-- READER_SESSION_TTL_SECONDS, already validated to 60-3600 by lib/config/server-env-schema.ts,
-- and this function clamps it again in SQL. The second clamp is what makes the ceiling real: an
-- authenticated user can call this RPC directly through PostgREST with any p_ttl_seconds they
-- like, and the clamp - not the application's good behaviour - is what stops them minting a
-- year-long session.
create function public.create_reader_session(p_publication_id uuid, p_ttl_seconds integer)
returns table (id uuid, publication_version integer, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_publication_version integer;
  v_publication_status public.publication_status;
  v_active_publication_id uuid;
  v_book_status public.content_status;
  v_ttl_seconds integer;
  v_session_id uuid;
  v_session_expires_at timestamptz;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_reader_session: no reader session available' using errcode = 'EB008';
  end if;

  -- The publication's real book, derived from its own asset/edition chain rather than trusted
  -- from any parameter - the same immutable pub -> asset -> edition -> book chain
  -- publish_publication walks (20260911180000_publication_transition_rpcs.sql).
  select e.book_id, pub.version, pub.status
  into v_book_id, v_publication_version, v_publication_status
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where pub.id = p_publication_id;

  if v_book_id is null then
    raise exception 'create_reader_session: no reader session available' using errcode = 'EB008';
  end if;

  select b.active_publication_id, b.status
  into v_active_publication_id, v_book_status
  from public.books b
  where b.id = v_book_id;

  -- All three conditions, not just the publication's own status: a publication can be
  -- 'published' while the book's active pointer has moved elsewhere, and Ruling BL means a
  -- published book is also the condition for the catalog being visible at all.
  if v_publication_status <> 'published'
     or v_active_publication_id is distinct from p_publication_id
     or v_book_status <> 'published' then
    raise exception 'create_reader_session: no reader session available' using errcode = 'EB008';
  end if;

  if not exists (
    select 1 from public.entitlements en
    where en.profile_id = v_profile_id
      and en.book_id = v_book_id
      and en.status = 'active'
  ) then
    raise exception 'create_reader_session: no reader session available' using errcode = 'EB008';
  end if;

  v_ttl_seconds := greatest(60, least(3600, coalesce(p_ttl_seconds, 900)));

  -- Columns in RETURNING are qualified with the table name because this function's own OUT
  -- parameters are named id/publication_version/expires_at too - left unqualified, each would be
  -- ambiguous against the OUT parameter of the same name (the same collision apply_payment_event
  -- documents for its order_status/payment_status parameters).
  insert into public.reader_sessions (profile_id, publication_id, publication_version, expires_at)
  values (v_profile_id, p_publication_id, v_publication_version, now() + make_interval(secs => v_ttl_seconds))
  returning reader_sessions.id, reader_sessions.expires_at
  into v_session_id, v_session_expires_at;

  return query select v_session_id, v_publication_version, v_session_expires_at;
end;
$$;

revoke execute on function public.create_reader_session(uuid, integer) from public, anon;
grant execute on function public.create_reader_session(uuid, integer) to authenticated;

-- ============================================================================================
-- authorize_reader_session: the per-request recheck behind every manifest and resource read.
--
-- Re-runs the ENTIRE access decision on each call - ownership, expiry, revocation, entitlement,
-- publication status, and version - rather than merely confirming a session id exists. This is
-- per-request and not a creation-time check for a specific reason: reader_sessions' composite FK
-- pins a session to (publication_id, publication_version), but a superseded publication keeps
-- its (id, version) and therefore still satisfies that FK, so a session can outlive the
-- publication's activity. The version comparison below is what actually catches that.
--
-- Returns zero rows for every refusal instead of raising. There is no error code to tell the
-- six failure reasons apart, which is the same non-disclosure property EB008 gives the minting
-- path, achieved without an exception the caller could distinguish by SQLSTATE.
create function public.authorize_reader_session(p_session_id uuid, p_publication_id uuid)
returns table (profile_id uuid, publication_id uuid, publication_version integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_session_version integer;
  v_book_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    return;
  end if;

  -- Scoped to the caller's own profile AND the publication actually being requested, so a
  -- session minted for one publication can never authorize a read of another.
  select s.publication_version into v_session_version
  from public.reader_sessions s
  where s.id = p_session_id
    and s.profile_id = v_profile_id
    and s.publication_id = p_publication_id
    and s.revoked_at is null
    and s.expires_at > now();

  if v_session_version is null then
    return;
  end if;

  select e.book_id into v_book_id
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  join public.books b on b.id = e.book_id
  where pub.id = p_publication_id
    and pub.status = 'published'
    and pub.version = v_session_version
    and b.active_publication_id = pub.id
    and b.status = 'published';

  if v_book_id is null then
    return;
  end if;

  -- Entitlement is rechecked here, not merely at creation: an admin revoking access mid-session
  -- must take effect on the reader's very next request, not when their session happens to expire.
  if not exists (
    select 1 from public.entitlements en
    where en.profile_id = v_profile_id
      and en.book_id = v_book_id
      and en.status = 'active'
  ) then
    return;
  end if;

  return query select v_profile_id, p_publication_id, v_session_version;
end;
$$;

revoke execute on function public.authorize_reader_session(uuid, uuid) from public, anon;
grant execute on function public.authorize_reader_session(uuid, uuid) to authenticated;

-- ============================================================================================
-- Cover art for the library page (Task 1 review, Minor 4). Covers come from the existing
-- marketing data in media_assets, never from inside the EPUB - ProcessedPublication cannot
-- identify a cover resource at all, which is exactly what that carry-forward asked Task 8 to
-- confirm rather than discover.
--
-- Expressible as a policy, so it is one (Ruling AP) rather than another service-role read: the
-- library page then needs no privileged client at all.
--
-- The grant is COLUMN-level and deliberately omits storage_key. A row-level policy cannot hide a
-- column, and media_assets.storage_key is the one field on this table that names a private
-- object; withholding it at the grant means no browser role can select it even by asking
-- directly through PostgREST. Same column-level idiom as this schema's existing
-- `grant update (display_name, locale) on public.profiles`.
grant select (id, owner_type, owner_id, kind, alt_text, width, height)
  on public.media_assets to anon, authenticated;

create policy "public read cover media of published books" on public.media_assets
  for select
  to anon, authenticated
  using (
    kind = 'cover'
    and owner_type = 'book'
    and exists (
      select 1 from public.books b
      where b.id = media_assets.owner_id
        and b.status = 'published'
    )
  );
