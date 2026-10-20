-- S4: whole-book progression and the library state it drives
-- (docs/superpowers/specs/2026-09-16-s4-reader-completion-design.md 4.4).
--
-- Why a new column rather than redefining `progression`: `progression` is the position WITHIN the
-- current resource, which is what the locator's own `progression` field means and what every
-- existing row holds. The library rendered its percentage and its state from it, so a reader two
-- pages into a long first chapter was shown "90% - Finished". Overloading the column would have
-- left it disagreeing with locator_json.progression in the same row; a second column lets both
-- figures mean exactly one thing.
--
-- Nullable on purpose. Rows written before this migration have no whole-book figure, and
-- ReaderLocator.totalProgression is itself `number | null` - an engine need not report one.
alter table public.reading_progress
  add column total_progression numeric check (total_progression between 0 and 1);

-- The argument list changes, so `create or replace` would leave the five-argument version behind as
-- a second overload rather than replacing anything. lib/reader/progress.ts is the only caller and it
-- changes in the same pull request.
drop function public.save_reading_progress(uuid, jsonb, numeric, text, bigint);

create function public.save_reading_progress(
  p_publication_id uuid,
  p_locator jsonb,
  p_progression numeric,
  p_total_progression numeric,
  p_device_id text,
  p_client_sequence bigint
)
returns table (
  locator_json jsonb,
  progression numeric,
  total_progression numeric,
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
  -- transaction would carry an identical timestamp, and a transaction that began early but
  -- committed late would stamp a row with a time older than writes that already landed.
  v_now timestamptz := clock_timestamp();
begin
  if p_device_id is null or length(p_device_id) = 0 or length(p_device_id) > 128 then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  if p_client_sequence is null or p_client_sequence < 0 then
    raise exception 'save_reading_progress: no progress target available' using errcode = 'EB009';
  end if;

  -- New in S4. Null is legal; a number outside [0, 1] is not, and takes the same single refusal
  -- code as every other unusable input. The column's own check constraint would also catch it, but
  -- as a constraint violation with Postgres text attached rather than as EB009.
  if p_total_progression is not null and (p_total_progression < 0 or p_total_progression > 1) then
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

  -- The reconciliation, atomically. Unchanged from 20260911210000 except that total_progression
  -- rides along in the same statement, so a refused save does not write it either:
  --   same device  -> strictly greater client_sequence wins;
  --   other device -> a strictly later SERVER timestamp wins.
  insert into public.reading_progress as rp
    (profile_id, publication_id, locator_json, progression, total_progression, device_id, client_sequence, updated_at)
  values
    (v_profile_id, p_publication_id, p_locator, p_progression, p_total_progression, p_device_id, p_client_sequence, v_now)
  on conflict (profile_id, publication_id) do update
    set locator_json = excluded.locator_json,
        progression = excluded.progression,
        total_progression = excluded.total_progression,
        device_id = excluded.device_id,
        client_sequence = excluded.client_sequence,
        updated_at = excluded.updated_at
    where (rp.device_id = excluded.device_id and excluded.client_sequence > rp.client_sequence)
       or (rp.device_id <> excluded.device_id and excluded.updated_at > rp.updated_at);

  -- New in S4, and gated on `found` so it happens only when the write above actually won. A
  -- refused save is a stale or replayed one; letting it move the shelf would mean a slow save from
  -- a device left on an early chapter could un-complete a finished book.
  --
  -- This is the only write to library_items.state anywhere. Browser roles have no update privilege
  -- on the table and no policy grants one, so the column is reachable only through this
  -- security-definer function. Until now nothing wrote it at all and lib/data/library.ts derived
  -- the state instead; it now reads the column's source of truth, total_progression.
  --
  -- Never downgrades from 'completed': a reader who finishes a book and then pages back to
  -- re-read a chapter has still finished it.
  if found then
    update public.library_items l
    set state = case
          when l.state = 'completed' then 'completed'::public.library_state
          when coalesce(p_total_progression, 0) >= 0.99 then 'completed'::public.library_state
          else 'reading'::public.library_state
        end
    where l.profile_id = v_profile_id and l.book_id = v_book_id;
  end if;

  -- Always return the EFFECTIVE row, whether or not this call is what wrote it. A refused save
  -- gets back the row that won, so the client can reconcile to the server's actual position.
  return query
    select rp.locator_json, rp.progression, rp.total_progression, rp.device_id, rp.client_sequence, rp.updated_at
    from public.reading_progress rp
    where rp.profile_id = v_profile_id
      and rp.publication_id = p_publication_id;
end;
$$;

revoke execute on function public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)
  from public, anon;
grant execute on function public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)
  to authenticated;
