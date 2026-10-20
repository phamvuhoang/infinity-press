-- S9: the bundle schema and the offer target invariant
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 6.1).
--
-- A bundle is a curated set of books sold at one fixed price. It is modelled the way the rest of
-- the catalog already is - a status row, a localization row per locale carrying the slug and the
-- copy, and a membership table - so the public page, the sitemap, and the admin editor reuse the
-- conventions of books, authors, series and topics rather than inventing a parallel set.
--
-- The load-bearing decision here is that a bundle is priced through the EXISTING offers table
-- rather than a `bundle_offers` table beside it (spec 6.1). Market, currency, window and `active`
-- keep their meaning, so lib/catalog/price.ts and the offer admin need no new code path. The cost
-- is that `offers.sku_id` stops being mandatory, and a nullable column is a hole unless something
-- closes it: offers_exactly_one_product below is that something. Every offer names exactly one
-- product, and no writer - RPC, admin screen or future migration - can leave a row naming two or
-- naming none.
--
-- No new error codes, and no RPCs. The admin RPCs that create and publish bundles arrive in
-- 20260924120000, bundle orders in 20260924130000, and bundle coupon scoping in 20260924160000.
-- coupon_bundles is created here, ahead of the RPCs that read it, so those later migrations build
-- on a schema that is already applied everywhere.

-- Bundles ------------------------------------------------------------------------------------

-- Deliberately no canonical_slug, unlike series and topics: a bundle has no identity outside its
-- localized slugs, and the admin editor addresses it by id.
create table public.bundles (
  id uuid primary key default gen_random_uuid(),
  status public.content_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same shape as book_localizations plus the kebab-slug and non-blank-title checks that
-- 20260913100000 added to the author/topic/series localizations. unique (locale, slug) is what
-- makes /{locale}/bundles/{slug} resolvable; unique (bundle_id, locale) is what stops a bundle
-- from having two slugs in one locale, which would make the alternate-locale link ambiguous.
create table public.bundle_localizations (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.bundles(id) on delete cascade,
  locale text not null check (locale in ('vi', 'en')),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (length(trim(title)) > 0),
  subtitle text,
  description text,
  updated_at timestamptz not null default now(),
  unique (locale, slug),
  unique (bundle_id, locale)
);

-- position is the order the member books are shown in on the bundle page, and the order
-- create_bundle_order copies into order_items.position (20260924130000). Unique within the
-- bundle, so that order is total and stable rather than a tie broken by the planner.
create table public.bundle_books (
  bundle_id uuid not null references public.bundles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  position integer not null check (position > 0),
  primary key (bundle_id, book_id),
  unique (bundle_id, position)
);

create trigger bundles_touch_updated_at before update on public.bundles
  for each row execute function public.touch_updated_at();
create trigger bundle_localizations_touch_updated_at before update on public.bundle_localizations
  for each row execute function public.touch_updated_at();

-- Offers -------------------------------------------------------------------------------------

-- Every existing offer names a sku and no bundle, so the check below holds for them unchanged and
-- needs no backfill. The order matters: bundles must exist before offers can reference it, which
-- is why this block sits after the table above.
alter table public.offers alter column sku_id drop not null;
alter table public.offers add column bundle_id uuid references public.bundles(id) on delete cascade;
alter table public.offers add constraint offers_exactly_one_product check (
  (sku_id is not null)::int + (bundle_id is not null)::int = 1
);

-- The bundle counterpart of the existing unique(sku_id, market_code, currency). Partial, because
-- a plain unique constraint over a nullable column treats NULLs as distinct and so would not
-- constrain sku offers and bundle offers in the same way.
create unique index offers_bundle_market_currency_key
  on public.offers(bundle_id, market_code, currency) where bundle_id is not null;

-- Orders -------------------------------------------------------------------------------------

-- The discriminator: a non-null bundle_id means this order is a bundle purchase, which is what
-- the coupon scope resolution in 20260924160000 keys off. `on delete restrict`, not cascade - an
-- order is the record of what was sold, and retiring a bundle must never rewrite that history.
-- Retiring a bundle is a status change (archived), not a delete.
alter table public.orders add column bundle_id uuid references public.bundles(id) on delete restrict;

-- Item order within an order. The default backfills every existing single-item order to 1, which
-- is correct by construction: before S9 an order had exactly one item. create_bundle_order copies
-- bundle_books.position into it, so the order confirmation and the receipt list the member books
-- in the order the bundle page showed them.
alter table public.order_items add column position integer not null default 1 check (position > 0);
alter table public.order_items add constraint order_items_order_position_key unique (order_id, position);

-- Coupon scope -------------------------------------------------------------------------------

-- Mirrors coupon_books (20260923100000): no rows for a coupon means it is not bundle-scoped.
-- Read only from inside the coupon RPCs, which run as the owner; like coupons and coupon_books it
-- is readable by no browser role at all, so codes and their scope cannot be enumerated.
create table public.coupon_bundles (
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  bundle_id uuid not null references public.bundles(id) on delete cascade,
  primary key (coupon_id, bundle_id)
);

-- Covers -------------------------------------------------------------------------------------

-- Bundle covers reuse the public `covers` bucket and the same media_assets row shape as book
-- covers, under keys of the form bundles/{bundleId}/{uuid}.{ext}. The key shape itself is enforced
-- by admin_set_bundle_cover in 20260924120000, the way admin_set_book_cover and
-- admin_set_author_image already enforce theirs.
alter table public.media_assets drop constraint media_assets_owner_type_check;
alter table public.media_assets add constraint media_assets_owner_type_check
  check (owner_type in ('book', 'author', 'bundle'));

-- The counterpart of media_assets_one_cover_per_book: replacing a cover updates the one row.
create unique index media_assets_one_cover_per_bundle
  on public.media_assets (owner_id)
  where owner_type = 'bundle' and kind = 'cover';

-- RLS ----------------------------------------------------------------------------------------

alter table public.bundles enable row level security;
alter table public.bundle_localizations enable row level security;
alter table public.bundle_books enable row level security;
alter table public.coupon_bundles enable row level security;

-- Privileges first, because they are the part a policy cannot weaken. Browser roles get SELECT
-- and nothing else on the three public bundle tables: every bundle mutation - create, localize,
-- add or reorder members, publish, price, set the cover - goes through the definer admin RPCs in
-- 20260924120000, so there is no reason for `authenticated` to hold insert, update or delete on
-- any of them, admin or not. coupon_bundles is granted to nobody, matching coupons/coupon_books.
revoke all on public.bundles, public.bundle_localizations, public.bundle_books from public, anon, authenticated, service_role;
revoke all on public.coupon_bundles from public, anon, authenticated, service_role;

grant select on public.bundles, public.bundle_localizations, public.bundle_books to anon, authenticated;
grant select, insert, update, delete on public.bundles, public.bundle_localizations, public.bundle_books to service_role;

-- Public reads: a published bundle, its copy, and its membership. A membership row names a book
-- id and nothing else, and the public DTO queries join books.status = 'published', so a member
-- row can reveal no unpublished book's content - only that the bundle has a member, which the
-- price and the item count already say.
create policy "public read published bundles" on public.bundles
  for select to anon, authenticated
  using (status = 'published');

create policy "public read published bundle localizations" on public.bundle_localizations
  for select to anon, authenticated
  using (exists (
    select 1 from public.bundles b
    where b.id = bundle_localizations.bundle_id and b.status = 'published'
  ));

create policy "public read published bundle membership" on public.bundle_books
  for select to anon, authenticated
  using (exists (
    select 1 from public.bundles b
    where b.id = bundle_books.bundle_id and b.status = 'published'
  ));

-- Admin reads, the same (select public.is_admin()) InitPlan idiom as 20260913100000. Read-only:
-- there is no admin write policy here, because there is no admin write grant either.
create policy "admin reads bundles" on public.bundles
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads bundle localizations" on public.bundle_localizations
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads bundle membership" on public.bundle_books
  for select to authenticated using ((select public.is_admin()));

-- A published bundle's cover, on the same terms as a published book's. The column grant from
-- 20260911200000 already withholds storage_key from anon and authenticated and is not widened
-- here: an object key is not a public API contract, and admin server code reads it with
-- service_role after its authorization gate.
create policy "public read cover media of published bundles" on public.media_assets
  for select
  to anon, authenticated
  using (
    kind = 'cover'
    and owner_type = 'bundle'
    and exists (
      select 1 from public.bundles b
      where b.id = media_assets.owner_id and b.status = 'published'
    )
  );

-- The one existing browser write path that could otherwise reach a bundle: 20260913100000 grants
-- `authenticated` column-level UPDATE on offers under an "admin updates offers" policy, written
-- when every offer was a sku offer. A bundle's price is set by admin_set_bundle_offer
-- (20260924120000) together with its readiness rules, so the policy is narrowed to the rows it
-- was written for. Policies are permissive and OR together, so narrowing means replacing this one
-- rather than adding another.
drop policy "admin updates offers" on public.offers;
create policy "admin updates offers" on public.offers
  for update to authenticated
  using ((select public.is_admin()) and bundle_id is null)
  with check ((select public.is_admin()) and bundle_id is null);
