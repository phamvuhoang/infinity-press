create extension if not exists pgcrypto;

create type public.content_status as enum ('draft', 'published', 'archived');
create type public.sku_format as enum ('ebook');
create type public.ebook_asset_status as enum ('uploading', 'queued', 'processing', 'ready_for_preview', 'failed', 'published', 'superseded');
create type public.processing_job_status as enum ('queued', 'processing', 'failed', 'completed');
create type public.publication_status as enum ('ready_for_preview', 'published', 'rejected', 'superseded');

create table public.authors (
  id uuid primary key default gen_random_uuid(),
  canonical_slug text not null unique,
  display_name text not null,
  biography text,
  status public.content_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.books (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  original_language text not null,
  primary_author_id uuid not null references public.authors(id),
  status public.content_status not null default 'draft',
  active_publication_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.book_localizations (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  locale text not null check (locale in ('vi', 'en')),
  slug text not null,
  title text not null,
  subtitle text,
  short_description text,
  description text,
  unique(locale, slug),
  unique(book_id, locale)
);

create table public.topics (
  id uuid primary key default gen_random_uuid(),
  canonical_slug text not null unique,
  name text not null,
  description text,
  status public.content_status not null default 'draft'
);

create table public.book_topics (
  book_id uuid not null references public.books(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  primary key (book_id, topic_id)
);

create table public.editions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books(id) on delete cascade,
  language_code text not null,
  isbn text,
  edition_number integer not null default 1 check (edition_number > 0),
  publication_date date,
  unique(book_id, language_code, edition_number)
);

create table public.skus (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id) on delete cascade,
  sku_code text not null unique,
  format public.sku_format not null default 'ebook',
  active boolean not null default true
);

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.skus(id) on delete cascade,
  market_code text not null check (market_code ~ '^[A-Z]{2}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_minor bigint not null check (price_minor >= 0),
  active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  unique(sku_id, market_code, currency)
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('book', 'author')),
  owner_id uuid not null,
  kind text not null check (kind in ('cover', 'author_image')),
  storage_key text not null unique,
  alt_text text not null,
  width integer check (width > 0),
  height integer check (height > 0),
  created_at timestamptz not null default now()
);

create table public.ebook_assets (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id) on delete cascade,
  source_storage_key text not null unique,
  source_checksum text,
  version integer not null check (version > 0),
  status public.ebook_asset_status not null default 'uploading',
  created_at timestamptz not null default now(),
  constraint ebook_assets_id_version_key unique (id, version)
);

create table public.ebook_publications (
  id uuid primary key default gen_random_uuid(),
  ebook_asset_id uuid not null unique,
  version integer not null check (version > 0),
  manifest_key text not null unique,
  toc_json jsonb not null default '[]'::jsonb,
  status public.publication_status not null default 'ready_for_preview',
  processed_at timestamptz not null default now(),
  foreign key (ebook_asset_id, version) references public.ebook_assets(id, version)
);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.ebook_assets(id) on delete cascade,
  status public.processing_job_status not null default 'queued',
  attempt integer not null default 0 check (attempt >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ebook_resources (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.ebook_publications(id) on delete cascade,
  href text not null,
  media_type text not null,
  storage_key text not null unique,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null,
  access_class text not null check (access_class in ('paid', 'sample'))
);

create table public.book_samples (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null unique references public.ebook_publications(id) on delete cascade,
  allowed_hrefs jsonb not null check (jsonb_typeof(allowed_hrefs) = 'array')
);

alter table public.books
  add constraint books_active_publication_fk
  foreign key (active_publication_id) references public.ebook_publications(id)
  deferrable initially deferred;

create unique index ebook_assets_edition_version_key
  on public.ebook_assets(edition_id, version);
create unique index ebook_resources_publication_href_key
  on public.ebook_resources(publication_id, href);
create unique index processing_jobs_active_target_key
  on public.processing_jobs(target_id)
  where status in ('queued', 'processing');

-- Row level security: only published catalog records are readable by anon/authenticated.
-- No policies exist for topics, book_topics, media_assets, or any publishing table, so
-- those remain fully inaccessible to anon/authenticated once RLS is enabled.
alter table public.authors enable row level security;
alter table public.books enable row level security;
alter table public.book_localizations enable row level security;
alter table public.topics enable row level security;
alter table public.book_topics enable row level security;
alter table public.editions enable row level security;
alter table public.skus enable row level security;
alter table public.offers enable row level security;
alter table public.media_assets enable row level security;
alter table public.ebook_assets enable row level security;
alter table public.ebook_publications enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.ebook_resources enable row level security;
alter table public.book_samples enable row level security;

create policy "public read published authors" on public.authors
  for select
  to anon, authenticated
  using (status = 'published');

create policy "public read published books" on public.books
  for select
  to anon, authenticated
  using (status = 'published');

create policy "public read localizations of published books" on public.book_localizations
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.books b
      where b.id = book_localizations.book_id
        and b.status = 'published'
    )
  );

create policy "public read editions of published books" on public.editions
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.books b
      where b.id = editions.book_id
        and b.status = 'published'
    )
  );

create policy "public read active skus of published books" on public.skus
  for select
  to anon, authenticated
  using (
    active
    and exists (
      select 1 from public.editions e
      join public.books b on b.id = e.book_id
      where e.id = skus.edition_id
        and b.status = 'published'
    )
  );

create policy "public read active in-window offers" on public.offers
  for select
  to anon, authenticated
  using (
    active
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
    and exists (
      select 1 from public.skus s
      join public.editions e on e.id = s.edition_id
      join public.books b on b.id = e.book_id
      where s.id = offers.sku_id
        and s.active
        and b.status = 'published'
    )
  );

grant select on
  public.authors,
  public.books,
  public.book_localizations,
  public.editions,
  public.skus,
  public.offers
to anon, authenticated;

-- Browser roles (anon, authenticated) get SELECT only on the six public catalog tables above.
-- topics, book_topics, media_assets, and every publishing table (ebook_assets,
-- ebook_publications, processing_jobs, ebook_resources, book_samples) are deliberately denied
-- SELECT below, so querying them as anon/authenticated fails outright rather than returning
-- rows. The revoke is explicit rather than relying on the image's default ACL not granting it.
revoke select on
  public.topics,
  public.book_topics,
  public.media_assets,
  public.ebook_assets,
  public.ebook_publications,
  public.processing_jobs,
  public.ebook_resources,
  public.book_samples
from anon, authenticated;

revoke insert, update, delete, truncate on
  public.authors,
  public.books,
  public.book_localizations,
  public.topics,
  public.book_topics,
  public.editions,
  public.skus,
  public.offers,
  public.media_assets,
  public.ebook_assets,
  public.ebook_publications,
  public.processing_jobs,
  public.ebook_resources,
  public.book_samples
from anon, authenticated;

-- service_role is not auto-exposed to the data API tables it doesn't already hold default ACL
-- entries for (see auto_expose_new_tables in supabase/config.toml), so trusted server code
-- (the admin client, CLI, and future security-definer RPCs) needs an explicit grant here to
-- read and write the catalog and publishing tables.
grant select, insert, update, delete on
  public.authors,
  public.books,
  public.book_localizations,
  public.topics,
  public.book_topics,
  public.editions,
  public.skus,
  public.offers,
  public.media_assets,
  public.ebook_assets,
  public.ebook_publications,
  public.processing_jobs,
  public.ebook_resources,
  public.book_samples
to service_role;
