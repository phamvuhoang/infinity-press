-- S14: paperback retailer links (spec section 5), the audited admin write path (section 7), and
-- the catalog_book_page extension that carries them to the book page in the same round trip.

create table public.book_retail_links (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  retailer text not null check (retailer in ('shopee', 'fahasa', 'tiki', 'other')),
  label text check (label is null or length(btrim(label)) between 1 and 80),
  url text not null check (url ~ '^https://[^\s]+$'),
  price_minor bigint check (price_minor is null or price_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  position integer not null check (position > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, position),
  check ((retailer = 'other') = (label is not null)),
  check ((price_minor is null) = (currency is null))
);

create trigger book_retail_links_touch_updated_at
  before update on public.book_retail_links
  for each row execute function public.touch_updated_at();

alter table public.book_retail_links enable row level security;

revoke all on public.book_retail_links from public, anon, authenticated;
grant select on public.book_retail_links to anon, authenticated;

create policy "public reads active links of published books" on public.book_retail_links
  for select to anon, authenticated
  using (
    active
    and exists (select 1 from public.books b where b.id = book_retail_links.book_id and b.status = 'published')
  );

create policy "admin reads retail links" on public.book_retail_links
  for select to authenticated
  using (public.is_admin());

-- Replaces the whole set. Positions are the array order, 1..N. Validated before the delete so a
-- bad payload leaves the existing set exactly as it was (the admin_set_related_books rule).
create function public.admin_set_book_retail_links(p_book_id uuid, p_links jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_row jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin_set_book_retail_links: caller is not an admin' using errcode = '42501';
  end if;

  perform 1 from public.books where id = p_book_id for update;
  if not found then
    raise exception 'admin_set_book_retail_links: book % does not exist', p_book_id using errcode = 'P0002';
  end if;

  if p_links is null or jsonb_typeof(p_links) <> 'array' then
    raise exception 'admin_set_book_retail_links: links must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_links) > 10 then
    raise exception 'admin_set_book_retail_links: at most 10 links per book' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_links) loop
    if (v_row ->> 'retailer') is null or (v_row ->> 'retailer') not in ('shopee', 'fahasa', 'tiki', 'other') then
      raise exception 'admin_set_book_retail_links: unknown retailer' using errcode = '22023';
    end if;
    if (v_row ->> 'url') is null or (v_row ->> 'url') !~ '^https://[^\s]+$' then
      raise exception 'admin_set_book_retail_links: url must be absolute https' using errcode = '22023';
    end if;
    if ((v_row ->> 'retailer') = 'other') <> ((v_row ->> 'label') is not null and length(btrim(v_row ->> 'label')) > 0) then
      raise exception 'admin_set_book_retail_links: label is required exactly for retailer other' using errcode = '22023';
    end if;
    if ((v_row ->> 'priceMinor') is null) <> ((v_row ->> 'currency') is null) then
      raise exception 'admin_set_book_retail_links: price and currency go together' using errcode = '22023';
    end if;
  end loop;

  delete from public.book_retail_links where book_id = p_book_id;
  insert into public.book_retail_links (book_id, retailer, label, url, price_minor, currency, position, active)
  select
    p_book_id,
    l.value ->> 'retailer',
    nullif(btrim(l.value ->> 'label'), ''),
    l.value ->> 'url',
    (l.value ->> 'priceMinor')::bigint,
    l.value ->> 'currency',
    l.ord,
    coalesce((l.value ->> 'active')::boolean, true)
  from jsonb_array_elements(p_links) with ordinality as l(value, ord);

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor_profile_id, 'book.retail_links.set', 'books', p_book_id,
          jsonb_build_object('count', jsonb_array_length(p_links)));
end;
$$;

revoke execute on function public.admin_set_book_retail_links(uuid, jsonb) from public, anon;
grant execute on function public.admin_set_book_retail_links(uuid, jsonb) to authenticated;

-- catalog_book_page: two new keys. Everything else is 20260915100000's body unchanged.
create or replace function public.catalog_book_page(p_locale text, p_slug text)
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
    ),
    'isbn', (
      select e.isbn from public.editions e
      where e.book_id = b.id and e.isbn is not null
      order by e.language_code = p_locale desc, e.edition_number
      limit 1
    ),
    'retailLinks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rl.id,
        'retailer', rl.retailer,
        'label', rl.label,
        'url', rl.url,
        'priceMinor', rl.price_minor,
        'currency', rl.currency
      ) order by rl.position)
      from public.book_retail_links rl
      where rl.book_id = b.id and rl.active
    ), '[]'::jsonb)
  )
  from public.book_localizations bl
  join public.books b on b.id = bl.book_id
  where bl.locale = p_locale and bl.slug = p_slug and b.status = 'published';
$$;
