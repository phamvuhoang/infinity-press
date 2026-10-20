-- Infinity Books Press, Task 3: edition-scoped publication and access, expand phase.
--
-- Everything here is additive and nullable: nothing book-only stops working, and no new row is
-- required yet. Tasks 4-8 move the RPCs onto these columns; the contract migration (Task 10)
-- enforces NOT NULL and drops the book-only paths. press_edition_backfill() maps legacy rows from
-- evidence (the SKU on an order, the asset behind a publication) and refuses to guess.

-- Editions: lifecycle, the live publication, credits.
alter table public.editions
  add column status public.content_status not null default 'draft',
  add column active_publication_id uuid references public.ebook_publications (id),
  add column contributors jsonb not null default '[]'::jsonb check (jsonb_typeof(contributors) = 'array'),
  add column introduction text,
  add constraint editions_id_book_key unique (id, book_id),
  add constraint editions_id_book_language_key unique (id, book_id, language_code);

grant select (status, active_publication_id, contributors, introduction) on public.editions to anon, authenticated;

-- The pointer may only name a publication whose asset belongs to this edition. A composite foreign
-- key cannot say so (the asset is two hops away), so a trigger does; the publishing RPCs move the
-- pointer, no client role holds UPDATE on the column.
create function public.editions_check_active_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active_publication_id is not null and not exists (
    select 1
    from public.ebook_publications p
    join public.ebook_assets a on a.id = p.ebook_asset_id
    where p.id = new.active_publication_id and a.edition_id = new.id
  ) then
    raise exception 'edition % cannot point at publication % of another edition', new.id, new.active_publication_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger editions_active_publication_guard
  before insert or update of active_publication_id on public.editions
  for each row execute function public.editions_check_active_publication();

-- An edition that anyone has bought or owns keeps its book and language: a wrong entry after the
-- sale is fixed by creating a new edition (spec section 6).
create function public.editions_lock_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.book_id is distinct from old.book_id or new.language_code is distinct from old.language_code)
     and (exists (select 1 from public.entitlements where edition_id = old.id)
          or exists (select 1 from public.order_items where edition_id = old.id)) then
    raise exception 'edition % has orders or entitlements; its book and language cannot change', old.id
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger editions_lock_identity_guard
  before update of book_id, language_code on public.editions
  for each row execute function public.editions_lock_identity();

-- A work may override the platform default content language.
alter table public.books
  add column default_content_language text references public.content_languages (code);

-- The one edition a book offers by default in each language. Never "the first one found".
create table public.book_language_editions (
  book_id uuid not null,
  language_code text not null,
  edition_id uuid not null,
  primary key (book_id, language_code),
  foreign key (edition_id, book_id, language_code) references public.editions (id, book_id, language_code)
);

-- The offer shown for an edition. Its SKU must belong to the edition, the offer to the SKU.
alter table public.skus add constraint skus_id_edition_key unique (id, edition_id);
alter table public.offers add constraint offers_id_sku_key unique (id, sku_id);
create table public.edition_default_offers (
  edition_id uuid primary key references public.editions (id),
  sku_id uuid not null,
  offer_id uuid not null,
  foreign key (sku_id, edition_id) references public.skus (id, edition_id),
  foreign key (offer_id, sku_id) references public.offers (id, sku_id)
);

-- Access and money rows learn which edition they are about. The composite key makes the database
-- refuse an edition of a different book.
alter table public.entitlements
  add column edition_id uuid,
  add constraint entitlements_edition_book_fkey
    foreign key (edition_id, book_id) references public.editions (id, book_id);
create unique index entitlements_active_edition_key
  on public.entitlements (profile_id, edition_id)
  where status = 'active' and edition_id is not null;

alter table public.library_items
  add column edition_id uuid,
  add constraint library_items_edition_book_fkey
    foreign key (edition_id, book_id) references public.editions (id, book_id);
create unique index library_items_profile_edition_key
  on public.library_items (profile_id, edition_id)
  where edition_id is not null;

alter table public.order_items
  add column edition_id uuid,
  add column language_code text references public.content_languages (code),
  add column offer_id uuid references public.offers (id),
  add constraint order_items_edition_book_fkey
    foreign key (edition_id, book_id) references public.editions (id, book_id);

alter table public.book_reviews
  add column edition_id uuid,
  add constraint book_reviews_edition_book_fkey
    foreign key (edition_id, book_id) references public.editions (id, book_id);
create unique index book_reviews_edition_profile_key
  on public.book_reviews (edition_id, profile_id)
  where edition_id is not null;

-- Bundles contain fixed editions, not works resolved at checkout.
create table public.bundle_editions (
  bundle_id uuid not null references public.bundles (id) on delete cascade,
  edition_id uuid not null references public.editions (id),
  position integer not null check (position > 0),
  primary key (bundle_id, edition_id),
  unique (bundle_id, position)
);

-- Edition covers sit beside book covers; the edition falls back to the work's cover when it has none.
alter table public.media_assets drop constraint media_assets_owner_type_check;
alter table public.media_assets add constraint media_assets_owner_type_check
  check (owner_type = any (array['book', 'author', 'bundle', 'edition']));
create unique index media_assets_one_cover_per_edition
  on public.media_assets (owner_id)
  where owner_type = 'edition' and kind = 'cover';
create policy "public read cover media of published editions" on public.media_assets
  for select to anon, authenticated
  using (
    kind = 'cover' and owner_type = 'edition'
    and exists (
      select 1 from public.editions e join public.books b on b.id = e.book_id
      where e.id = media_assets.owner_id and b.status = 'published' and e.status = 'published'
    )
  );

alter table public.book_language_editions enable row level security;
alter table public.edition_default_offers enable row level security;
alter table public.bundle_editions enable row level security;
revoke all on public.book_language_editions, public.edition_default_offers, public.bundle_editions
  from anon, authenticated;
grant select on public.book_language_editions, public.edition_default_offers, public.bundle_editions
  to anon, authenticated;

create policy "admin reads default editions" on public.book_language_editions
  for select to authenticated using ((select public.is_admin()));
create policy "public reads default editions of published books" on public.book_language_editions
  for select to anon, authenticated
  using (exists (select 1 from public.books b where b.id = book_language_editions.book_id and b.status = 'published'));
create policy "admin reads default offers" on public.edition_default_offers
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads bundle editions" on public.bundle_editions
  for select to authenticated using ((select public.is_admin()));
create policy "public reads editions of published bundles" on public.bundle_editions
  for select to anon, authenticated
  using (exists (select 1 from public.bundles b where b.id = bundle_editions.bundle_id and b.status = 'published'));

-- Legacy -> edition backfill. Returns a report; with p_apply it also writes, all or nothing.
--
--   * A dry run (p_apply = false) does the work, reports, then rolls it back.
--   * Any row it cannot map from evidence is listed by id (never PII) and blocks the run: no
--     partial application, and never an extra language granted to keep something working.
--
-- Evidence used, in order: the SKU on the order behind an entitlement; the only edition of a
-- single-edition book; the editions a reviewer already owns. Revoked and expired rows map too:
-- history is not allowed to lose its edition.
create function public.press_edition_backfill(p_apply boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_ambiguous jsonb;
  v_report jsonb;
  v_n integer;
  v_has_ambiguity boolean;
  v_message text;
begin
  begin
    -- 1. The live publication moves from the book to the edition that owns its asset.
    update public.editions e
    set active_publication_id = b.active_publication_id
    from public.books b
    join public.ebook_publications p on p.id = b.active_publication_id
    join public.ebook_assets a on a.id = p.ebook_asset_id
    where e.id = a.edition_id and e.book_id = b.id and e.active_publication_id is null;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('pointers', v_n);

    -- 2. Status follows the evidence: a live publication takes the book's status, nothing else is live.
    update public.editions e
    set status = b.status
    from public.books b
    where b.id = e.book_id and e.active_publication_id is not null and e.status <> b.status;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('statuses', v_n);

    -- 3. One default edition per book and language where the evidence is unambiguous.
    insert into public.book_language_editions (book_id, language_code, edition_id)
    select g.book_id, g.language_code, g.edition_id
    from (
      select e.book_id, e.language_code,
             case
               when count(*) = 1 then (array_agg(e.id))[1]
               when count(*) filter (where e.active_publication_id is not null) = 1
                 then (array_agg(e.id) filter (where e.active_publication_id is not null))[1]
             end as edition_id
      from public.editions e
      group by e.book_id, e.language_code
    ) g
    where g.edition_id is not null
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('language_defaults', v_n);

    -- 4. A default offer only where exactly one active offer exists.
    insert into public.edition_default_offers (edition_id, sku_id, offer_id)
    select s.edition_id, s.id, o.id
    from public.skus s
    join public.offers o on o.sku_id = s.id and o.active
    where not exists (select 1 from public.edition_default_offers d where d.edition_id = s.edition_id)
      and (select count(*) from public.skus s2 join public.offers o2 on o2.sku_id = s2.id and o2.active
           where s2.edition_id = s.edition_id) = 1;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('default_offers', v_n);

    -- 5. Order items take the SKU's edition and language.
    update public.order_items oi
    set edition_id = s.edition_id, language_code = e.language_code
    from public.skus s
    join public.editions e on e.id = s.edition_id
    where s.id = oi.sku_id and oi.edition_id is null and e.book_id = oi.book_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('order_items', v_n);

    -- 6. Entitlements: the edition on the order, else the only edition of the book.
    update public.entitlements en
    set edition_id = r.edition_id
    from (
      select ent.id,
             case
               when cardinality(ev.order_editions) = 1 then ev.order_editions[1]
               when cardinality(ev.order_editions) = 0 and sb.edition_id is not null then sb.edition_id
             end as edition_id
      from public.entitlements ent
      cross join lateral (
        select coalesce(array_agg(distinct s.edition_id), '{}'::uuid[]) as order_editions
        from public.order_items oi
        join public.skus s on s.id = oi.sku_id
        join public.editions e on e.id = s.edition_id and e.book_id = ent.book_id
        where oi.order_id = ent.source_order_id and oi.book_id = ent.book_id
      ) ev
      left join lateral (
        select (array_agg(e.id))[1] as edition_id
        from public.editions e where e.book_id = ent.book_id
        having count(*) = 1
      ) sb on true
      where ent.edition_id is null
    ) r
    where en.id = r.id and r.edition_id is not null;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('entitlements', v_n);

    -- 7. Library items follow their entitlement.
    update public.library_items li
    set edition_id = en.edition_id
    from public.entitlements en
    where en.id = li.entitlement_id and li.edition_id is null and en.edition_id is not null
      and en.book_id = li.book_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('library_items', v_n);

    -- 8. Reviews: the one edition the reviewer owns, else the only edition of the book.
    update public.book_reviews rv
    set edition_id = r.edition_id
    from (
      select x.id,
             case
               when cardinality(own.editions) = 1 then own.editions[1]
               when cardinality(own.editions) = 0 and sb.edition_id is not null then sb.edition_id
             end as edition_id
      from public.book_reviews x
      cross join lateral (
        select coalesce(array_agg(distinct en.edition_id), '{}'::uuid[]) as editions
        from public.entitlements en
        where en.profile_id = x.profile_id and en.book_id = x.book_id and en.edition_id is not null
      ) own
      left join lateral (
        select (array_agg(e.id))[1] as edition_id
        from public.editions e where e.book_id = x.book_id
        having count(*) = 1
      ) sb on true
      where x.edition_id is null
    ) r
    where rv.id = r.id and r.edition_id is not null;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('reviews', v_n);

    -- 9. Bundle membership: the only edition of a single-edition book.
    insert into public.bundle_editions (bundle_id, edition_id, position)
    select bb.bundle_id, (array_agg(e.id))[1], bb.position
    from public.bundle_books bb
    join public.editions e on e.book_id = bb.book_id
    where not exists (
      select 1 from public.bundle_editions be
      join public.editions e2 on e2.id = be.edition_id
      where be.bundle_id = bb.bundle_id and e2.book_id = bb.book_id)
    group by bb.bundle_id, bb.book_id, bb.position
    having count(*) = 1;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object('bundle_editions', v_n);

    -- What could not be mapped, by id only.
    v_ambiguous := jsonb_build_object(
      'entitlements', coalesce((select jsonb_agg(id order by id) from public.entitlements where edition_id is null), '[]'::jsonb),
      'library_items', coalesce((select jsonb_agg(id order by id) from public.library_items where edition_id is null), '[]'::jsonb),
      'reviews', coalesce((select jsonb_agg(id order by id) from public.book_reviews where edition_id is null), '[]'::jsonb),
      'bundle_books', coalesce((
        select jsonb_agg(bb.bundle_id::text || '/' || bb.book_id::text order by bb.bundle_id, bb.book_id)
        from public.bundle_books bb
        where not exists (
          select 1 from public.bundle_editions be
          join public.editions e on e.id = be.edition_id
          where be.bundle_id = bb.bundle_id and e.book_id = bb.book_id)), '[]'::jsonb),
      'order_items', coalesce((select jsonb_agg(id order by id) from public.order_items where edition_id is null), '[]'::jsonb),
      'language_defaults', coalesce((
        select jsonb_agg(e.book_id::text || '/' || e.language_code order by e.book_id, e.language_code)
        from public.editions e
        group by e.book_id, e.language_code
        having not exists (
          select 1 from public.book_language_editions d
          where d.book_id = e.book_id and d.language_code = e.language_code)), '[]'::jsonb),
      'pointers', coalesce((
        select jsonb_agg(b.id order by b.id)
        from public.books b
        where b.active_publication_id is not null
          and not exists (
            select 1 from public.editions e
            where e.book_id = b.id and e.active_publication_id = b.active_publication_id)), '[]'::jsonb)
    );
    select bool_or(jsonb_array_length(value) > 0) into v_has_ambiguity from jsonb_each(v_ambiguous);

    v_report := jsonb_build_object(
      'applied', p_apply and not v_has_ambiguity,
      'counts', v_counts,
      'ambiguous', v_ambiguous
    );

    -- Roll the work back unless it is a clean, requested apply: the sentinel unwinds the subtransaction.
    if not p_apply or v_has_ambiguity then
      raise exception '%', v_report::text using errcode = 'EB0F1';
    end if;
  exception when sqlstate 'EB0F1' then
    get stacked diagnostics v_message = message_text;
    v_report := v_message::jsonb;
  end;

  if v_has_ambiguity and p_apply then
    raise exception 'press_edition_backfill: legacy rows cannot be mapped to one edition; nothing was changed'
      using errcode = '55000', detail = v_ambiguous::text;
  end if;
  return v_report;
end;
$$;
revoke all on function public.press_edition_backfill(boolean) from public, anon, authenticated;
grant execute on function public.press_edition_backfill(boolean) to service_role;

-- On a fresh Press database this is a no-op; on an upgraded one it either maps every legacy row or
-- stops the migration with the offending ids, which is the cutover block the plan calls for.
select public.press_edition_backfill(true);
