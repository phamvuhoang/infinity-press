-- Infinity Books Press, Task 5: access is edition-scoped.
--
-- An entitlement and a library item identify (profile, edition). The reader chain is
-- publication -> asset -> edition -> entitlement: owning English never opens Japanese, whatever
-- URL, session, or resource path is tried. The five RPCs that write entitlements go through one
-- grant primitive, and a trigger refuses to let any remaining book-only insert pick a language for
-- a work that has several.

-- ---------------------------------------------------------------------------------------------
-- 1. One edition per entitlement, whoever writes it.
--
-- Evidence order: the SKU on the order behind the entitlement, then the only edition of a
-- single-edition work. Anything else raises: there is no safe default and no row is granted a
-- language it was not bought in.
create function public.entitlements_resolve_edition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_editions uuid[];
begin
  if new.edition_id is null then
    select coalesce(array_agg(distinct s.edition_id), '{}'::uuid[]) into v_editions
    from public.order_items oi
    join public.skus s on s.id = oi.sku_id
    join public.editions e on e.id = s.edition_id and e.book_id = new.book_id
    where oi.order_id = new.source_order_id and oi.book_id = new.book_id;

    if cardinality(v_editions) = 0 then
      select coalesce(array_agg(e.id), '{}'::uuid[]) into v_editions
      from public.editions e where e.book_id = new.book_id;
    end if;

    -- No edition exists: nothing readable can be granted yet, so the row stays unscoped. Several
    -- editions with no evidence which one: refuse, rather than choose a language.
    if cardinality(v_editions) > 1 then
      raise exception 'entitlement for book % needs an explicit edition', new.book_id using errcode = '23514';
    end if;
    new.edition_id := v_editions[1];
  end if;
  return new;
end;
$$;
create trigger entitlements_resolve_edition_guard
  before insert on public.entitlements
  for each row execute function public.entitlements_resolve_edition();

create function public.library_items_resolve_edition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.edition_id is null then
    select en.edition_id into new.edition_id from public.entitlements en where en.id = new.entitlement_id;
  end if;
  return new;
end;
$$;
create trigger library_items_resolve_edition_guard
  before insert on public.library_items
  for each row execute function public.library_items_resolve_edition();

-- The book-only identities give way to the edition ones added in 20261020110000.
drop index public.entitlements_active_subject_key;
drop index public.library_items_profile_book_key;
create index library_items_profile_book_idx on public.library_items (profile_id, book_id);

-- ---------------------------------------------------------------------------------------------
-- 2. The grant primitive. Idempotent per (profile, edition): an existing active entitlement is
-- returned untouched, so a second source never creates a second row and never rewrites the first.
create function public.press_grant_edition_access(
  p_profile_id uuid,
  p_edition_id uuid,
  p_source_type public.entitlement_source,
  p_source_order_id uuid,
  p_actor_profile_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_id uuid;
  v_entitlement_id uuid;
begin
  select e.book_id into v_book_id from public.editions e where e.id = p_edition_id;
  if v_book_id is null then
    raise exception 'press_grant_edition_access: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  insert into public.entitlements (profile_id, book_id, edition_id, source_type, source_order_id, actor_profile_id, reason, status)
  values (p_profile_id, v_book_id, p_edition_id, p_source_type, p_source_order_id, p_actor_profile_id, p_reason, 'active')
  on conflict (profile_id, edition_id) where status = 'active' and edition_id is not null do nothing
  returning id into v_entitlement_id;

  if v_entitlement_id is null then
    -- Lost a race to, or repeated, an earlier grant of the same edition: that one stands.
    select en.id into v_entitlement_id
    from public.entitlements en
    where en.profile_id = p_profile_id and en.edition_id = p_edition_id and en.status = 'active';
  end if;

  insert into public.library_items (profile_id, book_id, edition_id, entitlement_id)
  values (p_profile_id, v_book_id, p_edition_id, v_entitlement_id)
  on conflict (profile_id, edition_id) where edition_id is not null do nothing;

  return v_entitlement_id;
end;
$$;
revoke all on function public.press_grant_edition_access(uuid, uuid, public.entitlement_source, uuid, uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. The one reading rule. Returns the edition a reader may open through this publication, or
-- null. All of: the publication is its edition's live one and published; the edition is published
-- (or archived: owners keep an old edition, new buyers never see it); the work is published; and
-- this profile holds an active entitlement for THIS edition.
create function public.reader_edition_for_publication(p_profile_id uuid, p_publication_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  join public.books b on b.id = e.book_id
  where pub.id = p_publication_id
    and pub.status = 'published'
    and e.active_publication_id = pub.id
    and e.status in ('published', 'archived')
    and b.status = 'published'
    and exists (
      select 1 from public.entitlements en
      where en.profile_id = p_profile_id and en.edition_id = e.id and en.status = 'active'
    );
$$;
revoke all on function public.reader_edition_for_publication(uuid, uuid) from public, anon;
grant execute on function public.reader_edition_for_publication(uuid, uuid) to authenticated, service_role;

-- Annotation policies: the reader owns the row and may read this edition (not merely this work).
drop policy "reader owns entitled current annotations" on public.reader_annotations;
drop policy "reader inserts entitled current annotations" on public.reader_annotations;
drop policy "reader updates entitled current annotations" on public.reader_annotations;
drop policy "reader deletes entitled current annotations" on public.reader_annotations;

create policy "reader owns entitled current annotations" on public.reader_annotations
  for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = reader_annotations.profile_id and p.auth_user_id = (select auth.uid()))
    and public.reader_edition_for_publication(reader_annotations.profile_id, reader_annotations.publication_id) is not null
  );
create policy "reader inserts entitled current annotations" on public.reader_annotations
  for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = reader_annotations.profile_id and p.auth_user_id = (select auth.uid()))
    and public.reader_edition_for_publication(reader_annotations.profile_id, reader_annotations.publication_id) is not null
  );
create policy "reader updates entitled current annotations" on public.reader_annotations
  for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = reader_annotations.profile_id and p.auth_user_id = (select auth.uid()))
    and public.reader_edition_for_publication(reader_annotations.profile_id, reader_annotations.publication_id) is not null
  )
  with check (
    exists (select 1 from public.profiles p where p.id = reader_annotations.profile_id and p.auth_user_id = (select auth.uid()))
    and public.reader_edition_for_publication(reader_annotations.profile_id, reader_annotations.publication_id) is not null
  );
create policy "reader deletes entitled current annotations" on public.reader_annotations
  for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = reader_annotations.profile_id and p.auth_user_id = (select auth.uid()))
    and public.reader_edition_for_publication(reader_annotations.profile_id, reader_annotations.publication_id) is not null
  );

-- ---------------------------------------------------------------------------------------------
-- 4. The reader RPCs ask the one rule above.
create or replace function public.create_reader_session(p_publication_id uuid, p_ttl_seconds integer)
returns table(id uuid, publication_version integer, expires_at timestamp with time zone)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_publication_version integer;
  v_ttl_seconds integer;
  v_session_id uuid;
  v_session_expires_at timestamptz;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_reader_session: no reader session available' using errcode = 'EB008';
  end if;

  -- One refusal for every reason (no such publication, not live, not published, work hidden, no
  -- entitlement for THIS edition): a caller cannot tell them apart.
  if public.reader_edition_for_publication(v_profile_id, p_publication_id) is null then
    raise exception 'create_reader_session: no reader session available' using errcode = 'EB008';
  end if;

  select pub.version into v_publication_version from public.ebook_publications pub where pub.id = p_publication_id;

  v_ttl_seconds := greatest(60, least(3600, coalesce(p_ttl_seconds, 900)));

  -- Columns in RETURNING are qualified with the table name because this function's own OUT
  -- parameters are named id/publication_version/expires_at too.
  insert into public.reader_sessions (profile_id, publication_id, publication_version, expires_at)
  values (v_profile_id, p_publication_id, v_publication_version, now() + make_interval(secs => v_ttl_seconds))
  returning reader_sessions.id, reader_sessions.expires_at
  into v_session_id, v_session_expires_at;

  return query select v_session_id, v_publication_version, v_session_expires_at;
end;
$$;

create or replace function public.authorize_reader_session(p_session_id uuid, p_publication_id uuid)
returns table(profile_id uuid, publication_id uuid, publication_version integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_session_version integer;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    return;
  end if;

  -- Scoped to the caller's own profile AND the publication actually being requested, so a
  -- session minted for one publication (one edition) can never authorize a read of another.
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

  -- The session is for the version it was minted against, and the rule is rechecked on every
  -- request: revoking access mid-session takes effect on the very next one.
  if not exists (
    select 1 from public.ebook_publications pub where pub.id = p_publication_id and pub.version = v_session_version
  ) or public.reader_edition_for_publication(v_profile_id, p_publication_id) is null then
    return;
  end if;

  return query select v_profile_id, p_publication_id, v_session_version;
end;
$$;

-- save_reading_progress: the same rule, one refusal.
create or replace function public.save_reading_progress(p_publication_id uuid, p_locator jsonb, p_progression numeric, p_total_progression numeric, p_device_id text, p_client_sequence bigint)
 RETURNS TABLE(locator_json jsonb, progression numeric, total_progression numeric, device_id text, client_sequence bigint, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_edition_id uuid;
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

  v_edition_id := public.reader_edition_for_publication(v_profile_id, p_publication_id);
  if v_edition_id is null then
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
    where l.profile_id = v_profile_id and l.edition_id = v_edition_id;
  end if;

  -- Always return the EFFECTIVE row, whether or not this call is what wrote it. A refused save
  -- gets back the row that won, so the client can reconcile to the server's actual position.
  return query
    select rp.locator_json, rp.progression, rp.total_progression, rp.device_id, rp.client_sequence, rp.updated_at
    from public.reading_progress rp
    where rp.profile_id = v_profile_id
      and rp.publication_id = p_publication_id;
end;
$function$
;


-- create_shared_quote: the publication must be readable by THIS profile, for its own edition.
create or replace function public.create_shared_quote(p_publication_id uuid, p_quote text, p_locale text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_edition_id uuid;
  v_quote text := btrim(coalesce(p_quote, ''));
  v_code text;
  v_row public.shared_quotes;
  v_try integer := 0;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_shared_quote: no profile' using errcode = 'EB039';
  end if;
  if length(v_quote) < 1 or length(v_quote) > 1200 or v_quote ~* '</?[a-z][^>]*>'
     or public.shared_quote_graphemes(v_quote) > 300
     or p_locale is null or not public.is_supported_locale(p_locale) then
    raise exception 'create_shared_quote: invalid input' using errcode = 'EB039';
  end if;
  -- The publication must be its edition's live, published one, and the caller must hold THAT edition.
  v_edition_id := public.reader_edition_for_publication(v_profile_id, p_publication_id);
  if v_edition_id is null then
    raise exception 'create_shared_quote: not entitled' using errcode = 'EB039';
  end if;
  select ed.book_id into v_book_id from public.editions ed where ed.id = v_edition_id;
  -- Lock the profile so two concurrent shares at the cap cannot both pass the count.
  perform 1 from public.profiles where id = v_profile_id for update;
  if (select count(*) from public.shared_quotes where profile_id = v_profile_id and status = 'active') >= 200 then
    raise exception 'create_shared_quote: cap reached' using errcode = 'EB038';
  end if;
  loop
    v_try := v_try + 1;
    v_code := substr(translate(encode(extensions.gen_random_bytes(8), 'base64'), '+/', '-_'), 1, 10);
    begin
      insert into public.shared_quotes (code, book_id, publication_id, profile_id, quote, locale)
      values (v_code, v_book_id, p_publication_id, v_profile_id, v_quote, p_locale)
      returning * into v_row;
      exit;
    exception when unique_violation then
      if v_try >= 3 then raise exception 'create_shared_quote: code collision' using errcode = 'EB039'; end if;
    end;
  end loop;
  insert into public.analytics_events (event_name, dedupe_key, profile_id, book_id, locale, shared_quote_id)
  values ('share_quote', 'share/' || v_row.id, v_profile_id, v_book_id, p_locale, v_row.id);
  return public.shared_quote_json(v_row);
end;
$function$
;


-- ---------------------------------------------------------------------------------------------
-- 5. Grants and revocations, per edition.
drop function public.grant_complimentary_entitlement(uuid, uuid, text);
create function public.grant_complimentary_entitlement(p_profile_id uuid, p_edition_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
  v_entitlement_id uuid;
  v_book_id uuid;
begin
  if not public.is_admin() then
    raise exception 'grant_complimentary_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'grant_complimentary_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'grant_complimentary_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception 'grant_complimentary_entitlement: profile % does not exist', p_profile_id using errcode = 'P0002';
  end if;
  select e.book_id into v_book_id from public.editions e where e.id = p_edition_id;
  if v_book_id is null then
    raise exception 'grant_complimentary_entitlement: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  -- Lock this subject's entitlement row, if any, so a concurrent grant/revoke on the same
  -- (profile, book) can't race this one. Prefers an already-active row over a merely more recent
  -- revoked one: the active-edition unique index allows only one active row per (profile, edition),
  -- so reactivating a stale revoked row while an active one exists would violate it outright.
  select id into v_entitlement_id
  from public.entitlements
  where profile_id = p_profile_id and edition_id = p_edition_id
  order by (status = 'active') desc, granted_at desc
  limit 1
  for update;

  -- Ruling BQ: spec 6.3 point 1 ("an admin selects a verified customer identity") governs
  -- selecting a person to grant access to for the first time - not continuously re-verifying one
  -- who already had it. The entitlement's subject is profile_id, and an email change (which
  -- resets customer_identities.verified_at to null via the existing trigger, pending
  -- reconfirmation) does not change who the profile is. So this check applies only when
  -- v_entitlement_id is still null here - a genuinely new grant - never to a reactivation of an
  -- existing row for the same profile, whatever its current verification state.
  if v_entitlement_id is null and not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = p_profile_id and ci.verified_at is not null
  ) then
    raise exception 'grant_complimentary_entitlement: profile % has no verified identity', p_profile_id
      using errcode = 'EB007';
  end if;

  if v_entitlement_id is not null then
    -- Reactivates an existing row (spec 6.3 point 3: "grants or reactivates") and converts it to
    -- an admin_grant regardless of its previous source - an admin explicitly granting
    -- complimentary access always records that actor and reason, even over a reader's own prior
    -- free_order or simulated_payment entitlement.
    update public.entitlements
    set status = 'active',
        source_type = 'admin_grant',
        source_order_id = null,
        actor_profile_id = v_actor_profile_id,
        reason = p_reason,
        revoked_at = null,
        granted_at = now()
    where id = v_entitlement_id;
  else
    insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status)
    values (p_profile_id, v_book_id, p_edition_id, 'admin_grant', v_actor_profile_id, p_reason, 'active')
    returning id into v_entitlement_id;
  end if;

  insert into public.library_items (profile_id, book_id, edition_id, entitlement_id)
  values (p_profile_id, v_book_id, p_edition_id, v_entitlement_id)
  on conflict (profile_id, edition_id) where edition_id is not null do update set entitlement_id = excluded.entitlement_id;

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (
    v_actor_profile_id,
    'grant_complimentary_entitlement',
    'entitlements',
    v_entitlement_id,
    p_reason,
    jsonb_build_object('profile_id', p_profile_id, 'book_id', v_book_id, 'edition_id', p_edition_id)
  );

  return v_entitlement_id;
end;
$function$
;

revoke all on function public.grant_complimentary_entitlement(uuid, uuid, text) from public, anon;
grant execute on function public.grant_complimentary_entitlement(uuid, uuid, text) to authenticated, service_role;

create or replace function public.revoke_complimentary_entitlement(p_profile_id uuid, p_entitlement_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
  v_book_id uuid;
  v_edition_id uuid;
  v_status public.entitlement_status;
begin
  if not public.is_admin() then
    raise exception 'revoke_complimentary_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'revoke_complimentary_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'revoke_complimentary_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  select e.book_id, e.edition_id, e.status into v_book_id, v_edition_id, v_status
  from public.entitlements e
  where e.id = p_entitlement_id
    and e.profile_id = p_profile_id
    and e.source_type = 'admin_grant'
  for update;

  if v_book_id is null then
    raise exception 'revoke_complimentary_entitlement: complimentary entitlement does not exist'
      using errcode = 'P0002';
  end if;

  if v_status = 'active' then
    update public.entitlements
    set status = 'revoked', revoked_at = now()
    where id = p_entitlement_id;

    insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
    values (
      v_actor_profile_id,
      'revoke_complimentary_entitlement',
      'entitlements',
      p_entitlement_id,
      p_reason,
      jsonb_build_object('profile_id', p_profile_id, 'book_id', v_book_id, 'edition_id', v_edition_id)
    );
  end if;

  delete from public.library_items
  where entitlement_id = p_entitlement_id and profile_id = p_profile_id;

  return p_entitlement_id;
end;
$function$
;


create or replace function public.revoke_order_entitlement(p_order_id uuid, p_reason text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_profile_id uuid;
  v_profile_id uuid;
  v_entitlement_ids uuid[];
  v_revoked_ids uuid[];
begin
  if not public.is_admin() then
    raise exception 'revoke_order_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'revoke_order_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'revoke_order_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  -- Locked before they are read, so two admins revoking the same order are serialized rather than
  -- both deciding against the same active rows.
  perform 1
  from public.entitlements e
  where e.source_order_id = p_order_id
    and e.source_type in ('free_order', 'simulated_payment', 'manual_payment', 'sepay_payment')
  for update;

  -- Every status, not just 'active': a repeat must return the same array it returned the first
  -- time rather than reporting that the order granted nothing.
  select coalesce(array_agg(e.id order by e.edition_id), array[]::uuid[])
  into v_entitlement_ids
  from public.entitlements e
  where e.source_order_id = p_order_id
    and e.source_type in ('free_order', 'simulated_payment', 'manual_payment', 'sepay_payment');

  if cardinality(v_entitlement_ids) = 0 then
    raise exception 'revoke_order_entitlement: order % granted no entitlement', p_order_id using errcode = 'P0002';
  end if;

  with revoked as (
    update public.entitlements e
    set status = 'revoked', revoked_at = now()
    where e.id = any(v_entitlement_ids) and e.status = 'active'
    returning e.id, e.edition_id
  )
  select coalesce(array_agg(r.id order by r.edition_id), array[]::uuid[])
  into v_revoked_ids
  from revoked r;

  if cardinality(v_revoked_ids) > 0 then
    delete from public.library_items where entitlement_id = any(v_revoked_ids);

    select o.profile_id into v_profile_id from public.orders o where o.id = p_order_id;

    insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
    values (
      v_actor_profile_id,
      'revoke_order_entitlement',
      'orders',
      p_order_id,
      p_reason,
      jsonb_build_object(
        'order_id', p_order_id,
        'profile_id', v_profile_id,
        'entitlement_ids', to_jsonb(v_revoked_ids)
      )
    );
  end if;

  return v_entitlement_ids;
end;
$function$
;


-- The active entitlements an order's lines map to, one per edition.
create or replace function public.order_active_entitlement_ids(p_order_id uuid, p_profile_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(b.id order by b.edition_id), array[]::uuid[])
  from (
    select distinct on (s.edition_id) s.edition_id, e.id
    from public.order_items oi
    join public.skus s on s.id = oi.sku_id
    join public.entitlements e
      on e.profile_id = p_profile_id
     and e.edition_id = s.edition_id
     and e.status = 'active'
    where oi.order_id = p_order_id
  ) b;
$$;

-- Free acquisition of ONE named edition. The offer must be free and live: the edition's default
-- offer when that is free, otherwise its earliest free live offer by market. There is no search
-- across the work's editions (the old function took the first free offer of any language).
create function public.acquire_free_edition(p_edition_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_book_id uuid;
  v_offer_id uuid;
  v_sku_id uuid;
  v_market_code text;
  v_currency text;
  v_order_id uuid;
  v_title_snapshot text;
  v_language text;
  v_entitlement_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'acquire_free_edition: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.customer_identities ci where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) then
    raise exception 'acquire_free_edition: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  select e.book_id, e.language_code into v_book_id, v_language from public.editions e where e.id = p_edition_id;
  if v_book_id is null then
    raise exception 'acquire_free_edition: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  -- Idempotent: the reader already holds this edition.
  select id into v_entitlement_id
  from public.entitlements
  where profile_id = v_profile_id and edition_id = p_edition_id and status = 'active';
  if v_entitlement_id is not null then
    return v_entitlement_id;
  end if;

  select o.id, o.sku_id, o.market_code, o.currency
  into v_offer_id, v_sku_id, v_market_code, v_currency
  from public.offers o
  join public.skus s on s.id = o.sku_id and s.active
  join public.editions e on e.id = s.edition_id
  left join public.edition_default_offers d on d.offer_id = o.id
  where e.id = p_edition_id
    and o.active and o.price_minor = 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  order by (d.offer_id is not null) desc, o.market_code, o.id
  limit 1
  for update of o;

  if v_offer_id is null then
    raise exception 'acquire_free_edition: no active free offer for edition %', p_edition_id using errcode = 'EB006';
  end if;

  -- The order's title is the work's, in the platform default metadata locale when it has one.
  select bl.title into v_title_snapshot
  from public.book_localizations bl
  where bl.book_id = v_book_id
  order by (bl.locale = (select s.default_metadata_locale from public.platform_settings s)) desc, bl.locale
  limit 1;

  insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor)
  values (v_profile_id, 'completed', 'not_required', v_market_code, v_currency, 0)
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, edition_id, language_code, offer_id, title_snapshot, unit_price_minor, quantity)
  values (v_order_id, v_sku_id, v_book_id, p_edition_id, v_language, v_offer_id, coalesce(v_title_snapshot, ''), 0, 1);

  return public.press_grant_edition_access(v_profile_id, p_edition_id, 'free_order', v_order_id, null, null);
end;
$$;
revoke all on function public.acquire_free_edition(uuid) from public, anon;
grant execute on function public.acquire_free_edition(uuid) to authenticated, service_role;

-- The book-only entry point stays for callers not yet moved (Task 6), but it no longer picks "the
-- first free offer of any language": it acquires the work's one free edition, or refuses.
create or replace function public.acquire_free_ebook(p_book_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_editions uuid[];
begin
  select coalesce(array_agg(distinct e.id), '{}'::uuid[]) into v_editions
  from public.editions e
  join public.skus s on s.edition_id = e.id and s.active
  join public.offers o on o.sku_id = s.id and o.active and o.price_minor = 0
    and (o.starts_at is null or o.starts_at <= now()) and (o.ends_at is null or o.ends_at > now())
  where e.book_id = p_book_id;

  if cardinality(v_editions) = 0 then
    raise exception 'acquire_free_ebook: no active free offer for book %', p_book_id using errcode = 'EB006';
  end if;
  if cardinality(v_editions) > 1 then
    raise exception 'acquire_free_ebook: book % has several free editions; name one', p_book_id using errcode = 'EB006';
  end if;
  return public.acquire_free_edition(v_editions[1]);
end;
$$;

-- apply_payment_event: grant each EDITION on the order (from its SKU), once.
create or replace function public.apply_payment_event(p_provider text, p_provider_event_id text, p_order_id uuid, p_external_payment_id text, p_status text, p_amount_minor bigint, p_currency text, p_occurred_at timestamp with time zone)
 RETURNS TABLE(entitlement_ids uuid[], order_status order_status, payment_status payment_status)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_source public.entitlement_source;
  v_status public.payment_status;
  v_order_status public.order_status;
  v_payment_status public.payment_status;
  v_order_total_minor bigint;
  v_order_currency text;
  v_order_provider text;
  v_profile_id uuid;
  v_payment_id uuid;
  v_event_row_id uuid;
  v_book_id uuid;
  v_edition_id uuid;
  v_entitlement_id uuid;
  v_entitlement_ids uuid[] := array[]::uuid[];
  v_payload_hash text;
  -- Whether this order was bought for somebody else. Resolved under the order lock below, so it
  -- cannot change between the branches that consult it.
  v_is_gift boolean;
begin
  v_source := case p_provider
    when 'simulator' then 'simulated_payment'::public.entitlement_source
    when 'manual' then 'manual_payment'::public.entitlement_source
    when 'sepay' then 'sepay_payment'::public.entitlement_source
    else null
  end;
  if v_source is null then
    raise exception 'apply_payment_event: unknown provider %', p_provider using errcode = 'EB015';
  end if;

  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'apply_payment_event: invalid status %', p_status using errcode = '22023';
  end if;
  v_status := p_status::public.payment_status;

  select o.status, o.payment_status, o.total_minor, o.currency, o.profile_id, o.payment_provider
  into v_order_status, v_payment_status, v_order_total_minor, v_order_currency, v_profile_id, v_order_provider
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'apply_payment_event: order % does not exist', p_order_id using errcode = 'P0002';
  end if;

  if p_provider <> v_order_provider then
    raise exception 'apply_payment_event: order % is booked under provider %, not %',
      p_order_id, v_order_provider, p_provider using errcode = 'EB016';
  end if;

  v_is_gift := exists (select 1 from public.gifts g where g.order_id = p_order_id);

  select id into v_payment_id
  from public.payments
  where order_id = p_order_id and provider = p_provider
  order by created_at asc
  limit 1
  for update;

  if v_payment_id is null then
    insert into public.payments (order_id, provider, external_payment_id, status, amount_minor, currency)
    values (p_order_id, p_provider, p_external_payment_id, 'pending', p_amount_minor, p_currency)
    returning id into v_payment_id;
  end if;

  v_payload_hash := md5(
    p_provider || ':' || p_provider_event_id || ':' || p_order_id::text || ':' || p_status || ':' ||
    p_amount_minor::text || ':' || p_currency
  );

  insert into public.payment_events (payment_id, provider, provider_event_id, payload_hash, processed_at)
  values (v_payment_id, p_provider, p_provider_event_id, v_payload_hash, now())
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_row_id;

  if v_event_row_id is null then
    -- Replay of an event already processed: return the current outcome, touching nothing else.
    -- A gift order granted the buyer nothing the first time and reports nothing now.
    if not v_is_gift then
      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

    return query select v_entitlement_ids, v_order_status, v_payment_status;
    return;
  end if;

  if v_order_status <> 'pending' then
    -- Out-of-order arrival: the order already left 'pending' (completed or cancelled) via an
    -- earlier-processed event. This new event is recorded (payment_events above) but has no
    -- further effect - it must not resurrect a cancelled order or re-derive a different outcome
    -- for an already-completed one.
    if not v_is_gift then
      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

    return query select v_entitlement_ids, v_order_status, v_payment_status;
    return;
  end if;

  if p_amount_minor <> v_order_total_minor or p_currency <> v_order_currency then
    raise exception 'apply_payment_event: amount/currency mismatch for order %', p_order_id using errcode = 'EB004';
  end if;

  if v_status = 'succeeded' then
    update public.payments
    set status = 'succeeded', external_payment_id = p_external_payment_id
    where id = v_payment_id;
    update public.orders set status = 'completed', payment_status = 'succeeded' where id = p_order_id;

    -- The gift branch (spec 7.2). The order is paid for, so the gift becomes claimable - and the
    -- buyer is granted nothing, because they did not buy it for themselves.
    v_is_gift := public.activate_order_gift(p_order_id);

    if not v_is_gift then
      -- One entitlement and one library item per book of the order. `distinct` because the grant is
      -- per subject, not per line: two lines naming the same book are one piece of access, and the
      -- partial unique index would reject the second insert's conflict target twice over anyway.
      -- Each iteration keeps the single-book version's `on conflict ... do nothing` and its
      -- resolve-by-subject fallback, so a buyer who already owns one member book is unaffected by
      -- it and still gets the rest.
      for v_edition_id in
        select distinct s.edition_id from public.order_items oi join public.skus s on s.id = oi.sku_id where oi.order_id = p_order_id
      loop
        v_entitlement_id := public.press_grant_edition_access(v_profile_id, v_edition_id, v_source, p_order_id, null, null);
      end loop;

      v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
    end if;

    -- S8 (spec 5.3): the order's coupon reservation, if it has one, is redeemed alongside it. Once
    -- per order, outside the loop - a coupon is applied to the order, not to a line - and scoped to
    -- status = 'reserved' so this stays a no-op both for an order with no coupon and for a
    -- replayed event that reaches this branch again. A gift order redeems its coupon too: the sale
    -- happened, whoever ends up reading the book.
    update public.coupon_redemptions r
    set status = 'redeemed', redeemed_at = now()
    where r.order_id = p_order_id and r.status = 'reserved';

    v_order_status := 'completed';
    v_payment_status := 'succeeded';
  elsif v_status = 'failed' then
    update public.payments set status = 'failed' where id = v_payment_id;
    update public.orders set payment_status = 'failed' where id = p_order_id;
    v_payment_status := 'failed';
  else
    update public.payments set status = 'cancelled' where id = v_payment_id;
    update public.orders set status = 'cancelled', payment_status = 'cancelled' where id = p_order_id;
    v_order_status := 'cancelled';
    v_payment_status := 'cancelled';

    -- S8 (spec 5.3): a cancelled order releases its coupon reservation outright, rather than
    -- marking it something else: the code must be free for the same reader, or another, to use
    -- again. A no-op on an order with no coupon.
    delete from public.coupon_redemptions r where r.order_id = p_order_id;
  end if;

  return query select v_entitlement_ids, v_order_status, v_payment_status;
end;
$function$
;


-- apply_coupon_to_order: the zero-total branch, per edition.
create or replace function public.apply_coupon_to_order(p_order_id uuid, p_code text)
 RETURNS TABLE(subtotal_minor bigint, discount_minor bigint, total_minor bigint, order_status order_status, entitlement_ids uuid[], rejection text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_code text;
  v_order record;
  v_coupon record;
  v_discount bigint;
  v_total bigint;
  v_used int;
  v_used_by_profile int;
  v_book_id uuid;
  v_edition_id uuid;
  v_entitlement_id uuid;
  v_has_scope boolean;
  v_in_scope boolean;
  v_entitlement_ids uuid[] := array[]::uuid[];
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'apply_coupon_to_order: no profile for the current session' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('apply_coupon_to_order:' || v_profile_id::text, 0));

  select o.id, o.profile_id, o.status, o.currency, o.subtotal_minor, o.coupon_id, o.bundle_id
  into v_order
  from public.orders o
  where o.id = p_order_id and o.profile_id = v_profile_id
  for update;

  if v_order.id is null or v_order.status <> 'pending' or v_order.coupon_id is not null then
    raise exception 'apply_coupon_to_order: order % is not an uncouponed pending order of the caller', p_order_id
      using errcode = 'EB024';
  end if;

  if exists (select 1 from public.manual_transfer_claims c where c.order_id = p_order_id) then
    raise exception 'apply_coupon_to_order: order % already has a reported transfer', p_order_id
      using errcode = 'EB024';
  end if;

  if public.coupon_attempts_exhausted(v_profile_id) then
    raise log 'apply_coupon_to_order: order % profile %: too many failed attempts', p_order_id, v_profile_id;
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'rate_limited'::text;
    return;
  end if;

  v_code := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));

  select c.* into v_coupon
  from public.coupons c
  where c.code = v_code
  for update;

  if v_coupon.id is null then
    raise log 'apply_coupon_to_order: order % profile %: unknown code', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  if not v_coupon.active then
    raise log 'apply_coupon_to_order: order % profile %: inactive', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
    raise log 'apply_coupon_to_order: order % profile %: not yet started', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  if v_coupon.ends_at is not null and v_coupon.ends_at <= now() then
    raise log 'apply_coupon_to_order: order % profile %: expired', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  v_has_scope :=
    exists (select 1 from public.coupon_books cb where cb.coupon_id = v_coupon.id)
    or exists (select 1 from public.coupon_bundles cbu where cbu.coupon_id = v_coupon.id);

  if v_has_scope then
    if v_order.bundle_id is not null then
      v_in_scope := exists (
        select 1 from public.coupon_bundles cbu
        where cbu.coupon_id = v_coupon.id and cbu.bundle_id = v_order.bundle_id
      );
    else
      select oi.book_id into v_book_id
      from public.order_items oi
      where oi.order_id = p_order_id
      order by oi.position
      limit 1;

      v_in_scope := exists (
        select 1 from public.coupon_books cb
        where cb.coupon_id = v_coupon.id and cb.book_id = v_book_id
      );
    end if;

    if not v_in_scope then
      raise log 'apply_coupon_to_order: order % profile %: out of scope', p_order_id, v_profile_id;
      perform public.record_coupon_failure(v_profile_id);
      return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                          v_entitlement_ids, 'invalid'::text;
      return;
    end if;
  end if;

  if v_coupon.kind = 'fixed' and v_coupon.currency <> v_order.currency then
    raise log 'apply_coupon_to_order: order % profile %: currency mismatch', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  select count(*) into v_used from public.coupon_redemptions r where r.coupon_id = v_coupon.id;
  if v_coupon.max_redemptions is not null and v_used >= v_coupon.max_redemptions then
    raise log 'apply_coupon_to_order: order % profile %: exhausted', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  select count(*) into v_used_by_profile
  from public.coupon_redemptions r where r.coupon_id = v_coupon.id and r.profile_id = v_profile_id;
  if v_used_by_profile >= v_coupon.max_redemptions_per_profile then
    raise log 'apply_coupon_to_order: order % profile %: per-profile limit reached', p_order_id, v_profile_id;
    perform public.record_coupon_failure(v_profile_id);
    return query select v_order.subtotal_minor, 0::bigint, v_order.subtotal_minor, v_order.status,
                        v_entitlement_ids, 'invalid'::text;
    return;
  end if;

  v_discount := case v_coupon.kind
    when 'percent' then (v_order.subtotal_minor * v_coupon.percent_off) / 100
    else v_coupon.amount_off_minor
  end;
  v_discount := least(greatest(v_discount, 0), v_order.subtotal_minor);
  v_total := v_order.subtotal_minor - v_discount;

  update public.orders o
  set coupon_id = v_coupon.id, coupon_code = v_coupon.code, discount_minor = v_discount, total_minor = v_total
  where o.id = p_order_id;

  insert into public.coupon_redemptions (coupon_id, order_id, profile_id, discount_minor, status)
  values (v_coupon.id, p_order_id, v_profile_id, v_discount, 'reserved');

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
  values (v_profile_id, 'coupon.applied', 'orders', p_order_id, null,
          jsonb_build_object('coupon_id', v_coupon.id, 'code', v_coupon.code,
                             'discount_minor', v_discount, 'total_minor', v_total));

  if v_total > 0 then
    update public.payments pay
    set amount_minor = v_total
    where pay.order_id = p_order_id and pay.status = 'pending';

    return query select v_order.subtotal_minor, v_discount, v_total, v_order.status,
                        v_entitlement_ids, null::text;
    return;
  end if;

  -- Zero total: the order completes here, in this transaction (S8 spec 4). There is nothing to pay,
  -- so the pending payment is cancelled rather than left waiting for an event that will never come.
  -- Its amount_minor is deliberately left where it was: a cancelled payment is a record of what
  -- WOULD have been charged, and rewriting it to zero would erase the only trace of the sum the
  -- reader was looking at when the code landed.
  update public.payments pay set status = 'cancelled' where pay.order_id = p_order_id and pay.status = 'pending';
  update public.orders o set status = 'completed', payment_status = 'not_required' where o.id = p_order_id;

  -- The gift branch, the same one apply_payment_event takes and through the same helper (spec
  -- 7.2): a fully discounted gift order makes the gift claimable and grants the buyer nothing.
  if not public.activate_order_gift(p_order_id) then
    -- One entitlement and one library item per book of the order - the same loop
    -- apply_payment_event runs. `distinct` because the grant is per subject and not per line, and
    -- the resolve-by-subject fallback keeps a book the reader already holds a no-op rather than a
    -- second grant or a constraint violation.
    for v_edition_id in
      select distinct s.edition_id from public.order_items oi join public.skus s on s.id = oi.sku_id where oi.order_id = p_order_id
    loop
      v_entitlement_id := public.press_grant_edition_access(v_profile_id, v_edition_id, 'free_order', p_order_id, null, null);
    end loop;

    -- Reported through the same helper apply_payment_event and confirm_manual_payment report it
    -- through, so "what does this buyer hold for this order" has one answer rather than three.
    v_entitlement_ids := public.order_active_entitlement_ids(p_order_id, v_profile_id);
  end if;

  -- ONE flip for the order, on both branches. A coupon is reserved against the order, and
  -- coupon_redemptions.order_id is unique, so this is one row however many books the order held.
  update public.coupon_redemptions r
  set status = 'redeemed', redeemed_at = now()
  where r.order_id = p_order_id;

  return query select v_order.subtotal_minor, v_discount, 0::bigint, 'completed'::public.order_status,
                      v_entitlement_ids, null::text;
end;
$function$
;


-- claim_gift: the recipient receives the exact editions on the gift's order, per edition.
create or replace function public.claim_gift(p_token text)
 RETURNS TABLE(book_id uuid, title text, entitlement_id uuid, already_owned boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- This function's OUT parameters are named after the columns it returns - book_id,
-- entitlement_id - and `on conflict (profile_id, book_id)` below has no alias to qualify with, so
-- the default "raise on ambiguity" rule would reject that statement outright. Every value this
-- body reads is a v_-prefixed local or an explicitly qualified column, and the four OUT names are
-- only ever assignment targets (which plpgsql always resolves as variables), so preferring the
-- column here is unambiguous rather than merely quieter.
#variable_conflict use_column
declare
  v_profile_id uuid;
  v_hash text;
  v_gift record;
  v_order record;
  v_source public.entitlement_source;
  v_item record;
  v_entitlement_id uuid;
  v_already boolean;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'claim_gift: no profile for the current session' using errcode = 'P0002';
  end if;

  -- The same expression lib/commerce/gift-token.ts hashGiftToken() produces: SHA-256 of the UTF-8
  -- bytes, lower-case hex. convert_to() rather than a bare cast, so the digest does not depend on
  -- the database's client encoding.
  v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');

  select g.* into v_gift from public.gifts g where g.claim_token_hash = v_hash for update;

  -- An unknown token and a spent one are the same refusal. Anything else would let a guesser tell
  -- a wrong token from a right-but-used one, which is most of the way to finding a live one.
  if v_gift.id is null then
    raise exception 'claim_gift: no claimable gift for this token' using errcode = 'EB029';
  end if;

  if v_gift.status = 'claimed' and v_gift.claimed_by_profile_id = v_profile_id then
    -- The same reader again - a refreshed page, a re-followed link. The same answer, and not one
    -- row written. already_owned is derived rather than remembered: an entitlement this claim
    -- created carries source_order_id = the gift's order, and one the reader already held cannot,
    -- because the buyer was granted nothing by that order. So the derivation below reproduces
    -- exactly what the first call reported.
    return query
    select i.book_id, i.title_snapshot, e.id, e.source_order_id is distinct from v_gift.order_id
    from (
      select distinct on (s.edition_id) s.edition_id, ed.book_id, oi.title_snapshot
      from public.order_items oi
      join public.skus s on s.id = oi.sku_id
      join public.editions ed on ed.id = s.edition_id
      where oi.order_id = v_gift.order_id
      order by s.edition_id, oi.position
    ) i
    join public.entitlements e
      on e.profile_id = v_profile_id and e.edition_id = i.edition_id and e.status = 'active'
    order by i.book_id, i.edition_id;
    return;
  end if;

  if v_gift.status <> 'sent' then
    raise exception 'claim_gift: no claimable gift for this token' using errcode = 'EB029';
  end if;

  select o.total_minor, o.payment_provider into v_order
  from public.orders o where o.id = v_gift.order_id;

  -- What the recipient's access is recorded as having come from. A gift order that cost nothing -
  -- a 100% coupon - is a free_order; otherwise it is the source of the provider the order was
  -- actually booked under, the same mapping apply_payment_event makes. The order paid for this
  -- access, so source_order_id always names it, whichever source applies.
  --
  -- Three sites in this file map an order to an entitlement_source, and they are consistent only
  -- by construction - change one and check the other two:
  --   * apply_payment_event's provider mapping (simulator/manual, no zero branch: a zero-total
  --     order never reaches it, because it never produces a payment event);
  --   * apply_coupon_to_order's zero-total branch, which completes the order in-transaction and
  --     grants a non-gift buyer 'free_order' - the only way a gift order reaches total_minor = 0,
  --     and therefore what the 'free_order' branch below has to agree with;
  --   * this mapping, which is the pair of them as seen from the recipient's side.
  v_source := case
    when v_order.total_minor = 0 then 'free_order'::public.entitlement_source
    when v_order.payment_provider = 'simulator' then 'simulated_payment'::public.entitlement_source
    when v_order.payment_provider = 'manual' then 'manual_payment'::public.entitlement_source
    when v_order.payment_provider = 'sepay' then 'sepay_payment'::public.entitlement_source
    else null
  end;
  if v_source is null then
    raise exception 'claim_gift: order % is booked under provider %, which grants nothing',
      v_gift.order_id, v_order.payment_provider using errcode = 'EB015';
  end if;

  -- `distinct on (book_id)` because access is per subject and not per line: a bundle order holding
  -- two lines for one book is one piece of access. Ordered by book_id so the claimed and the
  -- replayed result sets are the same set in the same order.
  for v_item in
    select distinct on (s.edition_id) s.edition_id, ed.book_id, oi.title_snapshot
    from public.order_items oi
    join public.skus s on s.id = oi.sku_id
    join public.editions ed on ed.id = s.edition_id
    where oi.order_id = v_gift.order_id
    order by s.edition_id, oi.position
  loop
    -- Captured BEFORE the grant: after it, "does this reader hold this edition" is true either way.
    select e.id into v_entitlement_id
    from public.entitlements e
    where e.profile_id = v_profile_id and e.edition_id = v_item.edition_id and e.status = 'active';
    v_already := v_entitlement_id is not null;

    -- The grant primitive is the arbiter of a race; it also links the library item.
    v_entitlement_id := public.press_grant_edition_access(v_profile_id, v_item.edition_id, v_source, v_gift.order_id, null, null);

    book_id := v_item.book_id;
    title := v_item.title_snapshot;
    entitlement_id := v_entitlement_id;
    already_owned := v_already;
    return next;
  end loop;

  update public.gifts g
  set status = 'claimed', claimed_by_profile_id = v_profile_id, claimed_at = now()
  where g.id = v_gift.id;

  -- The claim path existed so the message could be sent and re-sent while the gift was live. It is
  -- not live any more, so the one protected copy of it is dropped rather than left lying in a
  -- table for the rest of the row's life.
  update public.notification_outbox o set payload = null where o.gift_id = v_gift.id;
end;
$function$
;


-- ---------------------------------------------------------------------------------------------
-- 6. Transitional bridge, the other direction. Until the contract migration drops
-- books.active_publication_id, anything that still writes it (older code, scripts, fixtures) makes
-- that publication its edition's live one. The publishing RPCs move the edition pointer first and
-- this then finds it already in place, so on the real path it changes nothing.
create function public.books_mirror_active_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active_publication_id is not null
     and new.active_publication_id is distinct from old.active_publication_id then
    update public.editions e
    set active_publication_id = new.active_publication_id, status = 'published'
    from public.ebook_publications pub
    join public.ebook_assets a on a.id = pub.ebook_asset_id
    where pub.id = new.active_publication_id
      and a.edition_id = e.id
      and e.book_id = new.id
      and e.active_publication_id is distinct from new.active_publication_id;
  end if;
  return new;
end;
$$;
create trigger books_mirror_active_publication_bridge
  after update of active_publication_id on public.books
  for each row execute function public.books_mirror_active_publication();
