-- S19: a book sale price (docs/superpowers/specs/2026-10-18-s19-book-sale-price-design.md).
--
-- offers.price_minor stays the list price. A sale lives in five columns beside it, and
-- offer_effective_price_minor is the one place that turns them into what a buyer pays now. The
-- order path snapshots that value, so coupons, SePay, manual transfer, the simulator and gifts all
-- charge the sale price without knowing a sale exists.

alter table public.offers
  add column sale_kind text check (sale_kind in ('percent', 'fixed')),
  add column sale_percent_off integer check (sale_percent_off between 1 and 99),
  add column sale_amount_off_minor bigint check (sale_amount_off_minor > 0),
  add column sale_starts_at timestamptz,
  add column sale_ends_at timestamptz,
  -- A sale is all or nothing, and a fixed one stays below the list price, so a sale can never make
  -- a book free (spec 2): the free path stays price_minor = 0 or a 100% coupon. Being a row CHECK,
  -- it also refuses a later list-price cut that would undercut a running fixed sale. The whole
  -- expression is forced IS TRUE: with sale_kind null, `sale_kind = 'percent'` is NULL, and a CHECK
  -- that evaluates to NULL passes, which would store a value with no kind.
  add constraint offers_sale_shape check ((
    (sale_kind is null and sale_percent_off is null and sale_amount_off_minor is null
       and sale_starts_at is null and sale_ends_at is null)
    or (sale_kind = 'percent' and sale_percent_off is not null and sale_amount_off_minor is null)
    or (sale_kind = 'fixed' and sale_amount_off_minor is not null and sale_percent_off is null
        and sale_amount_off_minor < price_minor)
  ) is true),
  add constraint offers_sale_needs_price check (sale_kind is null or price_minor > 0),
  -- A bundle is priced as its own product (S9 spec 6.1); bundle sales are out of scope.
  add constraint offers_sale_books_only check (sale_kind is null or bundle_id is null),
  add constraint offers_sale_window check (sale_ends_at is null or sale_starts_at is null or sale_ends_at > sale_starts_at);

grant update (sale_kind, sale_percent_off, sale_amount_off_minor, sale_starts_at, sale_ends_at)
  on public.offers to authenticated;

-- The window is half-open, [sale_starts_at, sale_ends_at), like offers.starts_at/ends_at. A percent
-- discount is floored like a coupon's (lib/commerce/coupon.ts), so it never rounds up into the
-- house's money; percent_off <= 99 and the fixed CHECK keep the result at 1 or more.
create function public.offer_effective_price_minor(o public.offers)
returns bigint
language sql
stable
set search_path = ''
as $$
  select case
    when o.sale_kind is null
      or (o.sale_starts_at is not null and o.sale_starts_at > now())
      or (o.sale_ends_at is not null and o.sale_ends_at <= now())
      then o.price_minor
    when o.sale_kind = 'percent'
      then o.price_minor - (o.price_minor * o.sale_percent_off) / 100
    else o.price_minor - o.sale_amount_off_minor
  end;
$$;

revoke execute on function public.offer_effective_price_minor(public.offers) from public;
grant execute on function public.offer_effective_price_minor(public.offers) to anon, authenticated, service_role;

-- ------------------------------------------------------------------------------------------
-- Catalog reads. offer.price_minor becomes the effective price, and two columns are appended:
-- list_price_minor and sale_ends_at, both null unless a sale is lowering the price right now. The
-- return type changes, so both functions are dropped and re-created with their grants.
drop function public.catalog_book_cards(text);
drop function public.catalog_book_card_by_id(text, uuid);

create function public.catalog_book_cards(p_locale text)
 returns table(book_id uuid, slug text, title text, subtitle text, short_description text, author_name text, author_slug text, cover_path text, cover_alt text, price_minor bigint, currency text, has_active_publication boolean, has_sample boolean, series_slug text, series_name text, series_position integer, topics jsonb, featured boolean, shelf_position integer, created_at timestamp with time zone, list_price_minor bigint, sale_ends_at timestamp with time zone)
language sql
stable security definer
set search_path = ''
as $$
  select
    b.id,
    bl.slug,
    bl.title,
    bl.subtitle,
    bl.short_description,
    coalesce(al.name, a.display_name),
    al.slug,
    cover.storage_key,
    cover.alt_text,
    offer.price_minor,
    offer.currency,
    exists (
      select 1 from public.ebook_publications p
      where p.id = b.active_publication_id and p.status = 'published'
    ),
    exists (
      select 1 from public.book_samples s
      join public.ebook_publications p on p.id = s.publication_id
      where p.id = b.active_publication_id
        and p.status = 'published'
        and jsonb_array_length(s.allowed_hrefs) > 0
    ),
    series.slug,
    series.name,
    series.position,
    coalesce((
      select jsonb_agg(jsonb_build_object('slug', tl.slug, 'name', tl.name) order by tl.name)
      from public.book_topics bt
      join public.topics t on t.id = bt.topic_id and t.status = 'published'
      join public.topic_localizations tl on tl.topic_id = t.id and tl.locale = p_locale
      where bt.book_id = b.id
    ), '[]'::jsonb),
    exists (
      select 1 from public.merchandising_slots ms
      where ms.book_id = b.id and ms.slot_key = 'home_featured' and ms.active
    ),
    (
      select ms.position from public.merchandising_slots ms
      where ms.book_id = b.id and ms.slot_key = 'home_shelf' and ms.active
    ),
    b.created_at,
    offer.list_price_minor,
    offer.sale_ends_at
  from public.books b
  join public.book_localizations bl on bl.book_id = b.id and bl.locale = p_locale
  join public.authors a on a.id = b.primary_author_id
  left join public.author_localizations al
    on al.author_id = a.id and al.locale = p_locale and a.status = 'published'
  left join lateral (
    select m.storage_key, m.alt_text
    from public.media_assets m
    where m.owner_type = 'book' and m.owner_id = b.id and m.kind = 'cover'
    limit 1
  ) cover on true
  left join lateral (
    -- MVP books have one ebook offer. If there are more, the cheapest wins.
    -- price_minor is what a buyer pays now (S19 spec 3); the list price rides along only while a
    -- sale actually lowers it.
    select eff.price_minor, o.currency,
      case when eff.price_minor < o.price_minor then o.price_minor end as list_price_minor,
      case when eff.price_minor < o.price_minor then o.sale_ends_at end as sale_ends_at
    from public.offers o
    cross join lateral (select public.offer_effective_price_minor(o) as price_minor) eff
    join public.skus sk on sk.id = o.sku_id
    join public.editions e on e.id = sk.edition_id
    where e.book_id = b.id
      and o.active and sk.active
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at is null or o.ends_at > now())
    order by eff.price_minor, o.currency
    limit 1
  ) offer on true
  left join lateral (
    select sl.slug, sl.name, bs.position
    from public.book_series bs
    join public.series sr on sr.id = bs.series_id and sr.status = 'published'
    join public.series_localizations sl on sl.series_id = sr.id and sl.locale = p_locale
    where bs.book_id = b.id
  ) series on true
  where b.status = 'published';
$$;

create function public.catalog_book_card_by_id(p_locale text, p_book_id uuid)
 returns table(book_id uuid, slug text, title text, subtitle text, short_description text, author_name text, author_slug text, cover_path text, cover_alt text, price_minor bigint, currency text, has_active_publication boolean, has_sample boolean, series_slug text, series_name text, series_position integer, topics jsonb, featured boolean, shelf_position integer, created_at timestamp with time zone, list_price_minor bigint, sale_ends_at timestamp with time zone)
language sql
stable security definer
set search_path = ''
as $$
  select
    b.id,
    bl.slug,
    bl.title,
    bl.subtitle,
    bl.short_description,
    coalesce(al.name, a.display_name),
    al.slug,
    cover.storage_key,
    cover.alt_text,
    offer.price_minor,
    offer.currency,
    exists (
      select 1 from public.ebook_publications p
      where p.id = b.active_publication_id and p.status = 'published'
    ),
    exists (
      select 1 from public.book_samples s
      join public.ebook_publications p on p.id = s.publication_id
      where p.id = b.active_publication_id
        and p.status = 'published'
        and jsonb_array_length(s.allowed_hrefs) > 0
    ),
    series.slug,
    series.name,
    series.position,
    coalesce((
      select jsonb_agg(jsonb_build_object('slug', tl.slug, 'name', tl.name) order by tl.name)
      from public.book_topics bt
      join public.topics t on t.id = bt.topic_id and t.status = 'published'
      join public.topic_localizations tl on tl.topic_id = t.id and tl.locale = p_locale
      where bt.book_id = b.id
    ), '[]'::jsonb),
    exists (
      select 1 from public.merchandising_slots ms
      where ms.book_id = b.id and ms.slot_key = 'home_featured' and ms.active
    ),
    (
      select ms.position from public.merchandising_slots ms
      where ms.book_id = b.id and ms.slot_key = 'home_shelf' and ms.active
    ),
    b.created_at,
    offer.list_price_minor,
    offer.sale_ends_at
  from public.books b
  join public.book_localizations bl on bl.book_id = b.id and bl.locale = p_locale
  join public.authors a on a.id = b.primary_author_id
  left join public.author_localizations al
    on al.author_id = a.id and al.locale = p_locale and a.status = 'published'
  left join lateral (
    select m.storage_key, m.alt_text
    from public.media_assets m
    where m.owner_type = 'book' and m.owner_id = b.id and m.kind = 'cover'
    limit 1
  ) cover on true
  left join lateral (
    -- MVP books have one ebook offer. If there are more, the cheapest wins.
    -- price_minor is what a buyer pays now (S19 spec 3); the list price rides along only while a
    -- sale actually lowers it.
    select eff.price_minor, o.currency,
      case when eff.price_minor < o.price_minor then o.price_minor end as list_price_minor,
      case when eff.price_minor < o.price_minor then o.sale_ends_at end as sale_ends_at
    from public.offers o
    cross join lateral (select public.offer_effective_price_minor(o) as price_minor) eff
    join public.skus sk on sk.id = o.sku_id
    join public.editions e on e.id = sk.edition_id
    where e.book_id = b.id
      and o.active and sk.active
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at is null or o.ends_at > now())
    order by eff.price_minor, o.currency
    limit 1
  ) offer on true
  left join lateral (
    select sl.slug, sl.name, bs.position
    from public.book_series bs
    join public.series sr on sr.id = bs.series_id and sr.status = 'published'
    join public.series_localizations sl on sl.series_id = sr.id and sl.locale = p_locale
    where bs.book_id = b.id
  ) series on true
  where b.status = 'published' and b.id = p_book_id;
$$;

revoke execute on function public.catalog_book_cards(text) from public;
grant execute on function public.catalog_book_cards(text) to anon, authenticated, service_role;
revoke execute on function public.catalog_book_card_by_id(text, uuid) from public;
grant execute on function public.catalog_book_card_by_id(text, uuid) to anon, authenticated, service_role;

-- ------------------------------------------------------------------------------------------
-- create_ebook_order, from 20260923100000_s8_coupon_schema.sql with two changes: the price is the
-- effective one, and (spec 9.1) a pending order with a reported manual transfer is no longer
-- cancelled by a price change. The provider-switch half of the staleness test is unchanged.
create or replace function public.create_ebook_order(p_book_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_sku_id uuid;
  v_market_code text;
  v_currency text;
  v_price_minor bigint;
  v_order_id uuid;
  v_original_language text;
  v_title_snapshot text;
  v_payments_enabled boolean;
  v_provider text;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_ebook_order: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) then
    raise exception 'create_ebook_order: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  -- One read for both halves of the settings row, so the gate and the provider can never be taken
  -- from two different moments.
  select cs.payments_enabled, cs.payment_provider
  into v_payments_enabled, v_provider
  from public.commerce_settings cs where cs.id;

  if not coalesce(v_payments_enabled, false) then
    raise exception 'create_ebook_order: payments are disabled' using errcode = 'EB011';
  end if;

  -- One reader clicking Buy twice must not create two orders. The lock is per (profile, book) and
  -- ends with the transaction.
  perform pg_advisory_xact_lock(hashtextextended('create_ebook_order:' || v_profile_id::text || ':' || p_book_id::text, 0));

  if exists (
    select 1 from public.entitlements e
    where e.profile_id = v_profile_id and e.book_id = p_book_id and e.status = 'active'
  ) then
    raise exception 'create_ebook_order: profile % already owns book %', v_profile_id, p_book_id using errcode = 'EB013';
  end if;

  -- The effective price (S19): the sale price while a sale runs, otherwise the list price. Every
  -- amount below - the stale-order test, the order, its item and its payment - is this one value.
  select o.sku_id, o.market_code, o.currency, public.offer_effective_price_minor(o)
  into v_sku_id, v_market_code, v_currency, v_price_minor
  from public.offers o
  join public.skus s on s.id = o.sku_id
  join public.editions ed on ed.id = s.edition_id
  join public.books b on b.id = ed.book_id
  join public.ebook_publications pub on pub.id = b.active_publication_id
  where b.id = p_book_id
    and b.status = 'published'
    and pub.status = 'published'
    and o.active
    and o.price_minor > 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  order by o.market_code
  limit 1
  for update of o;

  if v_sku_id is null then
    raise exception 'create_ebook_order: book % is not purchasable', p_book_id using errcode = 'EB012';
  end if;

  -- Lock the caller's pending orders for this book before touching payments or orders, matching
  -- apply_payment_event's orders-then-payments lock order.
  perform 1
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
  for update of o;

  -- A pending order whose snapshot no longer matches the offer is stale: cancel it so the reader
  -- always pays the price the book page shows (spec 4.3). A provider switch makes an order stale
  -- the same way, and for the same reason - an order booked under the other provider is invisible
  -- to every surface of the active one, so reusing it would strand the reader on a page that
  -- cannot progress. Both cases go through this one mechanism.
  update public.payments pay
  set status = 'cancelled'
  where pay.status = 'pending'
    and pay.order_id in (
      select o.id from public.orders o
      join public.order_items oi on oi.order_id = o.id
      where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
        and (
          (
            (o.subtotal_minor <> v_price_minor or o.currency <> v_currency)
            -- S19 spec 9.1: a reported transfer keeps the price the reader transferred.
            and not exists (select 1 from public.manual_transfer_claims c where c.order_id = o.id)
          )
          or not exists (
            select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
          )
        )
    );

  -- Release any coupon reservation held by the orders about to be cancelled below. Without this, a
  -- stale order's redemption would survive its order - a "reserved" row pointing at a cancelled
  -- order - permanently consuming one use of the code for nothing.
  delete from public.coupon_redemptions r
  where r.order_id in (
    select o.id from public.orders o
    join public.order_items oi on oi.order_id = o.id
    where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
      and (
        (
          (o.subtotal_minor <> v_price_minor or o.currency <> v_currency)
          -- S19 spec 9.1: a reported transfer keeps the price the reader transferred.
          and not exists (select 1 from public.manual_transfer_claims c where c.order_id = o.id)
        )
        or not exists (
          select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
        )
      )
  );

  update public.orders o
  set status = 'cancelled', payment_status = 'cancelled'
  from public.order_items oi
  where oi.order_id = o.id
    and o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
    and (
      (
        (o.subtotal_minor <> v_price_minor or o.currency <> v_currency)
        -- S19 spec 9.1: a reported transfer keeps the price the reader transferred.
        and not exists (select 1 from public.manual_transfer_claims c where c.order_id = o.id)
      )
      or not exists (
        select 1 from public.payments p2 where p2.order_id = o.id and p2.provider = v_provider
      )
    );

  select o.id into v_order_id
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
  order by o.created_at desc
  limit 1;

  if v_order_id is not null then
    return v_order_id;
  end if;

  select b.original_language into v_original_language from public.books b where b.id = p_book_id;
  select bl.title into v_title_snapshot
  from public.book_localizations bl
  where bl.book_id = p_book_id
  order by (bl.locale = v_original_language) desc, bl.locale
  limit 1;

  insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, payment_provider)
  values (v_profile_id, 'pending', 'pending', v_market_code, v_currency, v_price_minor, v_price_minor, v_provider)
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
  values (v_order_id, v_sku_id, p_book_id, coalesce(v_title_snapshot, ''), v_price_minor, 1);

  -- The provider comes from commerce_settings, never from the caller: this function is granted to
  -- `authenticated`, and which provider an order is booked under decides who may confirm it.
  -- apply_payment_event resolves this row by (order_id, provider) when events arrive.
  insert into public.payments (order_id, provider, status, amount_minor, currency)
  values (v_order_id, v_provider, 'pending', v_price_minor, v_currency);

  return v_order_id;
end;
$$;
