-- public.admin_create_ebook(): the one-book admin catalog workflow's sole write path. Inserts a
-- new author, book, localization, edition, ebook SKU, and offer as one graph, in dependency
-- order, and returns the new book's id.
--
-- Idempotency decision: this function is NOT idempotent. It always creates six new rows; it never
-- looks up an existing author, book, or localization to reuse. A second call with the same
-- localized slug fails outright on book_localizations' unique(locale, slug) constraint (or, if the
-- author name also repeats, on authors.canonical_slug unique first) rather than silently handing
-- back the first call's book id. Two different admins could legitimately pick the same slug for
-- two different books - the RPC has no client-supplied idempotency key to tell "this is a retry of
-- my own call" apart from "someone else already used this slug" - so guessing the caller meant the
-- former and returning an unrelated book's id would be worse than a clear rejection. Because this
-- whole insert sequence executes as the one statement PostgREST wraps per request, an uncaught
-- exception at any insert - whichever constraint fires first - aborts the entire call and rolls
-- back every insert already made earlier in the same invocation. No explicit rollback/savepoint
-- logic is needed for "duplicate leaves no partial graph": ordinary Postgres statement atomicity
-- provides it.
create function public.admin_create_ebook(
  p_canonical_key text,
  p_author_name text,
  p_locale text,
  p_language text,
  p_title text,
  p_slug text,
  p_market text,
  p_currency text,
  p_price_minor bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_author_id uuid;
  v_book_id uuid;
  v_edition_id uuid;
  v_sku_id uuid;
  v_author_slug text;
begin
  if not public.is_admin() then
    raise exception 'admin_create_ebook: caller is not an admin' using errcode = '42501';
  end if;

  -- Author slug derived from the display name: lowercase, non-alphanumeric runs collapsed to a
  -- single hyphen, leading/trailing hyphens trimmed. Not user-supplied - createBookSchema only
  -- validates authorName as free text - so it is computed here rather than trusted from the
  -- client.
  v_author_slug := trim(both '-' from lower(regexp_replace(p_author_name, '[^a-zA-Z0-9]+', '-', 'g')));

  insert into public.authors (canonical_slug, display_name)
  values (v_author_slug, p_author_name)
  returning id into v_author_id;

  insert into public.books (canonical_key, original_language, primary_author_id)
  values (p_canonical_key, p_language, v_author_id)
  returning id into v_book_id;

  insert into public.book_localizations (book_id, locale, slug, title)
  values (v_book_id, p_locale, p_slug, p_title);

  insert into public.editions (book_id, language_code)
  values (v_book_id, p_language)
  returning id into v_edition_id;

  insert into public.skus (edition_id, sku_code)
  values (v_edition_id, p_canonical_key || '-ebook')
  returning id into v_sku_id;

  insert into public.offers (sku_id, market_code, currency, price_minor)
  values (v_sku_id, p_market, p_currency, p_price_minor);

  return v_book_id;
end;
$$;

-- Ruling R: EXECUTE goes to authenticated only. Not service_role - the function's is_admin()
-- check resolves through auth.uid(), which is null under the service role, so a service-role
-- caller could never pass it (Ruling W). Granting EXECUTE to a role that can never succeed would
-- mislead future callers into thinking a service-role path exists.
revoke execute on function public.admin_create_ebook(
  text, text, text, text, text, text, text, text, bigint
) from public, anon;
grant execute on function public.admin_create_ebook(
  text, text, text, text, text, text, text, text, bigint
) to authenticated;

-- Ruling AP: an admin needs to read back a book this RPC just created, and a freshly created
-- book (along with its author, localization, edition, sku, and offer) is 'draft' - the only
-- catalog policies that exist (20260911090000_mvp_catalog_publishing.sql:183-234) are "public
-- read published ...", scoped to status = 'published'. Rather than route that read through the
-- service-role client - the same "is this genuinely inexpressible as a policy" question Ruling
-- AD answers yes to for signed upload URLs answers no to here - this adds the
-- is_admin()-gated admin-read policy already established on seven Task 6 tables
-- (20260911100000_mvp_access_admin.sql:425-458, same `(select public.is_admin())` InitPlan
-- wrapping) to the six catalog tables a book graph touches. No later task in this plan owns
-- catalog admin-read policies, so this is where that gap closes. No grant changes needed:
-- `authenticated` already holds table-level SELECT on all six
-- (20260911090000_mvp_catalog_publishing.sql:245-252); these are additional, OR'd, row-level
-- policies, not a privilege change.
create policy "admin reads authors" on public.authors
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads books" on public.books
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads book localizations" on public.book_localizations
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads editions" on public.editions
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads skus" on public.skus
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads offers" on public.offers
  for select to authenticated using ((select public.is_admin()));
