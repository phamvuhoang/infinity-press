-- S11: editorial pins and the deterministic recommendation RPC
-- (docs/superpowers/sdd/2026-09-22-s11-recommendation-shelves).
--
-- Two objects and one rule between them. related_books is the editor's override: an ordered list
-- of books to show alongside a given book, written only through admin_set_related_books.
-- recommend_books is what every shelf on the site calls - the library, a topic page, an author
-- page - and it merges those pins with three computed signals into one ordered result.
--
-- The decisions worth stating, because later work builds on them:
--
--   * The relation is DIRECTED. Pinning B under A says nothing about what belongs under B. An
--     editor curating "read this after A" is not making a claim about B's own shelf, and a
--     symmetric table would silently publish one. (book_id, related_book_id) is the primary key
--     and unique (book_id, position) makes the order within one book's shelf total.
--   * The order is a total order, deterministic for a given database state. Two calls with the
--     same arguments return the same rows in the same positions, down to the last tie, because a
--     shelf that reshuffles between a server render and a revalidation looks broken. book_id is
--     the final tie-break for exactly that reason - it is arbitrary, but it is stable.
--   * recommend_books decides eligibility itself rather than trusting the caller's RLS. It is a
--     security definer function and it filters books.status, the ACTIVE publication's status and
--     the requested localization explicitly, so an anonymous caller and an admin caller get the
--     same answer: only books a reader could actually open. A pin is an ordering override, never
--     an eligibility override - an editor cannot pin a draft book onto a public shelf.
--   * The weights are named constants in one place. They are a product decision that will be
--     retuned, and the pgTAP file asserts the resulting scores literally, so a change to either
--     has to be a change to both.

-- The pin table ------------------------------------------------------------------------------

create table public.related_books (
  book_id uuid not null references public.books(id) on delete cascade,
  related_book_id uuid not null references public.books(id) on delete cascade,
  position integer not null check (position > 0),
  primary key (book_id, related_book_id),
  unique (book_id, position),
  check (book_id <> related_book_id)
);

alter table public.related_books enable row level security;

-- Privileges first, because a policy cannot weaken them. No browser role writes this table at
-- all, admin or not: admin_set_related_books below is the only write path, and it is where the
-- contiguous-positions and no-self-pin invariants and the audit row live. `authenticated` keeps
-- SELECT so the admin editor can read the current pins back under the policy; `anon` gets
-- nothing, because pins reach the public only through recommend_books, which runs as its owner.
revoke all on public.related_books from public, anon, authenticated, service_role;
grant select on public.related_books to authenticated;
grant select, insert, update, delete on public.related_books to service_role;

create policy "admin reads related books" on public.related_books
  for select to authenticated using ((select public.is_admin()));

-- The audited writer -------------------------------------------------------------------------

-- The editor posts the complete ordered list and this replaces the shelf with it. Positions come
-- from `with ordinality`, so they are contiguous from 1 and agree with the submitted order by
-- construction - the same reason admin_set_bundle_members (20260924120000) does it this way,
-- rather than per-row position updates that can transiently violate unique (book_id, position).
--
-- An empty (or null) array is a legitimate save: it clears the shelf. Unlike a bundle, which is
-- meaningless without members, a book with no editorial pins simply falls back to the computed
-- signals, so refusing the empty case would leave an editor no way to undo a pin.
create function public.admin_set_related_books(p_book_id uuid, p_related_book_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_related_book_ids uuid[] := coalesce(p_related_book_ids, array[]::uuid[]);
  v_actor_profile_id uuid;
  v_missing_book_id uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_related_books: caller is not an admin' using errcode = '42501';
  end if;

  -- Lock the shelf's owner before validating, so two editors saving the same book serialise and
  -- the second one's delete/insert cannot interleave with the first one's.
  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'admin_set_related_books: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  -- Rejected BEFORE the delete, so a bad payload leaves the existing shelf exactly as it was
  -- rather than clearing it and failing on the insert. The table's check constraint would catch
  -- a self-pin too, but only after the old rows were already gone.
  -- Checked before everything else that reads the array, because `null = any (...)` is null and
  -- `count(distinct ...) <> cardinality(...)` is true for a null element: without this guard a
  -- null id would be rejected by the duplicate check, under a message that names the wrong fault.
  if array_position(v_related_book_ids, null) is not null then
    raise exception 'admin_set_related_books: a pin list cannot contain a null book id'
      using errcode = '22023';
  end if;
  if p_book_id = any (v_related_book_ids) then
    raise exception 'admin_set_related_books: a book cannot be pinned under itself'
      using errcode = '22023';
  end if;
  -- Silently deduplicating would drop a book the operator believes they added, and the primary
  -- key would refuse the second copy anyway; saying so names the mistake.
  if (select count(distinct m.related_book_id) from unnest(v_related_book_ids) as m(related_book_id))
       <> cardinality(v_related_book_ids) then
    raise exception 'admin_set_related_books: a book can be pinned only once under the same book'
      using errcode = '22023';
  end if;

  -- The column alias is load-bearing: `unnest(...) as id` would make the bare id in the inner
  -- subquery resolve to books.id, and the check would never find a missing book.
  select m.related_book_id into v_missing_book_id
  from unnest(v_related_book_ids) as m(related_book_id)
  where not exists (select 1 from public.books b where b.id = m.related_book_id)
  limit 1;
  if v_missing_book_id is not null then
    raise exception 'admin_set_related_books: book % does not exist', v_missing_book_id
      using errcode = 'P0002';
  end if;

  delete from public.related_books where book_id = p_book_id;
  insert into public.related_books (book_id, related_book_id, position)
  select p_book_id, m.related_book_id, m.ord
  from unnest(v_related_book_ids) with ordinality as m(related_book_id, ord);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_related_books', 'books', p_book_id,
          jsonb_build_object('related_book_ids', v_related_book_ids));
end;
$$;

-- The scoring RPC ------------------------------------------------------------------------------

-- Seeds are the books the shelf is "about": the one book on a book page, or the reader's library.
-- p_exclude_book_ids is what the caller already shows elsewhere on the page. The seeds themselves
-- are always excluded - recommending a book you are already looking at is never useful.
--
-- PL/pgSQL rather than plain SQL purely so the three weights are named constants at the top
-- instead of magic numbers buried in a CASE.
--
-- Series, author and bundle are worth their weight at most ONCE per candidate however many seeds
-- match, because "same series as two of your books" is not twice the signal that "same series" is.
-- Topics accumulate once per DISTINCT shared topic, so a candidate sharing two topics outranks
-- one sharing a single topic, but sharing one topic with five seeds does not score five times.
--
-- Every grouping that earns a weight - series, topic, bundle - is joined through its own table so
-- that only a 'published' grouping can score. The public catalog reads already hide a draft or
-- archived topic/series (20260915100000 joins them with status = 'published'), so scoring one here
-- would surface a "related book" whose stated relationship appears nowhere on the site. Seeds are
-- filtered the same way: a caller may pass any id, and an unpublished seed must not leak its
-- series, author, topic or bundle through the shape of the results.
create function public.recommend_books(
  p_seed_book_ids uuid[],
  p_exclude_book_ids uuid[],
  p_locale text,
  p_limit integer
)
returns table (book_id uuid, score integer, pinned boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_series_weight constant integer := 100;
  v_author_weight constant integer := 50;
  v_topic_weight constant integer := 10;
  v_bundle_weight constant integer := 5;
begin
  return query
  with requested_seed_ids as (
    select distinct id from unnest(coalesce(p_seed_book_ids, array[]::uuid[])) as ids(id)
  ),
  seed_ids as (
    select r.id
    from requested_seed_ids r
    join public.books b on b.id = r.id and b.status = 'published'
  ),
  excluded_ids as (
    select id from requested_seed_ids
    union
    select distinct id from unnest(coalesce(p_exclude_book_ids, array[]::uuid[])) as ids(id)
  ),
  seed_series as (
    select distinct bs.series_id
    from public.book_series bs
    join public.series sr on sr.id = bs.series_id and sr.status = 'published'
    join seed_ids s on s.id = bs.book_id
  ),
  seed_authors as (
    select distinct b.primary_author_id
    from public.books b
    join seed_ids s on s.id = b.id
  ),
  seed_topics as (
    select distinct bt.topic_id
    from public.book_topics bt
    join public.topics t on t.id = bt.topic_id and t.status = 'published'
    join seed_ids s on s.id = bt.book_id
  ),
  seed_bundles as (
    select distinct bb.bundle_id
    from public.bundle_books bb
    join public.bundles bu on bu.id = bb.bundle_id and bu.status = 'published'
    join seed_ids s on s.id = bb.book_id
  ),
  -- One row per pinned candidate carrying the SMALLEST position it holds across every seed. With
  -- several seeds the same book can be pinned in more than one place; the editor's strongest
  -- placement is the one that should decide where it lands.
  seed_pins as (
    select rb.related_book_id, min(rb.position) as pin_position
    from public.related_books rb
    join seed_ids s on s.id = rb.book_id
    group by rb.related_book_id
  ),
  -- The eligibility gate, evaluated here rather than left to the caller's RLS: published book,
  -- an ACTIVE publication (books.active_publication_id) whose own status is 'published', and a
  -- localization for the requested locale. The edition reached through the active publication is
  -- also where the ordering date comes from; a book whose edition has no publication_date falls
  -- back to when the book row was created, so the date is never null and never an ordering hole.
  -- The fallback is normalized to UTC before the cast: timestamptz::date otherwise resolves in
  -- the session's TimeZone, which would let two sessions with different settings order tied
  -- candidates differently even though nothing about the underlying data changed.
  eligible_candidates as (
    select
      b.id as candidate_id,
      b.primary_author_id,
      coalesce(ed.publication_date, (b.created_at at time zone 'UTC')::date) as publication_date
    from public.books b
    join public.ebook_publications pub on pub.id = b.active_publication_id
    join public.ebook_assets ea on ea.id = pub.ebook_asset_id
    join public.editions ed on ed.id = ea.edition_id
    where b.status = 'published'
      and pub.status = 'published'
      and exists (
        select 1 from public.book_localizations bl
        where bl.book_id = b.id and bl.locale = p_locale
      )
      and not exists (select 1 from excluded_ids x where x.id = b.id)
  ),
  ranked as (
    select
      c.candidate_id,
      c.publication_date,
      p.pin_position,
      (
        (case when exists (
          select 1 from public.book_series bs
          join public.series sr on sr.id = bs.series_id and sr.status = 'published'
          join seed_series ss on ss.series_id = bs.series_id
          where bs.book_id = c.candidate_id
        ) then v_series_weight else 0 end)
        + (case when exists (
          select 1 from seed_authors sa where sa.primary_author_id = c.primary_author_id
        ) then v_author_weight else 0 end)
        + (
          select count(distinct bt.topic_id) from public.book_topics bt
          join public.topics t on t.id = bt.topic_id and t.status = 'published'
          join seed_topics st on st.topic_id = bt.topic_id
          where bt.book_id = c.candidate_id
        ) * v_topic_weight
        + (case when exists (
          select 1 from public.bundle_books bb
          join public.bundles bu on bu.id = bb.bundle_id and bu.status = 'published'
          join seed_bundles sb on sb.bundle_id = bb.bundle_id
          where bb.book_id = c.candidate_id
        ) then v_bundle_weight else 0 end)
      )::integer as candidate_score
    from eligible_candidates c
    left join seed_pins p on p.related_book_id = c.candidate_id
  )
  -- A pin is an ordering override, so a pinned book is returned even when it shares no signal at
  -- all and scores 0. An unpinned book that shares nothing is not a recommendation.
  select r.candidate_id, r.candidate_score, r.pin_position is not null
  from ranked r
  where r.pin_position is not null or r.candidate_score > 0
  order by (r.pin_position is not null) desc,
           r.pin_position asc nulls last,
           r.candidate_score desc,
           r.publication_date desc,
           r.candidate_id
  -- A null or negative limit asks for nothing and gets nothing rather than an error, because a
  -- shelf with no room is a rendering decision, not a bug. The upper clamp keeps a caller from
  -- turning a shelf query into a full catalog scan.
  limit greatest(0, least(coalesce(p_limit, 0), 100));
end;
$$;

-- Grants ---------------------------------------------------------------------------------------

revoke execute on function public.admin_set_related_books(uuid, uuid[]) from public, anon;
grant execute on function public.admin_set_related_books(uuid, uuid[]) to authenticated;

revoke execute on function public.recommend_books(uuid[], uuid[], text, integer) from public;
grant execute on function public.recommend_books(uuid[], uuid[], text, integer) to anon, authenticated;
