-- create_shared_quote keeps requiring a published book
-- (docs/superpowers/specs/2026-10-21-owner-reads-unpublished-design.md, "What stays hidden").
-- reader_edition_for_publication no longer looks at books.status, so this function, which relied on
-- it for that, now checks the book itself. Body otherwise unchanged from 20261020140000.

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
  -- An owner keeps reading after "Unpublish book" (20261021100000_owner_reads_unpublished.sql), but a
  -- public share card needs a published book: catalog_shared_quote would 404 it, so no row is made.
  if not exists (select 1 from public.books b where b.id = v_book_id and b.status = 'published') then
    raise exception 'create_shared_quote: book is not published' using errcode = 'EB039';
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
$function$;
