-- Press edition bundles (Task 7).
--
-- A bundle holds EDITIONS, not works: "Classic EN" and "Classic JA" are two bundles, and an English +
-- Japanese bundle of one work is a deliberate product. Nothing resolves a work to a language at
-- checkout. The order line is the snapshot: it names the edition and SKU sold, so editing the bundle
-- later never changes what an old order or an unclaimed gift grants.
--
-- bundle_books stays as a derived "works in this bundle" read model (the recommender and the public
-- pages' work-level counts read it) and is rebuilt from bundle_editions by a trigger. It is dropped
-- with the other work-level tables in the contract migration.

alter type public.bundle_order_line add attribute edition_id uuid, add attribute language_code text;

create function public.bundle_books_rebuild()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bundle_id uuid := coalesce(new.bundle_id, old.bundle_id);
begin
  delete from public.bundle_books where bundle_id = v_bundle_id;
  insert into public.bundle_books (bundle_id, book_id, position)
  select v_bundle_id, m.book_id, row_number() over (order by m.position, m.book_id)
  from (
    select ed.book_id, min(be.position) as position
    from public.bundle_editions be
    join public.editions ed on ed.id = be.edition_id
    where be.bundle_id = v_bundle_id
    group by ed.book_id
  ) m;
  return null;
end;
$$;

create trigger bundle_editions_mirror_books
after insert or update or delete on public.bundle_editions
for each row execute function public.bundle_books_rebuild();

-- Rebuild once for rows the backfill wrote before this trigger existed (a no-op on an empty database).
insert into public.bundle_books (bundle_id, book_id, position)
select be.bundle_id, ed.book_id, row_number() over (partition by be.bundle_id order by min(be.position), ed.book_id)
from public.bundle_editions be
join public.editions ed on ed.id = be.edition_id
group by be.bundle_id, ed.book_id
on conflict (bundle_id, book_id) do nothing;

-- An edition a bundle can actually sell: published, with a live publication, of a published work.
create function public.bundle_edition_is_sellable(p_edition_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.editions ed
    join public.books b on b.id = ed.book_id
    where ed.id = p_edition_id and ed.status = 'published' and ed.active_publication_id is not null and b.status = 'published'
  );
$$;
revoke all on function public.bundle_edition_is_sellable(uuid) from public, anon, authenticated;
grant execute on function public.bundle_edition_is_sellable(uuid) to service_role;

drop function public.admin_set_bundle_members(uuid, uuid[]);
create function public.admin_set_bundle_members(p_bundle_id uuid, p_edition_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_missing uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_set_bundle_members: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.bundles where id = p_bundle_id for update;
  if not found then
    raise exception 'admin_set_bundle_members: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;

  if p_edition_ids is null or cardinality(p_edition_ids) = 0 then
    raise exception 'admin_set_bundle_members: a bundle needs at least one member' using errcode = '22023';
  end if;
  if (select count(distinct m.edition_id) from unnest(p_edition_ids) as m(edition_id)) <> cardinality(p_edition_ids) then
    raise exception 'admin_set_bundle_members: an edition can appear in a bundle only once' using errcode = '22023';
  end if;

  select m.edition_id into v_missing
  from unnest(p_edition_ids) as m(edition_id)
  where not exists (select 1 from public.editions e where e.id = m.edition_id)
  limit 1;
  if v_missing is not null then
    raise exception 'admin_set_bundle_members: edition % does not exist', v_missing using errcode = 'P0002';
  end if;

  delete from public.bundle_editions where bundle_id = p_bundle_id;
  insert into public.bundle_editions (bundle_id, edition_id, position)
  select p_bundle_id, m.edition_id, m.ord
  from unnest(p_edition_ids) with ordinality as m(edition_id, ord);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'set_bundle_members', 'bundles', p_bundle_id,
          jsonb_build_object('edition_ids', p_edition_ids));
end;
$$;
revoke all on function public.admin_set_bundle_members(uuid, uuid[]) from public, anon;
grant execute on function public.admin_set_bundle_members(uuid, uuid[]) to authenticated, service_role;

drop function public.bundle_order_lines(uuid);
create function public.bundle_order_lines(p_bundle_id uuid)
returns table(line_position integer, book_id uuid, edition_id uuid, language_code text, sku_id uuid, title_snapshot text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    be.position,
    ed.book_id,
    ed.id,
    ed.language_code,
    (
      select sk.id from public.skus sk
      where sk.edition_id = ed.id
      order by sk.active desc, sk.sku_code
      limit 1
    ),
    coalesce((
      select bl.title from public.book_localizations bl
      where bl.book_id = ed.book_id
      order by (bl.locale = ed.language_code) desc, (bl.locale = b.original_language) desc, bl.locale
      limit 1
    ), '')
  from public.bundle_editions be
  join public.editions ed on ed.id = be.edition_id
  join public.books b on b.id = ed.book_id
  where be.bundle_id = p_bundle_id
    and public.bundle_edition_is_sellable(ed.id)
  order by be.position;
$$;
revoke all on function public.bundle_order_lines(uuid) from public, anon, authenticated;

create or replace function public.bundle_readiness_issues(p_bundle_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when (
      select count(*) from public.bundle_editions be
      where be.bundle_id = p_bundle_id and public.bundle_edition_is_sellable(be.edition_id)
    ) < 2 then 'too_few_published_members' end,
    case when not exists (
      select 1 from public.bundle_localizations bl
      where bl.bundle_id = p_bundle_id
        and length(trim(bl.title)) > 0
        and length(trim(bl.slug)) > 0
        and length(trim(coalesce(bl.description, ''))) > 0
    ) then 'missing_localization' end,
    case when not exists (
      select 1 from public.media_assets m
      where m.owner_type = 'bundle' and m.owner_id = p_bundle_id and m.kind = 'cover'
    ) then 'missing_cover' end,
    case when not exists (select 1 from public.bundle_live_offer(p_bundle_id)) then 'missing_offer' end
  ], null);
$$;

create or replace function public.create_bundle_order(p_bundle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_market_code text;
  v_currency text;
  v_price_minor bigint;
  v_offer_id uuid;
  v_order_id uuid;
  v_title_snapshot text;
  v_member_count integer;
  v_owned_count integer;
  v_missing_sku_count integer;
  v_bundle_status text;
  v_lines public.bundle_order_line[];
  v_payments_enabled boolean;
  v_provider text;
  v_stale uuid[];
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_bundle_order: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) then
    raise exception 'create_bundle_order: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  select cs.payments_enabled, cs.payment_provider into v_payments_enabled, v_provider
  from public.commerce_settings cs where cs.id;
  if not coalesce(v_payments_enabled, false) then
    raise exception 'create_bundle_order: payments are disabled' using errcode = 'EB011';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('create_bundle_order:' || v_profile_id::text || ':' || p_bundle_id::text, 0));

  -- The bundle row is locked before anything is read from it: admin_set_bundle_members takes the same
  -- lock, so no membership change can commit while this order is being built.
  select b.status into v_bundle_status from public.bundles b where b.id = p_bundle_id for update;
  if v_bundle_status is null then
    raise exception 'create_bundle_order: bundle % does not exist', p_bundle_id using errcode = 'P0002';
  end if;
  if v_bundle_status <> 'published' then
    raise exception 'create_bundle_order: bundle % is not purchasable', p_bundle_id using errcode = 'EB027';
  end if;

  select l.offer_id, l.market_code, l.currency, l.price_minor
  into v_offer_id, v_market_code, v_currency, v_price_minor
  from public.bundle_live_offer(p_bundle_id) l;

  if v_offer_id is not null then
    select o.market_code, o.currency, o.price_minor
    into v_market_code, v_currency, v_price_minor
    from public.offers o
    where o.id = v_offer_id
      and o.active
      and o.price_minor > 0
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at is null or o.ends_at > now())
    for update;
    if not found then
      v_offer_id := null;
    end if;
  end if;

  if v_offer_id is null then
    raise exception 'create_bundle_order: bundle % is not purchasable', p_bundle_id using errcode = 'EB027';
  end if;

  -- One bundle, one currency, and only a currency a transfer can settle. No conversion, no mixing.
  if not public.currency_is_payable(v_currency) then
    raise exception 'create_bundle_order: % cannot be paid by manual transfer', v_currency using errcode = 'EB041';
  end if;

  -- The order lines are read ONCE and everything below validates and writes from that snapshot, so an
  -- edition unpublished mid-transaction cannot leave the buyer sold fewer editions than were counted.
  select coalesce(
           array_agg(row(l.line_position, l.book_id, l.sku_id, l.title_snapshot, l.edition_id, l.language_code)::public.bundle_order_line
                     order by l.line_position),
           '{}'::public.bundle_order_line[])
  into v_lines
  from public.bundle_order_lines(p_bundle_id) l;

  v_member_count := cardinality(v_lines);
  if v_member_count = 0 then
    raise exception 'create_bundle_order: bundle % has no sellable member edition', p_bundle_id using errcode = 'EB027';
  end if;

  select count(*) into v_missing_sku_count from unnest(v_lines) m where m.sku_id is null;
  if v_missing_sku_count > 0 then
    raise exception 'create_bundle_order: bundle % has a member edition with no sku', p_bundle_id using errcode = 'EB027';
  end if;

  -- Ownership is per edition: holding the English edition leaves the Japanese one for sale.
  select count(*) into v_owned_count
  from unnest(v_lines) m
  join public.entitlements e
    on e.profile_id = v_profile_id and e.edition_id = m.edition_id and e.status = 'active';

  if v_owned_count = v_member_count then
    raise exception 'create_bundle_order: profile % already owns every edition of bundle %', v_profile_id, p_bundle_id
      using errcode = 'EB013';
  end if;

  perform 1
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
  for update;

  -- A pending order is stale when its price, currency, provider OR contents no longer match: a bundle
  -- that gained or lost an edition is a different product from the one the reader started buying.
  select coalesce(array_agg(o.id), '{}') into v_stale
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
    and (
      o.subtotal_minor <> v_price_minor
      or o.currency <> v_currency
      or not exists (select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider)
      or (select array_agg(oi.edition_id order by oi.edition_id) from public.order_items oi where oi.order_id = o.id)
         is distinct from (select array_agg(m.edition_id order by m.edition_id) from unnest(v_lines) m)
    );

  update public.payments pay set status = 'cancelled' where pay.status = 'pending' and pay.order_id = any (v_stale);
  delete from public.coupon_redemptions r where r.order_id = any (v_stale);
  update public.orders o set status = 'cancelled', payment_status = 'cancelled' where o.id = any (v_stale);

  select o.id into v_order_id
  from public.orders o
  where o.profile_id = v_profile_id and o.bundle_id = p_bundle_id and o.status = 'pending'
  order by o.created_at desc
  limit 1;

  if v_order_id is not null then
    return v_order_id;
  end if;

  select bl.title into v_title_snapshot
  from public.bundle_localizations bl
  where bl.bundle_id = p_bundle_id
  order by (bl.locale = (select s.default_metadata_locale from public.platform_settings s)) desc, bl.locale
  limit 1;

  insert into public.orders (
    profile_id, bundle_id, status, payment_status, market_code, currency,
    total_minor, subtotal_minor, payment_provider, title_snapshot
  )
  values (
    v_profile_id, p_bundle_id, 'pending', 'pending', v_market_code, v_currency,
    v_price_minor, v_price_minor, v_provider, coalesce(v_title_snapshot, '')
  )
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, edition_id, language_code, title_snapshot, unit_price_minor, quantity, position)
  select
    v_order_id,
    m.sku_id,
    m.book_id,
    m.edition_id,
    m.language_code,
    m.title_snapshot,
    case when row_number() over (order by m.line_position) = 1 then v_price_minor else 0 end,
    1,
    m.line_position
  from unnest(v_lines) m;

  insert into public.payments (order_id, provider, status, amount_minor, currency)
  values (v_order_id, v_provider, 'pending', v_price_minor, v_currency);

  return v_order_id;
end;
$$;
