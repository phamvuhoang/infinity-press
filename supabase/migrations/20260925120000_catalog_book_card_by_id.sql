-- Storefront static caching, final review Minor 5: the book action-state route handler
-- (app/api/catalog/books/[bookId]/action-state/route.ts) was reading the entire published catalog
-- (catalog_book_cards) on every anonymous page view just to find one book by id, unlike the bundle
-- handler's targeted getPublicBundleById. This is the targeted equivalent for books: the same
-- select as catalog_book_cards, filtered to one book, so the route handler can do a single-row
-- lookup instead of a full-catalog scan. A new function rather than adding an optional parameter to
-- catalog_book_cards, so the existing signature and every existing caller are untouched.
create function public.catalog_book_card_by_id(p_locale text, p_book_id uuid)
returns table (
  book_id uuid,
  slug text,
  title text,
  subtitle text,
  short_description text,
  author_name text,
  author_slug text,
  cover_path text,
  cover_alt text,
  price_minor bigint,
  currency text,
  has_active_publication boolean,
  has_sample boolean,
  series_slug text,
  series_name text,
  series_position integer,
  topics jsonb,
  featured boolean,
  shelf_position integer,
  created_at timestamptz
)
language sql
stable
security definer
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
    b.created_at
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
    select o.price_minor, o.currency
    from public.offers o
    join public.skus sk on sk.id = o.sku_id
    join public.editions e on e.id = sk.edition_id
    where e.book_id = b.id
      and o.active and sk.active
      and (o.starts_at is null or o.starts_at <= now())
      and (o.ends_at is null or o.ends_at > now())
    order by o.price_minor, o.currency
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

revoke execute on function public.catalog_book_card_by_id(text, uuid) from public;
grant execute on function public.catalog_book_card_by_id(text, uuid) to anon, authenticated;
