-- Task 10: save_reading_progress - the only write path to public.reading_progress a browser can
-- reach.
--
-- Renumbering note: named 20260911210000, after 20260911200000_reader_sessions.sql, which is the
-- highest migration currently applied. Same hosted-project hazard Rulings P/AV and every Task
-- 6-8 migration closed already: a migration timestamped before one that has already been applied
-- is never picked up by a hosted project applying migrations incrementally as they land.
--
-- Custom SQLSTATE introduced here, continuing the EB0xx series:
--   EB009 - save_reading_progress: the caller may not record progress for this publication.
--           Deliberately ONE code for every reason - no profile, no active entitlement, the
--           publication does not exist, is not 'published', is not the book's active
--           publication, or the book itself is not published. lib/reader/progress.ts maps it to
--           a single opaque ProgressDeniedError and the route handler maps that to one 404.
--           Splitting it per reason would hand a caller an existence oracle, exactly as EB008
--           avoids for the reader-session path.
--
-- Why an RPC at all, rather than the application writing the row: browser roles have no INSERT
-- privilege on reading_progress and only a column-level UPDATE on rows that already exist
-- (20260911100000_mvp_access_admin.sql), so a reader's FIRST save of a book - the common case -
-- is unwritable through the user-session client by construction. Doing it here instead of through
-- the service-role client keeps the entitlement recheck and the write in one transaction, and
-- means no privileged client is constructed on a progress save at all.

-- ============================================================================================
-- save_reading_progress
--
-- Ruling AO's customer-authorization model, identical in shape to create_reader_session: the
-- profile is derived from auth.uid() inside the function and there is deliberately NO
-- p_profile_id parameter for a caller to substitute another reader's id into. EXECUTE goes to
-- authenticated only - never anon, and never service_role, under which auth.uid() is null
-- (Ruling W's trap) so the grant could never succeed anyway.
--
-- The access decision is re-run here in full rather than trusted from an earlier reader-session
-- call: an admin revoking entitlement, or a rollback superseding the publication, must take
-- effect on the very next save, not whenever some session happens to expire. This is the same
-- publication -> asset -> edition -> book chain create_reader_session and authorize_reader_session
-- walk, derived from the publication's own immutable rows rather than trusted from a parameter.
--
-- Reconciliation is the rule specified and unit-tested in lib/reader/progress.ts's
-- reconcileProgress(). SQL cannot call into TypeScript, so the rule is re-derived here and
-- supabase/tests/010_reading_progress.sql is what proves the two agree. Both orderings live in
-- the single ON CONFLICT ... WHERE clause below, which makes the whole check-and-write atomic:
-- two concurrent saves cannot both read "I am newer" and then both write.
create function public.save_reading_progress(
  p_publication_id uuid,
  p_locator jsonb,
  p_progression numeric,
  p_device_id text,
  p_client_sequence bigint
)
returns table (
  locator_json jsonb,
  progression numeric,
  device_id text,
  client_sequence bigint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_publication_status public.publication_status;
  v_active_publication_id uuid;
  v_book_status public.content_status;
  -- clock_timestamp(), deliberately, not now(). now() is the TRANSACTION's start time, which is
  -- the wrong clock for ordering independent writes twice over: every save inside one
  -- transaction would carry an identical timestamp (so a genuine cross-device save could never
  -- be "strictly later" than one that preceded it), and a transaction that began early but
  -- committed late would stamp a row with a time older than writes that already landed - letting
  -- a stale save win a comparison it should lose. clock_timestamp() is the actual wall clock at
  -- the moment of the write, which is what "the server received this one later" has to mean.
  v_now timestamptz := clock_timestamp();
begin
  if p_device_id is null or length(p_device_id) = 0 or length(p_device_id) > 128 then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  if p_client_sequence is null or p_client_sequence < 0 then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  select e.book_id, pub.status
  into v_book_id, v_publication_status
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where pub.id = p_publication_id;

  if v_book_id is null then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  select b.active_publication_id, b.status
  into v_active_publication_id, v_book_status
  from public.books b
  where b.id = v_book_id;

  -- All three conditions, matching create_reader_session: a publication can be 'published' while
  -- the book's active pointer has moved elsewhere (a rollback), and Ruling BL makes the book's
  -- own status the condition for it being readable at all.
  if v_publication_status <> 'published'
     or v_active_publication_id is distinct from p_publication_id
     or v_book_status <> 'published' then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  if not exists (
    select 1 from public.entitlements en
    where en.profile_id = v_profile_id
      and en.book_id = v_book_id
      and en.status = 'active'
  ) then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  -- The reconciliation, atomically. The WHERE clause is reconcileProgress()'s two orderings:
  --   same device  -> strictly greater client_sequence wins (equal is refused: the same sequence
  --                   is the same position, and letting a retry restamp updated_at would hand it
  --                   a later cross-device comparison it has not earned);
  --   other device -> a strictly later SERVER timestamp wins. p_client_sequence is deliberately
  --                   not consulted across devices - two devices number their saves independently.
  -- updated_at is set from v_now, never from any parameter: a client-supplied timestamp would let
  -- a caller win every cross-device comparison forever by claiming a date in the far future.
  insert into public.reading_progress as rp
    (profile_id, publication_id, locator_json, progression, device_id, client_sequence, updated_at)
  values
    (v_profile_id, p_publication_id, p_locator, p_progression, p_device_id, p_client_sequence, v_now)
  on conflict (profile_id, publication_id) do update
    set locator_json = excluded.locator_json,
        progression = excluded.progression,
        device_id = excluded.device_id,
        client_sequence = excluded.client_sequence,
        updated_at = excluded.updated_at
    where (rp.device_id = excluded.device_id and excluded.client_sequence > rp.client_sequence)
       or (rp.device_id <> excluded.device_id and excluded.updated_at > rp.updated_at);

  -- Always return the EFFECTIVE row, whether or not this call is what wrote it. A refused save
  -- gets back the row that won, so the client can reconcile to the server's actual position
  -- instead of being told "saved" and carrying on from a position nothing holds. (The INSERT
  -- above returns no row when its ON CONFLICT predicate is false, so this single read is what
  -- makes the two outcomes look the same to the caller.)
  return query
    select rp.locator_json, rp.progression, rp.device_id, rp.client_sequence, rp.updated_at
    from public.reading_progress rp
    where rp.profile_id = v_profile_id
      and rp.publication_id = p_publication_id;
end;
$$;

revoke execute on function public.save_reading_progress(uuid, jsonb, numeric, text, bigint)
  from public, anon;
grant execute on function public.save_reading_progress(uuid, jsonb, numeric, text, bigint)
  to authenticated;
