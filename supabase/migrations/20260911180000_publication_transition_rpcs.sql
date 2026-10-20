-- Task 6: the three admin transition RPCs - publish_publication, reject_publication,
-- rollback_publication - plus the is_admin()-gated admin-read policies the publishing tables
-- have lacked since Task 2 (that task's admin-read policies covered only the six catalog
-- tables; see 20260911120000_admin_create_ebook.sql's Ruling AP comment, which explicitly left
-- this gap for whichever later task needed it).
--
-- Renumbering note: named 20260911180000, not the brief's 20260911140000 - that timestamp sorts
-- BEFORE 20260911170000_processing_job_rpcs.sql despite landing one task later. Same hosted-
-- project hazard Ruling P and Ruling AV both closed already: a migration timestamped earlier
-- than one already applied is never picked up by a hosted project applying migrations
-- incrementally as they land.

-- Ruling AP-style admin reads: an admin needs to see a book's full publishing history - queued/
-- processing/failed assets, every publication a book has ever had (not just its currently active
-- one), and the derived resources listed for each - none of which the six catalog tables' or any
-- existing policy already covers for these four tables. Same `(select public.is_admin())`
-- InitPlan-friendly idiom as every other admin-read policy in this schema.
--
-- book_samples is deliberately excluded here (fix round 1, Important #1): nothing in this task,
-- or anywhere in the repository yet, reads book_samples - Ruling BK's "admins acquired a browser
-- read purpose" justification for the grant expansion never actually applied to this table, so
-- granting and policying it now would be a privilege expansion with no consumer and no
-- non-vacuous test to cover it. Task 8's sample handlers add both alongside the code that needs
-- them.
--
-- Unlike Ruling AP's catalog-table policies, this DOES need a grant change: Task 2's original
-- migration revoked table-level SELECT on all five publishing tables (book_samples included) from
-- anon AND authenticated (20260911090000_mvp_catalog_publishing.sql:259-268), since nothing before
-- this task ever needed an authenticated session to read them. A row-level policy cannot override
-- a missing table-level privilege - Postgres checks the grant before RLS ever runs - so omitting
-- this (copying Ruling AP's "no grant changes needed" verbatim) would leave every query below
-- failing with "permission denied for table", not an empty result set.
grant select on
  public.ebook_assets,
  public.processing_jobs,
  public.ebook_publications,
  public.ebook_resources
to authenticated;

create policy "admin reads ebook assets" on public.ebook_assets
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads processing jobs" on public.processing_jobs
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads ebook publications" on public.ebook_publications
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads ebook resources" on public.ebook_resources
  for select to authenticated using ((select public.is_admin()));

-- Lock ordering, held consistently across all three functions below to avoid a deadlock between
-- concurrent admin actions: public.books is always locked (`for update`) before
-- public.ebook_publications. publish_publication has to discover which book a given publication
-- belongs to before it can lock anything - it does this with a plain, unlocked read first, which
-- is safe because the chain ebook_publications.ebook_asset_id -> ebook_assets.edition_id ->
-- editions.book_id is immutable (nothing in this codebase ever updates any of those three
-- columns), so re-deriving and re-checking status after the books lock is acquired is exactly as
-- authoritative as locking the publication first would have been.

-- publish_publication(): approves a `ready_for_preview` candidate. Supersedes whichever
-- publication was previously active for the *same* book (derived from the candidate's own
-- asset/edition chain, never a caller-supplied book id - so there is no book-id parameter for a
-- caller to get wrong in the first place; Ruling AN's cross-book hazard is closed by
-- construction here, not by an extra check), then moves the active pointer. All of it - the
-- supersede, the status flip, the pointer move, and the audit row - happens in one statement
-- PostgREST wraps per call, so a failure partway through leaves neither a dangling superseded
-- publication nor a book pointed at a publication that isn't actually 'published'.
create function public.publish_publication(p_publication_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_id uuid;
  v_asset_id uuid;
  v_status public.publication_status;
  v_previous_active_id uuid;
  v_previous_asset_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'publish_publication: caller is not an admin' using errcode = '42501';
  end if;

  select e.book_id into v_book_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where p.id = p_publication_id;

  if v_book_id is null then
    raise exception 'publish_publication: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;

  -- Lock the book row before the publication row, matching rollback_publication's order below.
  select active_publication_id into v_previous_active_id
  from public.books
  where id = v_book_id
  for update;

  -- Re-read the publication's authoritative status now that the book row is locked - this also
  -- locks the publication and its asset, closing the window between the unlocked lookup above
  -- and this point.
  select p.status, a.id into v_status, v_asset_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  where p.id = p_publication_id
  for update of p, a;

  if v_status <> 'ready_for_preview' then
    raise exception 'publish_publication: publication % is % and cannot be published', p_publication_id, v_status
      using errcode = 'EB002';
  end if;

  if v_previous_active_id is not null then
    -- Fix round 1, Ruling AN's own premise applied to this pointer too: books.active_publication_id
    -- is a deferrable FK that only proves the id exists *somewhere*, never that it belongs to this
    -- book. Re-derive ownership through the same p -> a -> e chain used for the target publication
    -- above before writing to it - unreachable today (this RPC and rollback_publication are the
    -- only writers, and both always set a same-book id), but if that pointer ever named a foreign
    -- publication, this must not supersede another book's rows. A mismatch resolves no row here,
    -- so the block below silently skips the supersede rather than acting on it.
    select p.ebook_asset_id into v_previous_asset_id
    from public.ebook_publications p
    join public.ebook_assets a on a.id = p.ebook_asset_id
    join public.editions e on e.id = a.edition_id
    where p.id = v_previous_active_id
      and e.book_id = v_book_id;

    if v_previous_asset_id is not null then
      update public.ebook_publications set status = 'superseded' where id = v_previous_active_id;
      update public.ebook_assets set status = 'superseded' where id = v_previous_asset_id;
    end if;
  end if;

  update public.ebook_publications set status = 'published' where id = p_publication_id;
  update public.ebook_assets set status = 'published' where id = v_asset_id;
  -- Fix round 1, Ruling BL: publishing must make the book itself publicly visible, not just move
  -- the active-publication pointer. Every public catalog RLS policy
  -- (20260911090000_mvp_catalog_publishing.sql) gates on books.status = 'published'; nothing
  -- before this task ever wrote that column (admin_create_ebook inserts at the 'draft' default),
  -- so without this the storefront would stay permanently dark even after a successful publish.
  update public.books set active_publication_id = p_publication_id, status = 'published', updated_at = now() where id = v_book_id;
  -- Ruling BO: the same shape as Ruling BL above, one table over. books.primary_author_id is a
  -- `not null` FK (20260911090000:23) and anon read of an author is gated on the author's OWN
  -- status ("public read published authors", 20260911090000:183-186), but nothing in the
  -- repository ever wrote authors.status - admin_create_ebook inserts the author at the 'draft'
  -- default (20260911120000:53). Without this, a successful publish yields a published book whose
  -- author row is invisible to anonymous visitors: a book with no byline. Publishing the book and
  -- publishing its primary author are one semantic act, so they belong in one transaction. The
  -- book row is already locked above, so primary_author_id is stable here.
  update public.authors
     set status = 'published', updated_at = now()
   where id = (select primary_author_id from public.books where id = v_book_id);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (
    v_actor_profile_id,
    'publish_publication',
    'ebook_publications',
    p_publication_id,
    jsonb_build_object('book_id', v_book_id, 'previous_active_publication_id', v_previous_active_id)
  );
end;
$$;

-- Ruling R: EXECUTE goes to authenticated only - this is an admin mutation from a browser
-- session, and is_admin() resolves through auth.uid(), null under service_role (Ruling W's trap).
revoke execute on function public.publish_publication(uuid) from public, anon;
grant execute on function public.publish_publication(uuid) to authenticated;

-- reject_publication(): declines a `ready_for_preview` candidate instead of publishing it. Never
-- touches books.active_publication_id - a rejected candidate was never active, so there is
-- nothing to supersede or repoint.
create function public.reject_publication(p_publication_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.publication_status;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'reject_publication: caller is not an admin' using errcode = '42501';
  end if;

  -- Fix round 1, Minor #8: a dedicated EB004 rather than the generic 22023
  -- (invalid_parameter_value), which other statements in this function could plausibly raise too -
  -- publications.ts's error mapping needs a code that can only ever mean "no reason was given".
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reject_publication: a reason is required' using errcode = 'EB004';
  end if;

  select status into v_status
  from public.ebook_publications
  where id = p_publication_id
  for update;

  if v_status is null then
    raise exception 'reject_publication: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;

  if v_status <> 'ready_for_preview' then
    raise exception 'reject_publication: publication % is % and cannot be rejected', p_publication_id, v_status
      using errcode = 'EB002';
  end if;

  update public.ebook_publications set status = 'rejected' where id = p_publication_id;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason)
  values (v_actor_profile_id, 'reject_publication', 'ebook_publications', p_publication_id, p_reason);
end;
$$;

revoke execute on function public.reject_publication(uuid, text) from public, anon;
grant execute on function public.reject_publication(uuid, text) to authenticated;

-- rollback_publication(): reactivates a previously published (now `superseded`) version of one
-- book. Unlike publish_publication, the caller supplies the book id explicitly (matching the
-- brief's `rollbackPublication(bookId, publicationId)`), which is exactly the shape Ruling AN
-- warns about: nothing before this RPC stops an admin (or a compromised admin session) from
-- naming a publication id that belongs to an entirely different book. This function closes that
-- by deriving the publication's *actual* book from its own asset/edition chain and comparing it
-- against p_book_id, inside the same transaction that holds both rows locked - not by trusting
-- that a well-formed caller would never do this.
create function public.rollback_publication(p_book_id uuid, p_publication_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actual_book_id uuid;
  v_asset_id uuid;
  v_status public.publication_status;
  v_current_active_id uuid;
  v_current_active_asset_id uuid;
  v_actor_profile_id uuid;
begin
  if not public.is_admin() then
    raise exception 'rollback_publication: caller is not an admin' using errcode = '42501';
  end if;

  -- Lock the book row first, before touching ebook_publications - same order as
  -- publish_publication, so the two can never deadlock against each other.
  select active_publication_id into v_current_active_id
  from public.books
  where id = p_book_id
  for update;

  if not found then
    raise exception 'rollback_publication: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  select e.book_id, p.status, a.id
  into v_actual_book_id, v_status, v_asset_id
  from public.ebook_publications p
  join public.ebook_assets a on a.id = p.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where p.id = p_publication_id
  for update of p, a;

  if v_actual_book_id is null then
    raise exception 'rollback_publication: publication % does not exist', p_publication_id using errcode = 'P0002';
  end if;

  -- Ruling AN's binding case: proven, not assumed. A publication that exists but belongs to a
  -- different book is rejected here before active_publication_id (or any status) is touched -
  -- the deferrable FK on books.active_publication_id only proves the id exists *somewhere*, it
  -- says nothing about which book it belongs to.
  if v_actual_book_id <> p_book_id then
    raise exception 'rollback_publication: publication % does not belong to book %', p_publication_id, p_book_id
      using errcode = 'EB003';
  end if;

  if v_status <> 'superseded' then
    raise exception 'rollback_publication: publication % is % and is not eligible for rollback', p_publication_id, v_status
      using errcode = 'EB002';
  end if;

  if v_current_active_id is not null and v_current_active_id <> p_publication_id then
    -- Fix round 1, Ruling AN's own premise applied to this pointer too: same hazard, same fix, as
    -- publish_publication's previous-active supersede above - re-derive ownership through the
    -- p -> a -> e chain rather than trusting the pointer before writing to whatever it names.
    select p.ebook_asset_id into v_current_active_asset_id
    from public.ebook_publications p
    join public.ebook_assets a on a.id = p.ebook_asset_id
    join public.editions e on e.id = a.edition_id
    where p.id = v_current_active_id
      and e.book_id = p_book_id;

    if v_current_active_asset_id is not null then
      update public.ebook_publications set status = 'superseded' where id = v_current_active_id;
      update public.ebook_assets set status = 'superseded' where id = v_current_active_asset_id;
    end if;
  end if;

  update public.ebook_publications set status = 'published' where id = p_publication_id;
  update public.ebook_assets set status = 'published' where id = v_asset_id;
  -- Fix round 1, Ruling BL: rollback reactivates a version of a book that was necessarily already
  -- 'published' (only publish_publication ever sets books.active_publication_id in the first
  -- place, and it always sets status alongside it), so this is a no-op in practice - written
  -- explicitly rather than left implicit, so the invariant "rollback leaves the book published" is
  -- provable from this statement, not merely true by omission.
  update public.books set active_publication_id = p_publication_id, status = 'published', updated_at = now() where id = p_book_id;
  -- Ruling BO, same reasoning as publish_publication above. The invariant this holds is "a book
  -- with status = 'published' always has a published primary author", and this statement writes
  -- books.status = 'published' unconditionally - so it must maintain the author half of that
  -- invariant unconditionally too, or the invariant is only true on the publish path. Like the
  -- books update it sits next to, this is a no-op in practice today (rollback only ever
  -- reactivates a version of a book that publish_publication already published, and that path
  -- published the author), written explicitly so the invariant is provable from this statement
  -- rather than inferred from the history of how the row got here. reject_publication is
  -- deliberately left untouched: rejecting a pending candidate must not change an already-live
  -- book, and by the same token must not change its already-live author.
  update public.authors
     set status = 'published', updated_at = now()
   where id = (select primary_author_id from public.books where id = p_book_id);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (
    v_actor_profile_id,
    'rollback_publication',
    'ebook_publications',
    p_publication_id,
    jsonb_build_object('book_id', p_book_id, 'previous_active_publication_id', v_current_active_id)
  );
end;
$$;

revoke execute on function public.rollback_publication(uuid, uuid) from public, anon;
grant execute on function public.rollback_publication(uuid, uuid) to authenticated;
