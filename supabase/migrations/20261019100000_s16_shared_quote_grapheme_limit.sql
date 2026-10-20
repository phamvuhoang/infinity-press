-- S16 follow-up: the route truncates a shared quote to 300 grapheme clusters, but authenticated
-- callers can reach create_shared_quote directly, so the RPC enforces the limit itself.

-- Postgres has no grapheme segmentation. After NFC, Vietnamese and most Latin text is one code point
-- per grapheme; combining marks, variation selectors, ZWJ, and skin-tone modifiers are not counted.
-- ponytail: flags and ZWJ emoji families still count once per component, so a quote heavy in them can
-- be refused below 300 graphemes (the reader then falls back to the book URL). Add a real segmenter if
-- that ever matters.
create function public.shared_quote_graphemes(p_text text)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select char_length(regexp_replace(normalize(p_text, NFC),
    '[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE00-\uFE0F\uFE20-\uFE2F\u200D]|[\U0001F3FB-\U0001F3FF]', '', 'g'));
$$;
revoke all on function public.shared_quote_graphemes(text) from public, anon, authenticated;

create or replace function public.create_shared_quote(p_publication_id uuid, p_quote text, p_locale text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_book_id uuid;
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
     or p_locale is null or p_locale not in ('vi', 'en') then
    raise exception 'create_shared_quote: invalid input' using errcode = 'EB039';
  end if;
  -- The publication must be the book's active, published one, and the caller must hold the book.
  -- A publication reaches its book through its asset's edition; there is no book_id on it.
  select b.id into v_book_id
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions ed on ed.id = a.edition_id
  join public.books b on b.id = ed.book_id and b.active_publication_id = pub.id and b.status = 'published'
  where pub.id = p_publication_id and pub.status = 'published'
    and exists (select 1 from public.entitlements en
                where en.profile_id = v_profile_id and en.book_id = b.id and en.status = 'active');
  if v_book_id is null then
    raise exception 'create_shared_quote: not entitled' using errcode = 'EB039';
  end if;
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
$$;
