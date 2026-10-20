-- Infinity Books complete Supabase schema
-- Target: Supabase PostgreSQL
-- All application tables are prefixed with infinitybooks_.

begin;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create schema if not exists infinitybooks_private;
revoke all on schema infinitybooks_private from public, anon;
grant usage on schema infinitybooks_private to authenticated;

-- -----------------------------------------------------------------------------
-- Shared functions
-- -----------------------------------------------------------------------------

create or replace function public.infinitybooks_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Platform / localization / market configuration
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_locales (
  code text primary key,
  language_code text not null,
  region_code text,
  display_name text not null,
  native_name text not null,
  direction text not null default 'ltr' check (direction in ('ltr','rtl')),
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists infinitybooks_locales_one_default_idx
  on public.infinitybooks_locales ((is_default)) where is_default = true;

create table if not exists public.infinitybooks_markets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  default_locale_code text not null references public.infinitybooks_locales(code),
  default_currency_code char(3) not null,
  country_codes text[] not null default '{}',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_market_locales (
  market_id uuid not null references public.infinitybooks_markets(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code) on delete cascade,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (market_id, locale_code)
);

create unique index if not exists infinitybooks_market_locales_one_default_idx
  on public.infinitybooks_market_locales (market_id) where is_default = true;

create table if not exists public.infinitybooks_publishers (
  id uuid primary key default gen_random_uuid(),
  canonical_slug text not null unique,
  display_name text not null,
  legal_name text,
  website_url text,
  email text,
  phone text,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_warehouses (
  id uuid primary key default gen_random_uuid(),
  market_id uuid references public.infinitybooks_markets(id),
  code text not null unique,
  name text not null,
  country_code char(2) not null,
  city text,
  address_line1 text,
  address_line2 text,
  postal_code text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_payment_methods (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.infinitybooks_markets(id) on delete cascade,
  provider text not null,
  method_code text not null,
  display_name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (market_id, provider, method_code)
);

create table if not exists public.infinitybooks_shipping_zones (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.infinitybooks_markets(id) on delete cascade,
  name text not null,
  country_codes text[] not null default '{}',
  region_codes text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_shipping_methods (
  id uuid primary key default gen_random_uuid(),
  shipping_zone_id uuid not null references public.infinitybooks_shipping_zones(id) on delete cascade,
  code text not null,
  name text not null,
  provider text,
  price_minor bigint not null default 0 check (price_minor >= 0),
  currency_code char(3) not null,
  min_order_minor bigint,
  free_shipping_threshold_minor bigint,
  estimated_days_min integer,
  estimated_days_max integer,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shipping_zone_id, code)
);

create table if not exists public.infinitybooks_tax_rates (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.infinitybooks_markets(id) on delete cascade,
  country_code char(2),
  region_code text,
  tax_code text not null default 'standard',
  rate numeric(8,6) not null check (rate >= 0 and rate <= 1),
  is_inclusive boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Catalog and knowledge graph
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_authors (
  id uuid primary key default gen_random_uuid(),
  canonical_slug text not null unique,
  display_name text not null,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  website_url text,
  social_links jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_author_localizations (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.infinitybooks_authors(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  slug text not null,
  display_name text not null,
  short_bio text,
  bio text,
  philosophy text,
  seo_title text,
  seo_description text,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  search_tsv tsvector generated always as (
    to_tsvector('simple', coalesce(display_name,'') || ' ' || coalesce(short_bio,'') || ' ' || coalesce(bio,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (author_id, locale_code),
  unique (locale_code, slug)
);

create index if not exists infinitybooks_author_localizations_search_idx
  on public.infinitybooks_author_localizations using gin(search_tsv);
create index if not exists infinitybooks_author_localizations_name_trgm_idx
  on public.infinitybooks_author_localizations using gin(display_name gin_trgm_ops);

create table if not exists public.infinitybooks_series (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  primary_author_id uuid references public.infinitybooks_authors(id),
  status text not null default 'draft' check (status in ('draft','published','archived')),
  recommended_start_book_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_series_localizations (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.infinitybooks_series(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  slug text not null,
  name text not null,
  short_description text,
  description text,
  seo_title text,
  seo_description text,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  search_tsv tsvector generated always as (
    to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(short_description,'') || ' ' || coalesce(description,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (series_id, locale_code),
  unique (locale_code, slug)
);

create index if not exists infinitybooks_series_localizations_search_idx
  on public.infinitybooks_series_localizations using gin(search_tsv);

create table if not exists public.infinitybooks_books (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  original_language_code text not null,
  primary_author_id uuid references public.infinitybooks_authors(id),
  publisher_id uuid references public.infinitybooks_publishers(id),
  status text not null default 'draft' check (status in ('draft','review','scheduled','published','archived')),
  publication_kind text not null default 'book' check (publication_kind in ('book','essay','guide','workbook')),
  published_at timestamptz,
  first_published_at date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.infinitybooks_series
  drop constraint if exists infinitybooks_series_recommended_start_book_id_fkey;
alter table public.infinitybooks_series
  add constraint infinitybooks_series_recommended_start_book_id_fkey
  foreign key (recommended_start_book_id) references public.infinitybooks_books(id) on delete set null;

create table if not exists public.infinitybooks_book_localizations (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  slug text not null,
  title text not null,
  subtitle text,
  short_description text,
  description text,
  audience text,
  key_ideas jsonb not null default '[]'::jsonb,
  what_you_may_discover jsonb not null default '[]'::jsonb,
  purchase_note text,
  seo_title text,
  seo_description text,
  open_graph_title text,
  open_graph_description text,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  search_tsv tsvector generated always as (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(subtitle,'') || ' ' || coalesce(short_description,'') || ' ' || coalesce(description,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, locale_code),
  unique (locale_code, slug)
);

create index if not exists infinitybooks_book_localizations_search_idx
  on public.infinitybooks_book_localizations using gin(search_tsv);
create index if not exists infinitybooks_book_localizations_title_trgm_idx
  on public.infinitybooks_book_localizations using gin(title gin_trgm_ops);

create table if not exists public.infinitybooks_book_authors (
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  author_id uuid not null references public.infinitybooks_authors(id) on delete cascade,
  role text not null default 'author' check (role in ('author','coauthor','editor','translator','illustrator','contributor')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (book_id, author_id, role)
);

create table if not exists public.infinitybooks_series_books (
  series_id uuid not null references public.infinitybooks_series(id) on delete cascade,
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  sequence_number numeric(10,2),
  sort_order integer not null default 0,
  is_recommended_start boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (series_id, book_id)
);

create table if not exists public.infinitybooks_topics (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_topic_localizations (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.infinitybooks_topics(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  slug text not null,
  name text not null,
  short_description text,
  description text,
  seo_title text,
  seo_description text,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  search_tsv tsvector generated always as (
    to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(short_description,'') || ' ' || coalesce(description,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (topic_id, locale_code),
  unique (locale_code, slug)
);

create index if not exists infinitybooks_topic_localizations_search_idx
  on public.infinitybooks_topic_localizations using gin(search_tsv);

create table if not exists public.infinitybooks_concepts (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_concept_localizations (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references public.infinitybooks_concepts(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  slug text not null,
  name text not null,
  short_answer text,
  description text,
  examples jsonb not null default '[]'::jsonb,
  seo_title text,
  seo_description text,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  search_tsv tsvector generated always as (
    to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(short_answer,'') || ' ' || coalesce(description,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (concept_id, locale_code),
  unique (locale_code, slug)
);

create index if not exists infinitybooks_concept_localizations_search_idx
  on public.infinitybooks_concept_localizations using gin(search_tsv);

create table if not exists public.infinitybooks_book_topics (
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  topic_id uuid not null references public.infinitybooks_topics(id) on delete cascade,
  relation_type text not null default 'primary' check (relation_type in ('primary','secondary','mentions')),
  weight numeric(8,4) not null default 1,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (book_id, topic_id)
);

create table if not exists public.infinitybooks_book_concepts (
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  concept_id uuid not null references public.infinitybooks_concepts(id) on delete cascade,
  relation_type text not null default 'explores' check (relation_type in ('primary','explores','mentions','contrasts')),
  weight numeric(8,4) not null default 1,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (book_id, concept_id)
);

create table if not exists public.infinitybooks_book_relations (
  source_book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  target_book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  relation_type text not null default 'related' check (relation_type in ('related','precedes','follows','companion','alternative')),
  weight numeric(8,4) not null default 1,
  created_at timestamptz not null default now(),
  primary key (source_book_id, target_book_id, relation_type),
  check (source_book_id <> target_book_id)
);

-- -----------------------------------------------------------------------------
-- Editions, SKUs, offers, inventory and media
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_editions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  publisher_id uuid references public.infinitybooks_publishers(id),
  language_code text not null,
  edition_number text,
  edition_name text,
  isbn10 text,
  isbn13 text,
  publication_date date,
  page_count integer check (page_count is null or page_count > 0),
  dimensions jsonb not null default '{}'::jsonb,
  copyright_year integer,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists infinitybooks_editions_isbn10_idx
  on public.infinitybooks_editions(isbn10) where isbn10 is not null;
create unique index if not exists infinitybooks_editions_isbn13_idx
  on public.infinitybooks_editions(isbn13) where isbn13 is not null;

create table if not exists public.infinitybooks_skus (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.infinitybooks_editions(id) on delete cascade,
  sku_code text not null unique,
  format text not null check (format in ('paperback','hardcover','ebook','bundle','audiobook','other')),
  fulfillment_type text not null check (fulfillment_type in ('physical','digital','mixed','none')),
  title_override text,
  weight_grams integer check (weight_grams is null or weight_grams >= 0),
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_bundle_items (
  bundle_sku_id uuid not null references public.infinitybooks_skus(id) on delete cascade,
  child_sku_id uuid not null references public.infinitybooks_skus(id) on delete restrict,
  quantity integer not null default 1 check (quantity > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (bundle_sku_id, child_sku_id),
  check (bundle_sku_id <> child_sku_id)
);

create table if not exists public.infinitybooks_offers (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.infinitybooks_skus(id) on delete cascade,
  market_id uuid not null references public.infinitybooks_markets(id) on delete cascade,
  currency_code char(3) not null,
  price_minor bigint not null check (price_minor >= 0),
  compare_at_price_minor bigint check (compare_at_price_minor is null or compare_at_price_minor >= price_minor),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  purchase_limit_per_order integer check (purchase_limit_per_order is null or purchase_limit_per_order > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index if not exists infinitybooks_offers_lookup_idx
  on public.infinitybooks_offers(sku_id, market_id, currency_code, active, starts_at, ends_at);

create table if not exists public.infinitybooks_inventory_items (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.infinitybooks_skus(id) on delete cascade,
  warehouse_id uuid not null references public.infinitybooks_warehouses(id) on delete cascade,
  on_hand integer not null default 0 check (on_hand >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  reorder_point integer not null default 0 check (reorder_point >= 0),
  allow_backorder boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sku_id, warehouse_id),
  check (reserved <= on_hand or allow_backorder)
);

create table if not exists public.infinitybooks_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.infinitybooks_inventory_items(id) on delete cascade,
  movement_type text not null check (movement_type in ('receive','reserve','release','ship','adjust','return','damage')),
  quantity_delta integer not null,
  reference_type text,
  reference_id uuid,
  reason text,
  created_by_profile_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_media_assets (
  id uuid primary key default gen_random_uuid(),
  storage_bucket text not null,
  storage_key text not null,
  kind text not null check (kind in ('cover','thumbnail','author_portrait','gallery','article_hero','open_graph','sample','document','other')),
  mime_type text,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  checksum_sha256 text,
  width integer,
  height integer,
  alt_text text,
  focal_point jsonb not null default '{}'::jsonb,
  is_public boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_bucket, storage_key)
);

create table if not exists public.infinitybooks_book_media_assets (
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  media_asset_id uuid not null references public.infinitybooks_media_assets(id) on delete cascade,
  usage text not null default 'gallery' check (usage in ('primary_cover','secondary_cover','gallery','open_graph','other')),
  locale_code text references public.infinitybooks_locales(code),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (book_id, media_asset_id, usage)
);

create table if not exists public.infinitybooks_author_media_assets (
  author_id uuid not null references public.infinitybooks_authors(id) on delete cascade,
  media_asset_id uuid not null references public.infinitybooks_media_assets(id) on delete cascade,
  usage text not null default 'portrait' check (usage in ('portrait','hero','gallery','open_graph','other')),
  locale_code text references public.infinitybooks_locales(code),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (author_id, media_asset_id, usage)
);

-- -----------------------------------------------------------------------------
-- Editorial content, collections, excerpts and reviews
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_articles (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  primary_author_id uuid references public.infinitybooks_authors(id),
  status text not null default 'draft' check (status in ('draft','review','scheduled','published','archived')),
  article_type text not null default 'article' check (article_type in ('article','essay','guide','interview','announcement')),
  published_at timestamptz,
  scheduled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_article_localizations (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.infinitybooks_articles(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  slug text not null,
  title text not null,
  dek text,
  body_markdown text,
  body_html text,
  estimated_reading_minutes integer check (estimated_reading_minutes is null or estimated_reading_minutes > 0),
  seo_title text,
  seo_description text,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  search_tsv tsvector generated always as (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(dek,'') || ' ' || coalesce(body_markdown,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (article_id, locale_code),
  unique (locale_code, slug)
);

create index if not exists infinitybooks_article_localizations_search_idx
  on public.infinitybooks_article_localizations using gin(search_tsv);
create index if not exists infinitybooks_article_localizations_title_trgm_idx
  on public.infinitybooks_article_localizations using gin(title gin_trgm_ops);

create table if not exists public.infinitybooks_article_relations (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.infinitybooks_articles(id) on delete cascade,
  relation_type text not null check (relation_type in ('book','topic','concept','series','author')),
  book_id uuid references public.infinitybooks_books(id) on delete cascade,
  topic_id uuid references public.infinitybooks_topics(id) on delete cascade,
  concept_id uuid references public.infinitybooks_concepts(id) on delete cascade,
  series_id uuid references public.infinitybooks_series(id) on delete cascade,
  author_id uuid references public.infinitybooks_authors(id) on delete cascade,
  weight numeric(8,4) not null default 1,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  check (
    (relation_type = 'book' and book_id is not null and topic_id is null and concept_id is null and series_id is null and author_id is null) or
    (relation_type = 'topic' and topic_id is not null and book_id is null and concept_id is null and series_id is null and author_id is null) or
    (relation_type = 'concept' and concept_id is not null and book_id is null and topic_id is null and series_id is null and author_id is null) or
    (relation_type = 'series' and series_id is not null and book_id is null and topic_id is null and concept_id is null and author_id is null) or
    (relation_type = 'author' and author_id is not null and book_id is null and topic_id is null and concept_id is null and series_id is null)
  )
);

create table if not exists public.infinitybooks_article_media_assets (
  article_id uuid not null references public.infinitybooks_articles(id) on delete cascade,
  media_asset_id uuid not null references public.infinitybooks_media_assets(id) on delete cascade,
  usage text not null default 'hero' check (usage in ('hero','inline','open_graph','other')),
  locale_code text references public.infinitybooks_locales(code),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (article_id, media_asset_id, usage)
);

create table if not exists public.infinitybooks_collections (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  collection_type text not null default 'editorial' check (collection_type in ('editorial','campaign','gift','automatic')),
  starts_at timestamptz,
  ends_at timestamptz,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table if not exists public.infinitybooks_collection_localizations (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.infinitybooks_collections(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  slug text not null,
  name text not null,
  short_description text,
  description text,
  seo_title text,
  seo_description text,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (collection_id, locale_code),
  unique (locale_code, slug)
);

create table if not exists public.infinitybooks_collection_books (
  collection_id uuid not null references public.infinitybooks_collections(id) on delete cascade,
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  sort_order integer not null default 0,
  featured boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (collection_id, book_id)
);

create table if not exists public.infinitybooks_pages (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  page_type text not null default 'standard' check (page_type in ('standard','about','help','legal','landing')),
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  published_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_page_localizations (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.infinitybooks_pages(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  slug text not null,
  title text not null,
  body_markdown text,
  body_html text,
  seo_title text,
  seo_description text,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  search_tsv tsvector generated always as (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body_markdown,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (page_id, locale_code),
  unique (locale_code, slug)
);

create index if not exists infinitybooks_page_localizations_search_idx
  on public.infinitybooks_page_localizations using gin(search_tsv);

create table if not exists public.infinitybooks_excerpts (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  edition_id uuid references public.infinitybooks_editions(id) on delete set null,
  locale_code text not null references public.infinitybooks_locales(code),
  excerpt_type text not null default 'quote' check (excerpt_type in ('quote','excerpt','sample_teaser')),
  body text not null,
  source_label text,
  locator_json jsonb,
  is_public boolean not null default true,
  is_featured boolean not null default false,
  sort_order integer not null default 0,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_faqs (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  category text,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_faq_localizations (
  id uuid primary key default gen_random_uuid(),
  faq_id uuid not null references public.infinitybooks_faqs(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  question text not null,
  answer_markdown text not null,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (faq_id, locale_code)
);

create table if not exists public.infinitybooks_faq_links (
  id uuid primary key default gen_random_uuid(),
  faq_id uuid not null references public.infinitybooks_faqs(id) on delete cascade,
  entity_type text not null check (entity_type in ('book','series','topic','concept','article','page','global')),
  entity_id uuid,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (faq_id, entity_type, entity_id)
);

create table if not exists public.infinitybooks_reviews (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  profile_id uuid,
  reviewer_name text,
  reviewer_email text,
  rating smallint not null check (rating between 1 and 5),
  title text,
  body text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','spam')),
  verified_purchase boolean not null default false,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists infinitybooks_reviews_book_status_idx
  on public.infinitybooks_reviews(book_id, status, created_at desc);

-- -----------------------------------------------------------------------------
-- Profiles, identity and authorization
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text,
  email_normalized text,
  phone_normalized text,
  locale_code text references public.infinitybooks_locales(code),
  market_id uuid references public.infinitybooks_markets(id),
  avatar_url text,
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists infinitybooks_profiles_email_idx
  on public.infinitybooks_profiles(email_normalized) where email_normalized is not null;
create index if not exists infinitybooks_profiles_phone_idx
  on public.infinitybooks_profiles(phone_normalized) where phone_normalized is not null;

alter table public.infinitybooks_reviews
  drop constraint if exists infinitybooks_reviews_profile_id_fkey;
alter table public.infinitybooks_reviews
  add constraint infinitybooks_reviews_profile_id_fkey foreign key (profile_id)
  references public.infinitybooks_profiles(id) on delete set null;

alter table public.infinitybooks_inventory_movements
  drop constraint if exists infinitybooks_inventory_movements_created_by_profile_id_fkey;
alter table public.infinitybooks_inventory_movements
  add constraint infinitybooks_inventory_movements_created_by_profile_id_fkey foreign key (created_by_profile_id)
  references public.infinitybooks_profiles(id) on delete set null;

create table if not exists public.infinitybooks_customer_identities (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  identity_type text not null check (identity_type in ('email','phone')),
  normalized_value text not null,
  value_hash text not null,
  is_verified boolean not null default false,
  verified_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (identity_type, normalized_value)
);

create index if not exists infinitybooks_customer_identities_profile_idx
  on public.infinitybooks_customer_identities(profile_id);

create table if not exists public.infinitybooks_addresses (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  label text,
  recipient_name text not null,
  phone text,
  country_code char(2) not null,
  region text,
  city text,
  district text,
  ward text,
  postal_code text,
  address_line1 text not null,
  address_line2 text,
  delivery_note text,
  is_default_shipping boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists infinitybooks_addresses_one_default_shipping_idx
  on public.infinitybooks_addresses(profile_id) where is_default_shipping = true;

create table if not exists public.infinitybooks_roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_role_permissions (
  role_id uuid not null references public.infinitybooks_roles(id) on delete cascade,
  permission_id uuid not null references public.infinitybooks_permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table if not exists public.infinitybooks_profile_roles (
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  role_id uuid not null references public.infinitybooks_roles(id) on delete cascade,
  assigned_by_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (profile_id, role_id)
);

create or replace function infinitybooks_private.infinitybooks_current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.infinitybooks_profiles p
  where p.auth_user_id = (select auth.uid())
  limit 1;
$$;

create or replace function infinitybooks_private.infinitybooks_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.infinitybooks_profile_roles pr
    join public.infinitybooks_roles r on r.id = pr.role_id
    join public.infinitybooks_profiles p on p.id = pr.profile_id
    where p.auth_user_id = (select auth.uid())
      and r.key in ('super_admin','admin')
  );
$$;

create or replace function infinitybooks_private.infinitybooks_has_permission(permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select infinitybooks_private.infinitybooks_is_admin()) or exists (
    select 1
    from public.infinitybooks_profile_roles pr
    join public.infinitybooks_roles r on r.id = pr.role_id
    join public.infinitybooks_role_permissions rp on rp.role_id = r.id
    join public.infinitybooks_permissions perm on perm.id = rp.permission_id
    join public.infinitybooks_profiles p on p.id = pr.profile_id
    where p.auth_user_id = (select auth.uid())
      and perm.key = permission_key
  );
$$;

create or replace function infinitybooks_private.infinitybooks_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_email text;
  v_phone text;
begin
  v_email := nullif(lower(trim(new.email)), '');
  v_phone := nullif(regexp_replace(coalesce(new.phone,''), '\s+', '', 'g'), '');

  insert into public.infinitybooks_profiles (
    auth_user_id,
    display_name,
    email_normalized,
    phone_normalized
  ) values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    v_email,
    v_phone
  )
  on conflict (auth_user_id) do update
    set email_normalized = excluded.email_normalized,
        phone_normalized = excluded.phone_normalized,
        updated_at = now()
  returning id into v_profile_id;

  if v_email is not null then
    insert into public.infinitybooks_customer_identities (
      profile_id, identity_type, normalized_value, value_hash, is_verified, verified_at
    ) values (
      v_profile_id, 'email', v_email, md5(v_email),
      new.email_confirmed_at is not null, new.email_confirmed_at
    )
    on conflict (identity_type, normalized_value) do update
      set profile_id = coalesce(public.infinitybooks_customer_identities.profile_id, excluded.profile_id),
          is_verified = public.infinitybooks_customer_identities.is_verified or excluded.is_verified,
          verified_at = coalesce(public.infinitybooks_customer_identities.verified_at, excluded.verified_at),
          last_seen_at = now(),
          updated_at = now();
  end if;

  if v_phone is not null then
    insert into public.infinitybooks_customer_identities (
      profile_id, identity_type, normalized_value, value_hash, is_verified, verified_at
    ) values (
      v_profile_id, 'phone', v_phone, md5(v_phone),
      new.phone_confirmed_at is not null, new.phone_confirmed_at
    )
    on conflict (identity_type, normalized_value) do update
      set profile_id = coalesce(public.infinitybooks_customer_identities.profile_id, excluded.profile_id),
          is_verified = public.infinitybooks_customer_identities.is_verified or excluded.is_verified,
          verified_at = coalesce(public.infinitybooks_customer_identities.verified_at, excluded.verified_at),
          last_seen_at = now(),
          updated_at = now();
  end if;

  return new;
end;
$$;

revoke execute on function infinitybooks_private.infinitybooks_handle_new_auth_user() from public, anon, authenticated;

drop trigger if exists infinitybooks_on_auth_user_created on auth.users;
create trigger infinitybooks_on_auth_user_created
  after insert or update of email, phone, email_confirmed_at, phone_confirmed_at on auth.users
  for each row execute function infinitybooks_private.infinitybooks_handle_new_auth_user();

-- -----------------------------------------------------------------------------
-- Commerce
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_carts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  customer_identity_id uuid references public.infinitybooks_customer_identities(id) on delete set null,
  session_key uuid not null default gen_random_uuid(),
  market_id uuid not null references public.infinitybooks_markets(id),
  currency_code char(3) not null,
  status text not null default 'active' check (status in ('active','converted','abandoned','expired')),
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_key)
);

create index if not exists infinitybooks_carts_profile_idx on public.infinitybooks_carts(profile_id, status);
create index if not exists infinitybooks_carts_identity_idx on public.infinitybooks_carts(customer_identity_id, status);

create table if not exists public.infinitybooks_cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.infinitybooks_carts(id) on delete cascade,
  sku_id uuid not null references public.infinitybooks_skus(id) on delete restrict,
  quantity integer not null default 1 check (quantity > 0),
  captured_offer_id uuid references public.infinitybooks_offers(id) on delete set null,
  captured_price_minor bigint check (captured_price_minor is null or captured_price_minor >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cart_id, sku_id)
);

create table if not exists public.infinitybooks_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  customer_identity_id uuid references public.infinitybooks_customer_identities(id) on delete set null,
  cart_id uuid references public.infinitybooks_carts(id) on delete set null,
  market_id uuid not null references public.infinitybooks_markets(id),
  currency_code char(3) not null,
  status text not null default 'checkout_created' check (status in (
    'checkout_created','pending_payment','paid','fulfillment_pending','partially_fulfilled','fulfilled',
    'payment_failed','cancelled','refund_pending','partially_refunded','refunded'
  )),
  subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  shipping_minor bigint not null default 0 check (shipping_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  contact_email text,
  contact_phone text,
  placed_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  notes text,
  pricing_snapshot jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discount_minor <= subtotal_minor + shipping_minor + tax_minor),
  check (total_minor = greatest(0, subtotal_minor + shipping_minor + tax_minor - discount_minor))
);

create index if not exists infinitybooks_orders_profile_idx on public.infinitybooks_orders(profile_id, created_at desc);
create index if not exists infinitybooks_orders_identity_idx on public.infinitybooks_orders(customer_identity_id, created_at desc);
create index if not exists infinitybooks_orders_status_idx on public.infinitybooks_orders(status, created_at desc);

create or replace function public.infinitybooks_assign_order_number()
returns trigger
language plpgsql
as $$
begin
  if new.order_number is null or btrim(new.order_number) = '' then
    new.order_number := 'IB-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  end if;
  return new;
end;
$$;

drop trigger if exists infinitybooks_orders_assign_number on public.infinitybooks_orders;
create trigger infinitybooks_orders_assign_number
  before insert on public.infinitybooks_orders
  for each row execute function public.infinitybooks_assign_order_number();

create table if not exists public.infinitybooks_order_addresses (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.infinitybooks_orders(id) on delete cascade,
  address_type text not null check (address_type in ('shipping','billing')),
  recipient_name text not null,
  phone text,
  country_code char(2) not null,
  region text,
  city text,
  district text,
  ward text,
  postal_code text,
  address_line1 text not null,
  address_line2 text,
  delivery_note text,
  created_at timestamptz not null default now(),
  unique (order_id, address_type)
);

create table if not exists public.infinitybooks_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.infinitybooks_orders(id) on delete cascade,
  sku_id uuid references public.infinitybooks_skus(id) on delete set null,
  offer_id uuid references public.infinitybooks_offers(id) on delete set null,
  book_id uuid references public.infinitybooks_books(id) on delete set null,
  edition_id uuid references public.infinitybooks_editions(id) on delete set null,
  sku_code_snapshot text not null,
  title_snapshot text not null,
  format_snapshot text not null,
  fulfillment_type_snapshot text not null,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  quantity integer not null check (quantity > 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  line_total_minor bigint not null check (line_total_minor >= 0),
  metadata_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (discount_minor <= unit_price_minor * quantity + tax_minor)
);

create index if not exists infinitybooks_order_items_order_idx on public.infinitybooks_order_items(order_id);

create table if not exists public.infinitybooks_order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.infinitybooks_orders(id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text,
  actor_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.infinitybooks_orders(id) on delete cascade,
  provider text not null,
  payment_method text,
  external_payment_id text,
  external_session_id text,
  amount_minor bigint not null check (amount_minor >= 0),
  currency_code char(3) not null,
  status text not null default 'created' check (status in ('created','pending','authorized','succeeded','failed','cancelled','partially_refunded','refunded')),
  provider_status text,
  failure_code text,
  failure_message text,
  authorized_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists infinitybooks_payments_provider_external_idx
  on public.infinitybooks_payments(provider, external_payment_id)
  where external_payment_id is not null;

create table if not exists public.infinitybooks_payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references public.infinitybooks_payments(id) on delete set null,
  order_id uuid references public.infinitybooks_orders(id) on delete set null,
  provider text not null,
  provider_event_id text not null,
  event_type text,
  payload_hash text not null,
  payload jsonb not null,
  signature_valid boolean not null default false,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_result text,
  error_message text,
  unique (provider, provider_event_id)
);

create table if not exists public.infinitybooks_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.infinitybooks_orders(id) on delete cascade,
  payment_id uuid not null references public.infinitybooks_payments(id) on delete restrict,
  provider_refund_id text,
  amount_minor bigint not null check (amount_minor > 0),
  currency_code char(3) not null,
  reason text,
  status text not null default 'requested' check (status in ('requested','processing','succeeded','failed','cancelled')),
  requested_by_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists infinitybooks_refunds_provider_refund_idx
  on public.infinitybooks_refunds(payment_id, provider_refund_id)
  where provider_refund_id is not null;

create table if not exists public.infinitybooks_refund_items (
  refund_id uuid not null references public.infinitybooks_refunds(id) on delete cascade,
  order_item_id uuid not null references public.infinitybooks_order_items(id) on delete restrict,
  quantity integer not null default 1 check (quantity > 0),
  amount_minor bigint not null check (amount_minor > 0),
  created_at timestamptz not null default now(),
  primary key (refund_id, order_item_id)
);

create table if not exists public.infinitybooks_fulfillments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.infinitybooks_orders(id) on delete cascade,
  warehouse_id uuid references public.infinitybooks_warehouses(id) on delete set null,
  shipping_method_id uuid references public.infinitybooks_shipping_methods(id) on delete set null,
  provider text,
  external_fulfillment_id text,
  tracking_code text,
  tracking_url text,
  status text not null default 'pending' check (status in ('pending','processing','packed','shipped','delivered','failed','cancelled','returned')),
  shipped_at timestamptz,
  delivered_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_fulfillment_items (
  fulfillment_id uuid not null references public.infinitybooks_fulfillments(id) on delete cascade,
  order_item_id uuid not null references public.infinitybooks_order_items(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  primary key (fulfillment_id, order_item_id)
);

create table if not exists public.infinitybooks_fulfillment_events (
  id uuid primary key default gen_random_uuid(),
  fulfillment_id uuid not null references public.infinitybooks_fulfillments(id) on delete cascade,
  status text not null,
  provider_status text,
  location text,
  message text,
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Discounts and promotions
create table if not exists public.infinitybooks_coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  market_id uuid references public.infinitybooks_markets(id) on delete cascade,
  discount_type text not null check (discount_type in ('fixed','percentage','free_shipping')),
  amount_minor bigint,
  percentage numeric(7,4),
  currency_code char(3),
  min_order_minor bigint,
  max_discount_minor bigint,
  usage_limit integer,
  usage_limit_per_identity integer,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'active' check (status in ('active','inactive','expired')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (market_id, code),
  check (
    (discount_type = 'fixed' and amount_minor is not null and amount_minor > 0 and percentage is null) or
    (discount_type = 'percentage' and percentage is not null and percentage > 0 and percentage <= 1 and amount_minor is null) or
    (discount_type = 'free_shipping' and amount_minor is null and percentage is null)
  )
);

create table if not exists public.infinitybooks_coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.infinitybooks_coupons(id) on delete restrict,
  order_id uuid not null references public.infinitybooks_orders(id) on delete cascade,
  profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  customer_identity_id uuid references public.infinitybooks_customer_identities(id) on delete set null,
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  created_at timestamptz not null default now(),
  unique (coupon_id, order_id)
);

create table if not exists public.infinitybooks_promotions (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  name text not null,
  promotion_type text not null check (promotion_type in ('fixed','percentage','bundle','free_shipping','automatic')),
  config jsonb not null default '{}'::jsonb,
  priority integer not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_promotion_targets (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.infinitybooks_promotions(id) on delete cascade,
  target_type text not null check (target_type in ('market','book','edition','sku','collection','topic')),
  market_id uuid references public.infinitybooks_markets(id) on delete cascade,
  book_id uuid references public.infinitybooks_books(id) on delete cascade,
  edition_id uuid references public.infinitybooks_editions(id) on delete cascade,
  sku_id uuid references public.infinitybooks_skus(id) on delete cascade,
  collection_id uuid references public.infinitybooks_collections(id) on delete cascade,
  topic_id uuid references public.infinitybooks_topics(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_gift_cards (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  code_last4 text not null,
  currency_code char(3) not null,
  initial_balance_minor bigint not null check (initial_balance_minor >= 0),
  current_balance_minor bigint not null check (current_balance_minor >= 0),
  purchaser_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  recipient_email text,
  status text not null default 'active' check (status in ('active','redeemed','expired','cancelled')),
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_balance_minor <= initial_balance_minor)
);

create table if not exists public.infinitybooks_gift_card_transactions (
  id uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references public.infinitybooks_gift_cards(id) on delete cascade,
  order_id uuid references public.infinitybooks_orders(id) on delete set null,
  transaction_type text not null check (transaction_type in ('issue','redeem','refund','adjust','expire')),
  amount_delta_minor bigint not null,
  balance_after_minor bigint not null check (balance_after_minor >= 0),
  actor_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Ebook publishing, entitlements, library and reader
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_ebook_assets (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.infinitybooks_editions(id) on delete cascade,
  sku_id uuid references public.infinitybooks_skus(id) on delete set null,
  source_storage_bucket text not null,
  source_storage_key text not null,
  source_checksum_sha256 text not null,
  source_file_size_bytes bigint check (source_file_size_bytes is null or source_file_size_bytes >= 0),
  version integer not null default 1 check (version > 0),
  processing_status text not null default 'uploaded' check (processing_status in ('uploaded','queued','processing','ready_for_preview','published','failed','archived')),
  validation_report jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_by_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (edition_id, version),
  unique (source_storage_bucket, source_storage_key)
);

create table if not exists public.infinitybooks_ebook_publications (
  id uuid primary key default gen_random_uuid(),
  ebook_asset_id uuid not null references public.infinitybooks_ebook_assets(id) on delete cascade,
  edition_id uuid not null references public.infinitybooks_editions(id) on delete cascade,
  version integer not null check (version > 0),
  manifest_storage_bucket text not null,
  manifest_storage_key text not null,
  manifest_checksum_sha256 text,
  toc_json jsonb not null default '[]'::jsonb,
  positions_json jsonb,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'ready_for_preview' check (status in ('ready_for_preview','published','archived','failed')),
  processed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (edition_id, version),
  unique (ebook_asset_id)
);

create unique index if not exists infinitybooks_ebook_publications_one_active_idx
  on public.infinitybooks_ebook_publications(edition_id) where status = 'published';

create table if not exists public.infinitybooks_ebook_resources (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.infinitybooks_ebook_publications(id) on delete cascade,
  href text not null,
  media_type text,
  storage_bucket text not null,
  storage_key text not null,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  checksum_sha256 text,
  access_class text not null default 'paid' check (access_class in ('paid','sample','public_metadata')),
  spine_index integer,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (publication_id, href)
);

create table if not exists public.infinitybooks_chapters (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.infinitybooks_ebook_publications(id) on delete cascade,
  href text not null,
  order_index integer not null,
  title text,
  level integer not null default 1 check (level > 0),
  parent_chapter_id uuid references public.infinitybooks_chapters(id) on delete set null,
  text_content text,
  word_count integer check (word_count is null or word_count >= 0),
  search_tsv tsvector generated always as (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(text_content,''))) stored,
  locator_json jsonb,
  is_linear boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (publication_id, href),
  unique (publication_id, order_index)
);

create index if not exists infinitybooks_chapters_search_idx on public.infinitybooks_chapters using gin(search_tsv);

create table if not exists public.infinitybooks_book_samples (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  edition_id uuid not null references public.infinitybooks_editions(id) on delete cascade,
  publication_id uuid not null references public.infinitybooks_ebook_publications(id) on delete cascade,
  locale_code text not null references public.infinitybooks_locales(code),
  sample_type text not null default 'resource_allowlist' check (sample_type in ('chapter_range','resource_allowlist','progression')),
  config jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (edition_id, locale_code)
);

create table if not exists public.infinitybooks_entitlements (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.infinitybooks_profiles(id) on delete cascade,
  customer_identity_id uuid references public.infinitybooks_customer_identities(id) on delete cascade,
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  edition_id uuid references public.infinitybooks_editions(id) on delete cascade,
  sku_id uuid references public.infinitybooks_skus(id) on delete set null,
  source_order_item_id uuid references public.infinitybooks_order_items(id) on delete set null,
  source_type text not null default 'purchase' check (source_type in ('purchase','gift','promotion','admin','subscription')),
  status text not null default 'active' check (status in ('active','revoked','expired')),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (profile_id is not null or customer_identity_id is not null),
  check (expires_at is null or expires_at > granted_at)
);

create unique index if not exists infinitybooks_entitlements_source_order_item_idx
  on public.infinitybooks_entitlements(source_order_item_id, book_id, coalesce(edition_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where source_order_item_id is not null;
create index if not exists infinitybooks_entitlements_profile_idx on public.infinitybooks_entitlements(profile_id, status);
create index if not exists infinitybooks_entitlements_identity_idx on public.infinitybooks_entitlements(customer_identity_id, status);

create table if not exists public.infinitybooks_library_items (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  entitlement_id uuid references public.infinitybooks_entitlements(id) on delete set null,
  state text not null default 'unread' check (state in ('unread','reading','completed','archived')),
  added_at timestamptz not null default now(),
  last_opened_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, book_id)
);

create table if not exists public.infinitybooks_wishlist_items (
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  book_id uuid not null references public.infinitybooks_books(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, book_id)
);

create table if not exists public.infinitybooks_reading_progress (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  publication_id uuid not null references public.infinitybooks_ebook_publications(id) on delete cascade,
  locator_json jsonb not null,
  progression numeric(8,6) check (progression is null or (progression >= 0 and progression <= 1)),
  total_progression numeric(8,6) check (total_progression is null or (total_progression >= 0 and total_progression <= 1)),
  device_metadata jsonb not null default '{}'::jsonb,
  first_started_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, publication_id)
);

create table if not exists public.infinitybooks_annotations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  publication_id uuid not null references public.infinitybooks_ebook_publications(id) on delete cascade,
  chapter_id uuid references public.infinitybooks_chapters(id) on delete set null,
  annotation_type text not null check (annotation_type in ('highlight','note','bookmark')),
  locator_json jsonb not null,
  selected_text text,
  selected_text_hash text,
  note_text text,
  color text,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists infinitybooks_annotations_profile_pub_idx
  on public.infinitybooks_annotations(profile_id, publication_id, annotation_type, created_at desc)
  where is_deleted = false;

create table if not exists public.infinitybooks_reader_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.infinitybooks_profiles(id) on delete cascade,
  customer_identity_id uuid references public.infinitybooks_customer_identities(id) on delete cascade,
  entitlement_id uuid references public.infinitybooks_entitlements(id) on delete cascade,
  publication_id uuid not null references public.infinitybooks_ebook_publications(id) on delete cascade,
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active','expired','revoked')),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now(),
  check (profile_id is not null or customer_identity_id is not null)
);

create index if not exists infinitybooks_reader_sessions_expiry_idx on public.infinitybooks_reader_sessions(status, expires_at);

-- -----------------------------------------------------------------------------
-- Async jobs, outbox, notifications, newsletter
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  target_type text not null,
  target_id uuid,
  idempotency_key text unique,
  status text not null default 'queued' check (status in ('queued','running','retryable','succeeded','failed','cancelled')),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  next_attempt_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_by_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists infinitybooks_processing_jobs_worker_idx
  on public.infinitybooks_processing_jobs(status, next_attempt_at, created_at);

create table if not exists public.infinitybooks_processing_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.infinitybooks_processing_jobs(id) on delete cascade,
  event_type text not null,
  message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid,
  idempotency_key text unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','publishing','published','failed','dead_letter')),
  attempt integer not null default 0 check (attempt >= 0),
  next_attempt_at timestamptz,
  published_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists infinitybooks_outbox_events_dispatch_idx
  on public.infinitybooks_outbox_events(status, next_attempt_at, created_at);

create table if not exists public.infinitybooks_newsletter_subscriptions (
  id uuid primary key default gen_random_uuid(),
  email_normalized text not null,
  locale_code text references public.infinitybooks_locales(code),
  market_id uuid references public.infinitybooks_markets(id),
  status text not null default 'pending' check (status in ('pending','subscribed','unsubscribed','bounced')),
  source text,
  consent_text_version text,
  confirmation_token_hash text,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email_normalized)
);

create table if not exists public.infinitybooks_notification_preferences (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  channel text not null check (channel in ('email','sms','push','in_app')),
  notification_type text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, channel, notification_type)
);

create table if not exists public.infinitybooks_notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  notification_type text not null,
  title text not null,
  body text,
  action_url text,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists infinitybooks_notifications_profile_idx
  on public.infinitybooks_notifications(profile_id, read_at, created_at desc);

create table if not exists public.infinitybooks_email_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  locale_code text not null references public.infinitybooks_locales(code),
  subject_template text not null,
  body_html_template text not null,
  body_text_template text,
  status text not null default 'draft' check (status in ('draft','active','archived')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_key, locale_code, version)
);

create table if not exists public.infinitybooks_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references public.infinitybooks_email_templates(id) on delete set null,
  profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  order_id uuid references public.infinitybooks_orders(id) on delete set null,
  recipient_email text not null,
  provider text,
  provider_message_id text,
  status text not null default 'queued' check (status in ('queued','sent','delivered','bounced','failed','complained')),
  subject_snapshot text,
  payload jsonb not null default '{}'::jsonb,
  error_message text,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- SEO / LLMO / redirects / application settings / audit
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_seo_metadata (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('book','author','series','topic','concept','article','collection','page')),
  entity_id uuid not null,
  locale_code text not null references public.infinitybooks_locales(code),
  canonical_url text,
  title text,
  description text,
  robots_index boolean not null default true,
  robots_follow boolean not null default true,
  open_graph jsonb not null default '{}'::jsonb,
  twitter_card jsonb not null default '{}'::jsonb,
  structured_data_override jsonb,
  llm_summary text,
  llm_facts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (entity_type, entity_id, locale_code)
);

create table if not exists public.infinitybooks_entity_facts (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('book','author','series','topic','concept','article','collection','page')),
  entity_id uuid not null,
  locale_code text references public.infinitybooks_locales(code),
  fact_key text not null,
  fact_value text not null,
  source_url text,
  source_label text,
  confidence text not null default 'publisher_asserted' check (confidence in ('publisher_asserted','verified_primary','verified_independent','derived')),
  is_public boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists infinitybooks_entity_facts_entity_idx
  on public.infinitybooks_entity_facts(entity_type, entity_id, locale_code, sort_order);

create table if not exists public.infinitybooks_redirects (
  id uuid primary key default gen_random_uuid(),
  locale_code text references public.infinitybooks_locales(code),
  source_path text not null,
  destination_path text not null,
  status_code smallint not null default 308 check (status_code in (301,302,307,308)),
  is_active boolean not null default true,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (locale_code, source_path),
  check (source_path <> destination_path)
);

create table if not exists public.infinitybooks_application_settings (
  key text primary key,
  value jsonb not null,
  is_public boolean not null default false,
  description text,
  updated_by_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_feature_flags (
  key text primary key,
  description text,
  enabled boolean not null default false,
  rollout_percentage numeric(5,2) not null default 100 check (rollout_percentage >= 0 and rollout_percentage <= 100),
  config jsonb not null default '{}'::jsonb,
  updated_by_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_audit_logs (
  id bigserial primary key,
  actor_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  actor_auth_user_id uuid,
  actor_type text not null default 'user' check (actor_type in ('user','service','system','provider')),
  action text not null,
  entity_type text not null,
  entity_id text,
  request_id text,
  ip_hash text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists infinitybooks_audit_logs_entity_idx
  on public.infinitybooks_audit_logs(entity_type, entity_id, created_at desc);
create index if not exists infinitybooks_audit_logs_actor_idx
  on public.infinitybooks_audit_logs(actor_profile_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Merchandising, revisions and operational support
-- -----------------------------------------------------------------------------

create table if not exists public.infinitybooks_merchandising_slots (
  id uuid primary key default gen_random_uuid(),
  slot_key text not null unique,
  page_key text not null default 'home',
  locale_code text references public.infinitybooks_locales(code),
  market_id uuid references public.infinitybooks_markets(id) on delete cascade,
  title text,
  is_active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_merchandising_items (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.infinitybooks_merchandising_slots(id) on delete cascade,
  entity_type text not null check (entity_type in ('book','collection','article','topic','series','custom')),
  entity_id uuid,
  custom_payload jsonb,
  sort_order integer not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((entity_type = 'custom' and custom_payload is not null) or (entity_type <> 'custom' and entity_id is not null))
);

create table if not exists public.infinitybooks_review_votes (
  review_id uuid not null references public.infinitybooks_reviews(id) on delete cascade,
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  is_helpful boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (review_id, profile_id)
);

create table if not exists public.infinitybooks_content_revisions (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('book_localization','author_localization','series_localization','topic_localization','concept_localization','article_localization','collection_localization','page_localization')),
  entity_id uuid not null,
  locale_code text references public.infinitybooks_locales(code),
  revision_number integer not null check (revision_number > 0),
  snapshot jsonb not null,
  change_summary text,
  created_by_profile_id uuid references public.infinitybooks_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (entity_type, entity_id, revision_number)
);

create table if not exists public.infinitybooks_sitemap_runs (
  id uuid primary key default gen_random_uuid(),
  locale_code text references public.infinitybooks_locales(code),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  url_count integer check (url_count is null or url_count >= 0),
  artifact_url text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.infinitybooks_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  idempotency_key text not null,
  request_hash text,
  response_status integer,
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (scope, idempotency_key)
);

create index if not exists infinitybooks_idempotency_keys_expiry_idx
  on public.infinitybooks_idempotency_keys(expires_at);

create table if not exists public.infinitybooks_consents (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.infinitybooks_profiles(id) on delete cascade,
  customer_identity_id uuid references public.infinitybooks_customer_identities(id) on delete cascade,
  consent_type text not null,
  policy_version text not null,
  granted boolean not null,
  source text,
  ip_hash text,
  user_agent_hash text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (profile_id is not null or customer_identity_id is not null)
);

create table if not exists public.infinitybooks_data_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.infinitybooks_profiles(id) on delete cascade,
  request_type text not null check (request_type in ('export','delete','correct')),
  status text not null default 'requested' check (status in ('requested','verified','processing','completed','rejected','cancelled')),
  verification_completed_at timestamptz,
  completed_at timestamptz,
  result_storage_key text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Convenience views (security_invoker keeps underlying RLS semantics)
-- -----------------------------------------------------------------------------

create or replace view public.infinitybooks_active_offers_v
with (security_invoker = true)
as
select o.*
from public.infinitybooks_offers o
join public.infinitybooks_skus s on s.id = o.sku_id and s.active = true
join public.infinitybooks_editions e on e.id = s.edition_id and e.status = 'published'
join public.infinitybooks_books b on b.id = e.book_id and b.status = 'published'
join public.infinitybooks_markets m on m.id = o.market_id and m.is_active = true
where o.active = true
  and (o.starts_at is null or o.starts_at <= now())
  and (o.ends_at is null or o.ends_at > now());

create or replace view public.infinitybooks_public_books_v
with (security_invoker = true)
as
select
  b.id as book_id,
  b.canonical_key,
  b.original_language_code,
  bl.locale_code,
  bl.slug,
  bl.title,
  bl.subtitle,
  bl.short_description,
  b.primary_author_id,
  a.display_name as primary_author_name,
  b.published_at
from public.infinitybooks_books b
join public.infinitybooks_book_localizations bl on bl.book_id = b.id
left join public.infinitybooks_authors a on a.id = b.primary_author_id
where b.status = 'published'
  and bl.status = 'published';

-- -----------------------------------------------------------------------------
-- Generic updated_at triggers
-- -----------------------------------------------------------------------------

do $$
declare
  r record;
  trigger_name text;
begin
  for r in
    select table_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name like 'infinitybooks\_%' escape '\'
      and column_name = 'updated_at'
  loop
    trigger_name := left(r.table_name || '_set_updated_at', 63);
    execute format('drop trigger if exists %I on public.%I', trigger_name, r.table_name);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.infinitybooks_set_updated_at()',
      trigger_name, r.table_name
    );
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Row Level Security: enable on every Infinity Books table
-- -----------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename like 'infinitybooks\_%' escape '\'
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('drop policy if exists infinitybooks_admin_all on public.%I', r.tablename);
    execute format(
      'create policy infinitybooks_admin_all on public.%I for all to authenticated using ((select infinitybooks_private.infinitybooks_is_admin())) with check ((select infinitybooks_private.infinitybooks_is_admin()))',
      r.tablename
    );
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Public read policies
-- -----------------------------------------------------------------------------

create policy infinitybooks_locales_public_read
  on public.infinitybooks_locales for select to anon, authenticated
  using (is_active = true);

create policy infinitybooks_markets_public_read
  on public.infinitybooks_markets for select to anon, authenticated
  using (is_active = true);

create policy infinitybooks_market_locales_public_read
  on public.infinitybooks_market_locales for select to anon, authenticated
  using (exists (select 1 from public.infinitybooks_markets m where m.id = market_id and m.is_active));

create policy infinitybooks_publishers_public_read
  on public.infinitybooks_publishers for select to anon, authenticated
  using (status = 'active');

create policy infinitybooks_payment_methods_public_read
  on public.infinitybooks_payment_methods for select to anon, authenticated
  using (is_active = true and exists (select 1 from public.infinitybooks_markets m where m.id = market_id and m.is_active));

create policy infinitybooks_shipping_zones_public_read
  on public.infinitybooks_shipping_zones for select to anon, authenticated
  using (is_active = true);

create policy infinitybooks_shipping_methods_public_read
  on public.infinitybooks_shipping_methods for select to anon, authenticated
  using (is_active = true and exists (select 1 from public.infinitybooks_shipping_zones z where z.id = shipping_zone_id and z.is_active));

create policy infinitybooks_tax_rates_public_read
  on public.infinitybooks_tax_rates for select to anon, authenticated
  using (is_active = true and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));

create policy infinitybooks_authors_public_read
  on public.infinitybooks_authors for select to anon, authenticated
  using (status = 'published');

create policy infinitybooks_author_localizations_public_read
  on public.infinitybooks_author_localizations for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_authors a where a.id = author_id and a.status = 'published'));

create policy infinitybooks_series_public_read
  on public.infinitybooks_series for select to anon, authenticated
  using (status = 'published');

create policy infinitybooks_series_localizations_public_read
  on public.infinitybooks_series_localizations for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_series s where s.id = series_id and s.status = 'published'));

create policy infinitybooks_books_public_read
  on public.infinitybooks_books for select to anon, authenticated
  using (status = 'published' and (published_at is null or published_at <= now()));

create policy infinitybooks_book_localizations_public_read
  on public.infinitybooks_book_localizations for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_books b where b.id = book_id and b.status = 'published'));

create policy infinitybooks_book_authors_public_read
  on public.infinitybooks_book_authors for select to anon, authenticated
  using (exists (select 1 from public.infinitybooks_books b where b.id = book_id and b.status = 'published'));

create policy infinitybooks_series_books_public_read
  on public.infinitybooks_series_books for select to anon, authenticated
  using (
    exists (select 1 from public.infinitybooks_series s where s.id = series_id and s.status = 'published')
    and exists (select 1 from public.infinitybooks_books b where b.id = book_id and b.status = 'published')
  );

create policy infinitybooks_topics_public_read
  on public.infinitybooks_topics for select to anon, authenticated
  using (status = 'published');

create policy infinitybooks_topic_localizations_public_read
  on public.infinitybooks_topic_localizations for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_topics t where t.id = topic_id and t.status = 'published'));

create policy infinitybooks_concepts_public_read
  on public.infinitybooks_concepts for select to anon, authenticated
  using (status = 'published');

create policy infinitybooks_concept_localizations_public_read
  on public.infinitybooks_concept_localizations for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_concepts c where c.id = concept_id and c.status = 'published'));

create policy infinitybooks_book_topics_public_read
  on public.infinitybooks_book_topics for select to anon, authenticated
  using (exists (select 1 from public.infinitybooks_books b where b.id = book_id and b.status = 'published'));

create policy infinitybooks_book_concepts_public_read
  on public.infinitybooks_book_concepts for select to anon, authenticated
  using (exists (select 1 from public.infinitybooks_books b where b.id = book_id and b.status = 'published'));

create policy infinitybooks_book_relations_public_read
  on public.infinitybooks_book_relations for select to anon, authenticated
  using (
    exists (select 1 from public.infinitybooks_books b where b.id = source_book_id and b.status = 'published')
    and exists (select 1 from public.infinitybooks_books b where b.id = target_book_id and b.status = 'published')
  );

create policy infinitybooks_editions_public_read
  on public.infinitybooks_editions for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_books b where b.id = book_id and b.status = 'published'));

create policy infinitybooks_skus_public_read
  on public.infinitybooks_skus for select to anon, authenticated
  using (active = true and exists (select 1 from public.infinitybooks_editions e where e.id = edition_id and e.status = 'published'));

create policy infinitybooks_bundle_items_public_read
  on public.infinitybooks_bundle_items for select to anon, authenticated
  using (
    exists (select 1 from public.infinitybooks_skus s where s.id = bundle_sku_id and s.active)
    and exists (select 1 from public.infinitybooks_skus s where s.id = child_sku_id and s.active)
  );

create policy infinitybooks_offers_public_read
  on public.infinitybooks_offers for select to anon, authenticated
  using (
    active = true
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
    and exists (select 1 from public.infinitybooks_skus s where s.id = sku_id and s.active)
    and exists (select 1 from public.infinitybooks_markets m where m.id = market_id and m.is_active)
  );

create policy infinitybooks_media_assets_public_read
  on public.infinitybooks_media_assets for select to anon, authenticated
  using (is_public = true);

create policy infinitybooks_book_media_assets_public_read
  on public.infinitybooks_book_media_assets for select to anon, authenticated
  using (
    exists (select 1 from public.infinitybooks_books b where b.id = book_id and b.status = 'published')
    and exists (select 1 from public.infinitybooks_media_assets m where m.id = media_asset_id and m.is_public)
  );

create policy infinitybooks_author_media_assets_public_read
  on public.infinitybooks_author_media_assets for select to anon, authenticated
  using (
    exists (select 1 from public.infinitybooks_authors a where a.id = author_id and a.status = 'published')
    and exists (select 1 from public.infinitybooks_media_assets m where m.id = media_asset_id and m.is_public)
  );

create policy infinitybooks_articles_public_read
  on public.infinitybooks_articles for select to anon, authenticated
  using (status = 'published' and (published_at is null or published_at <= now()));

create policy infinitybooks_article_localizations_public_read
  on public.infinitybooks_article_localizations for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_articles a where a.id = article_id and a.status = 'published'));

create policy infinitybooks_article_relations_public_read
  on public.infinitybooks_article_relations for select to anon, authenticated
  using (exists (select 1 from public.infinitybooks_articles a where a.id = article_id and a.status = 'published'));

create policy infinitybooks_article_media_assets_public_read
  on public.infinitybooks_article_media_assets for select to anon, authenticated
  using (
    exists (select 1 from public.infinitybooks_articles a where a.id = article_id and a.status = 'published')
    and exists (select 1 from public.infinitybooks_media_assets m where m.id = media_asset_id and m.is_public)
  );

create policy infinitybooks_collections_public_read
  on public.infinitybooks_collections for select to anon, authenticated
  using (status = 'published' and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));

create policy infinitybooks_collection_localizations_public_read
  on public.infinitybooks_collection_localizations for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_collections c where c.id = collection_id and c.status = 'published'));

create policy infinitybooks_collection_books_public_read
  on public.infinitybooks_collection_books for select to anon, authenticated
  using (exists (select 1 from public.infinitybooks_collections c where c.id = collection_id and c.status = 'published'));

create policy infinitybooks_pages_public_read
  on public.infinitybooks_pages for select to anon, authenticated
  using (status = 'published');

create policy infinitybooks_page_localizations_public_read
  on public.infinitybooks_page_localizations for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_pages p where p.id = page_id and p.status = 'published'));

create policy infinitybooks_excerpts_public_read
  on public.infinitybooks_excerpts for select to anon, authenticated
  using (is_public = true and status = 'published' and exists (select 1 from public.infinitybooks_books b where b.id = book_id and b.status = 'published'));

create policy infinitybooks_faqs_public_read
  on public.infinitybooks_faqs for select to anon, authenticated
  using (status = 'published');

create policy infinitybooks_faq_localizations_public_read
  on public.infinitybooks_faq_localizations for select to anon, authenticated
  using (status = 'published' and exists (select 1 from public.infinitybooks_faqs f where f.id = faq_id and f.status = 'published'));

create policy infinitybooks_faq_links_public_read
  on public.infinitybooks_faq_links for select to anon, authenticated
  using (exists (select 1 from public.infinitybooks_faqs f where f.id = faq_id and f.status = 'published'));

create policy infinitybooks_reviews_public_read
  on public.infinitybooks_reviews for select to anon, authenticated
  using (status = 'approved');

create policy infinitybooks_book_samples_public_read
  on public.infinitybooks_book_samples for select to anon, authenticated
  using (status = 'published');

create policy infinitybooks_seo_metadata_public_read
  on public.infinitybooks_seo_metadata for select to anon, authenticated
  using (robots_index = true);

create policy infinitybooks_entity_facts_public_read
  on public.infinitybooks_entity_facts for select to anon, authenticated
  using (is_public = true);

create policy infinitybooks_application_settings_public_read
  on public.infinitybooks_application_settings for select to anon, authenticated
  using (is_public = true);

create policy infinitybooks_merchandising_slots_public_read
  on public.infinitybooks_merchandising_slots for select to anon, authenticated
  using (is_active = true and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));

create policy infinitybooks_merchandising_items_public_read
  on public.infinitybooks_merchandising_items for select to anon, authenticated
  using (
    exists (
      select 1 from public.infinitybooks_merchandising_slots s
      where s.id = slot_id and s.is_active
        and (s.starts_at is null or s.starts_at <= now())
        and (s.ends_at is null or s.ends_at > now())
    )
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
  );

-- -----------------------------------------------------------------------------
-- Authenticated-user policies
-- -----------------------------------------------------------------------------

create policy infinitybooks_profiles_own_read
  on public.infinitybooks_profiles for select to authenticated
  using (auth_user_id = auth.uid());

create policy infinitybooks_profiles_own_update
  on public.infinitybooks_profiles for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

create policy infinitybooks_customer_identities_own_read
  on public.infinitybooks_customer_identities for select to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_addresses_own_all
  on public.infinitybooks_addresses for all to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()))
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_carts_own_read
  on public.infinitybooks_carts for select to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_carts_own_insert
  on public.infinitybooks_carts for insert to authenticated
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_carts_own_update
  on public.infinitybooks_carts for update to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()))
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_carts_own_delete
  on public.infinitybooks_carts for delete to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_cart_items_own_all
  on public.infinitybooks_cart_items for all to authenticated
  using (exists (
    select 1 from public.infinitybooks_carts c
    where c.id = cart_id and c.profile_id = (select infinitybooks_private.infinitybooks_current_profile_id())
  ))
  with check (exists (
    select 1 from public.infinitybooks_carts c
    where c.id = cart_id and c.profile_id = (select infinitybooks_private.infinitybooks_current_profile_id())
  ));

create policy infinitybooks_orders_own_read
  on public.infinitybooks_orders for select to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_order_items_own_read
  on public.infinitybooks_order_items for select to authenticated
  using (exists (
    select 1 from public.infinitybooks_orders o
    where o.id = order_id and o.profile_id = (select infinitybooks_private.infinitybooks_current_profile_id())
  ));

create policy infinitybooks_order_addresses_own_read
  on public.infinitybooks_order_addresses for select to authenticated
  using (exists (
    select 1 from public.infinitybooks_orders o
    where o.id = order_id and o.profile_id = (select infinitybooks_private.infinitybooks_current_profile_id())
  ));

create policy infinitybooks_order_status_history_own_read
  on public.infinitybooks_order_status_history for select to authenticated
  using (exists (
    select 1 from public.infinitybooks_orders o
    where o.id = order_id and o.profile_id = (select infinitybooks_private.infinitybooks_current_profile_id())
  ));

create policy infinitybooks_fulfillments_own_read
  on public.infinitybooks_fulfillments for select to authenticated
  using (exists (
    select 1 from public.infinitybooks_orders o
    where o.id = order_id and o.profile_id = (select infinitybooks_private.infinitybooks_current_profile_id())
  ));

create policy infinitybooks_fulfillment_items_own_read
  on public.infinitybooks_fulfillment_items for select to authenticated
  using (exists (
    select 1
    from public.infinitybooks_fulfillments f
    join public.infinitybooks_orders o on o.id = f.order_id
    where f.id = fulfillment_id and o.profile_id = (select infinitybooks_private.infinitybooks_current_profile_id())
  ));

create policy infinitybooks_fulfillment_events_own_read
  on public.infinitybooks_fulfillment_events for select to authenticated
  using (exists (
    select 1
    from public.infinitybooks_fulfillments f
    join public.infinitybooks_orders o on o.id = f.order_id
    where f.id = fulfillment_id and o.profile_id = (select infinitybooks_private.infinitybooks_current_profile_id())
  ));

create policy infinitybooks_coupon_redemptions_own_read
  on public.infinitybooks_coupon_redemptions for select to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_entitlements_own_read
  on public.infinitybooks_entitlements for select to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_library_items_own_all
  on public.infinitybooks_library_items for all to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()))
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_wishlist_items_own_all
  on public.infinitybooks_wishlist_items for all to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()))
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_reading_progress_own_all
  on public.infinitybooks_reading_progress for all to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()))
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_annotations_own_all
  on public.infinitybooks_annotations for all to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()))
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_notification_preferences_own_all
  on public.infinitybooks_notification_preferences for all to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()))
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_notifications_own_read
  on public.infinitybooks_notifications for select to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_notifications_own_update
  on public.infinitybooks_notifications for update to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()))
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_reviews_own_insert
  on public.infinitybooks_reviews for insert to authenticated
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_reviews_own_update
  on public.infinitybooks_reviews for update to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()) and status = 'pending')
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_review_votes_own_all
  on public.infinitybooks_review_votes for all to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()))
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_data_requests_own_insert
  on public.infinitybooks_data_requests for insert to authenticated
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_data_requests_own_read
  on public.infinitybooks_data_requests for select to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_consents_own_read
  on public.infinitybooks_consents for select to authenticated
  using (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

create policy infinitybooks_consents_own_insert
  on public.infinitybooks_consents for insert to authenticated
  with check (profile_id = (select infinitybooks_private.infinitybooks_current_profile_id()));

-- NOTE: No anon/authenticated direct policies are intentionally created for:
-- inventory, payment_events, refunds, gift-card ledger, reader_sessions,
-- paid ebook assets/resources/chapters, processing jobs, outbox, audit logs,
-- idempotency keys, and other operational tables. Access those through trusted
-- server routes / Cloud Run using service-role credentials or admin-only paths.

-- -----------------------------------------------------------------------------
-- Grants for Data API roles (least privilege; RLS is the row boundary)
-- -----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;
grant usage on schema infinitybooks_private to authenticated;

-- Revoke broad defaults first. service_role is intentionally untouched.
do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename like 'infinitybooks\_%' escape '\'
  loop
    execute format('revoke all on table public.%I from anon, authenticated', r.tablename);
  end loop;
end $$;

-- Public catalog/config/content tables.
do $$
declare
  t text;
begin
  foreach t in array array[
    'infinitybooks_locales','infinitybooks_markets','infinitybooks_market_locales','infinitybooks_publishers',
    'infinitybooks_payment_methods','infinitybooks_shipping_zones','infinitybooks_shipping_methods','infinitybooks_tax_rates',
    'infinitybooks_authors','infinitybooks_author_localizations','infinitybooks_series','infinitybooks_series_localizations',
    'infinitybooks_books','infinitybooks_book_localizations','infinitybooks_book_authors','infinitybooks_series_books',
    'infinitybooks_topics','infinitybooks_topic_localizations','infinitybooks_concepts','infinitybooks_concept_localizations',
    'infinitybooks_book_topics','infinitybooks_book_concepts','infinitybooks_book_relations','infinitybooks_editions',
    'infinitybooks_skus','infinitybooks_bundle_items','infinitybooks_offers','infinitybooks_media_assets',
    'infinitybooks_book_media_assets','infinitybooks_author_media_assets','infinitybooks_articles','infinitybooks_article_localizations',
    'infinitybooks_article_relations','infinitybooks_article_media_assets','infinitybooks_collections','infinitybooks_collection_localizations',
    'infinitybooks_collection_books','infinitybooks_pages','infinitybooks_page_localizations','infinitybooks_excerpts',
    'infinitybooks_faqs','infinitybooks_faq_localizations','infinitybooks_faq_links','infinitybooks_reviews',
    'infinitybooks_book_samples','infinitybooks_seo_metadata','infinitybooks_entity_facts','infinitybooks_application_settings',
    'infinitybooks_merchandising_slots','infinitybooks_merchandising_items'
  ]
  loop
    execute format('grant select on table public.%I to anon, authenticated', t);
  end loop;
end $$;

-- Signed-in user-owned data. Policies still restrict rows to the current profile.
grant select, update on public.infinitybooks_profiles to authenticated;
grant select on public.infinitybooks_customer_identities to authenticated;
grant select, insert, update, delete on public.infinitybooks_addresses to authenticated;
grant select, insert, update, delete on public.infinitybooks_carts to authenticated;
grant select, insert, update, delete on public.infinitybooks_cart_items to authenticated;
grant select on public.infinitybooks_orders to authenticated;
grant select on public.infinitybooks_order_items to authenticated;
grant select on public.infinitybooks_order_addresses to authenticated;
grant select on public.infinitybooks_order_status_history to authenticated;
grant select on public.infinitybooks_fulfillments to authenticated;
grant select on public.infinitybooks_fulfillment_items to authenticated;
grant select on public.infinitybooks_fulfillment_events to authenticated;
grant select on public.infinitybooks_coupon_redemptions to authenticated;
grant select on public.infinitybooks_entitlements to authenticated;
grant select, insert, update, delete on public.infinitybooks_library_items to authenticated;
grant select, insert, update, delete on public.infinitybooks_wishlist_items to authenticated;
grant select, insert, update, delete on public.infinitybooks_reading_progress to authenticated;
grant select, insert, update, delete on public.infinitybooks_annotations to authenticated;
grant select, insert, update, delete on public.infinitybooks_notification_preferences to authenticated;
grant select, update on public.infinitybooks_notifications to authenticated;
grant insert, update on public.infinitybooks_reviews to authenticated;
grant select, insert, update, delete on public.infinitybooks_review_votes to authenticated;
grant insert, select on public.infinitybooks_data_requests to authenticated;
grant insert, select on public.infinitybooks_consents to authenticated;

grant select on public.infinitybooks_active_offers_v to anon, authenticated;
grant select on public.infinitybooks_public_books_v to anon, authenticated;

grant execute on function infinitybooks_private.infinitybooks_current_profile_id() to authenticated;
grant execute on function infinitybooks_private.infinitybooks_is_admin() to authenticated;
grant execute on function infinitybooks_private.infinitybooks_has_permission(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Optional integrity helpers
-- -----------------------------------------------------------------------------

create or replace function public.infinitybooks_validate_offer_currency()
returns trigger
language plpgsql
as $$
declare
  market_currency char(3);
begin
  select default_currency_code into market_currency
  from public.infinitybooks_markets where id = new.market_id;

  if market_currency is null then
    raise exception 'Infinity Books market % does not exist', new.market_id;
  end if;

  -- Multi-currency markets are allowed through metadata/config. This check only
  -- ensures a currency is present and normalized to uppercase ISO-like code.
  new.currency_code := upper(new.currency_code);
  return new;
end;
$$;

drop trigger if exists infinitybooks_offers_validate_currency on public.infinitybooks_offers;
create trigger infinitybooks_offers_validate_currency
  before insert or update of currency_code, market_id on public.infinitybooks_offers
  for each row execute function public.infinitybooks_validate_offer_currency();

create or replace function public.infinitybooks_normalize_coupon_code()
returns trigger
language plpgsql
as $$
begin
  new.code := upper(regexp_replace(trim(new.code), '\s+', '', 'g'));
  return new;
end;
$$;

drop trigger if exists infinitybooks_coupons_normalize_code on public.infinitybooks_coupons;
create trigger infinitybooks_coupons_normalize_code
  before insert or update of code on public.infinitybooks_coupons
  for each row execute function public.infinitybooks_normalize_coupon_code();

-- -----------------------------------------------------------------------------
-- Helpful indexes for common joins
-- -----------------------------------------------------------------------------

create index if not exists infinitybooks_books_status_idx on public.infinitybooks_books(status, published_at desc);
create index if not exists infinitybooks_editions_book_idx on public.infinitybooks_editions(book_id, language_code, status);
create index if not exists infinitybooks_skus_edition_idx on public.infinitybooks_skus(edition_id, active);
create index if not exists infinitybooks_book_topics_topic_idx on public.infinitybooks_book_topics(topic_id, book_id);
create index if not exists infinitybooks_book_concepts_concept_idx on public.infinitybooks_book_concepts(concept_id, book_id);
create index if not exists infinitybooks_series_books_book_idx on public.infinitybooks_series_books(book_id, series_id);
create index if not exists infinitybooks_article_relations_book_idx on public.infinitybooks_article_relations(book_id) where book_id is not null;
create index if not exists infinitybooks_article_relations_topic_idx on public.infinitybooks_article_relations(topic_id) where topic_id is not null;
create index if not exists infinitybooks_article_relations_concept_idx on public.infinitybooks_article_relations(concept_id) where concept_id is not null;
create index if not exists infinitybooks_order_items_book_idx on public.infinitybooks_order_items(book_id, order_id);
create index if not exists infinitybooks_payments_order_idx on public.infinitybooks_payments(order_id, status);
create index if not exists infinitybooks_refunds_order_idx on public.infinitybooks_refunds(order_id, status);
create index if not exists infinitybooks_fulfillments_order_idx on public.infinitybooks_fulfillments(order_id, status);
create index if not exists infinitybooks_library_items_profile_idx on public.infinitybooks_library_items(profile_id, state, last_opened_at desc);
create index if not exists infinitybooks_reading_progress_last_read_idx on public.infinitybooks_reading_progress(profile_id, last_read_at desc);
create index if not exists infinitybooks_ebook_resources_pub_access_idx on public.infinitybooks_ebook_resources(publication_id, access_class, spine_index);
create index if not exists infinitybooks_ebook_assets_status_idx on public.infinitybooks_ebook_assets(processing_status, created_at);

commit;
