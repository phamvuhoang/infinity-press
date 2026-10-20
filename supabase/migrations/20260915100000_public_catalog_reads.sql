-- S2 public catalog reads. See docs/superpowers/specs/2026-09-15-s2-public-discovery-design.md (4.1, 4.2).
--
-- Public pages read the catalog only through these functions. Each one filters to published rows
-- itself. Admins can read drafts under RLS, so an explicit filter is the only way an admin sees the
-- same storefront as everyone else.

-- True when the author, series, or topic has at least one published book localized in p_locale.
create function public.catalog_has_visible_book(p_kind text, p_entity_id uuid, p_locale text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.books b
    join public.book_localizations bl on bl.book_id = b.id and bl.locale = p_locale
    where b.status = 'published'
      and case p_kind
        when 'author' then b.primary_author_id = p_entity_id
        when 'series' then exists (
          select 1 from public.book_series bs where bs.book_id = b.id and bs.series_id = p_entity_id
        )
        when 'topic' then exists (
          select 1 from public.book_topics bt where bt.book_id = b.id and bt.topic_id = p_entity_id
        )
        else false
      end
  );
$$;

create function public.catalog_book_cards(p_locale text)
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
  where b.status = 'published';
$$;

create function public.catalog_book_page(p_locale text, p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'bookId', b.id,
    'description', bl.description,
    'audience', bl.audience,
    'keyIdeas', bl.key_ideas,
    'faq', bl.faq,
    'seoTitle', bl.seo_title,
    'seoDescription', bl.seo_description,
    'alternateSlug', (
      select other.slug from public.book_localizations other
      where other.book_id = b.id and other.locale <> bl.locale
    )
  )
  from public.book_localizations bl
  join public.books b on b.id = bl.book_id
  where bl.locale = p_locale and bl.slug = p_slug and b.status = 'published';
$$;

create function public.catalog_entity_page(p_kind text, p_locale text, p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_other_locale text := case p_locale when 'vi' then 'en' when 'en' then 'vi' end;
  v_id uuid;
  v_name text;
  v_description text;
  v_alternate_slug text;
begin
  if v_other_locale is null then
    return null;
  end if;

  if p_kind = 'author' then
    select a.id, l.name, l.description into v_id, v_name, v_description
    from public.author_localizations l
    join public.authors a on a.id = l.author_id
    where l.locale = p_locale and l.slug = p_slug and a.status = 'published';
    select l.slug into v_alternate_slug
    from public.author_localizations l
    where l.author_id = v_id and l.locale = v_other_locale;
  elsif p_kind = 'series' then
    select s.id, l.name, l.description into v_id, v_name, v_description
    from public.series_localizations l
    join public.series s on s.id = l.series_id
    where l.locale = p_locale and l.slug = p_slug and s.status = 'published';
    select l.slug into v_alternate_slug
    from public.series_localizations l
    where l.series_id = v_id and l.locale = v_other_locale;
  elsif p_kind = 'topic' then
    select t.id, l.name, l.description into v_id, v_name, v_description
    from public.topic_localizations l
    join public.topics t on t.id = l.topic_id
    where l.locale = p_locale and l.slug = p_slug and t.status = 'published';
    select l.slug into v_alternate_slug
    from public.topic_localizations l
    where l.topic_id = v_id and l.locale = v_other_locale;
  else
    return null;
  end if;

  if v_id is null or not public.catalog_has_visible_book(p_kind, v_id, p_locale) then
    return null;
  end if;

  -- The other-locale page only exists when it also has a visible book.
  if v_alternate_slug is not null and not public.catalog_has_visible_book(p_kind, v_id, v_other_locale) then
    v_alternate_slug := null;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'name', v_name,
    'description', v_description,
    'alternateSlug', v_alternate_slug
  );
end;
$$;

revoke execute on function public.catalog_has_visible_book(text, uuid, text) from public, anon, authenticated;

revoke execute on function public.catalog_book_cards(text) from public;
grant execute on function public.catalog_book_cards(text) to anon, authenticated;
revoke execute on function public.catalog_book_page(text, text) from public;
grant execute on function public.catalog_book_page(text, text) to anon, authenticated;
revoke execute on function public.catalog_entity_page(text, text, text) from public;
grant execute on function public.catalog_entity_page(text, text, text) to anon, authenticated;
