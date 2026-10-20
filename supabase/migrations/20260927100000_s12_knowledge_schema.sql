-- S12: the knowledge-hub schema (docs/superpowers/specs/2026-09-21-s12-knowledge-hub-design.md
-- section 5 and docs/superpowers/plans/2026-09-22-s12-knowledge-hub.md Task 2).
--
-- Two editorial entities, ideas and articles, each modelled the way the rest of the catalog
-- already is: a status row, one localization row per locale carrying the slug and the copy, and
-- explicit join tables. One join table per pair rather than a polymorphic knowledge_relations
-- table, so every relation carries real foreign keys and plain indexes.
--
-- Stored content is typed JSON only: body_blocks is a JSON array whose block shapes are validated
-- by lib/knowledge/blocks.ts before any admin RPC writes it. No column here holds HTML.
--
-- No RPCs and no error codes here. The audited admin lifecycle (create, localize, relate,
-- publish) arrives in 20260927110000 and the published read RPCs in 20260927120000. Browser roles
-- get SELECT only, filtered by the policies below; they never write any of these tables directly.

-- Ideas --------------------------------------------------------------------------------------

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  status public.content_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- unique (locale, slug) makes /{locale}/ideas/{slug} resolvable. It is scoped to this table on
-- purpose: an article may own the same slug because its path segment is /articles/.
-- unique (idea_id, locale) keeps the alternate-locale link unambiguous.
create table public.idea_localizations (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  locale text not null check (locale in ('vi', 'en')),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  question text not null check (length(trim(question)) > 0),
  short_answer text not null check (length(trim(short_answer)) > 0),
  body_blocks jsonb not null default '[]'::jsonb check (jsonb_typeof(body_blocks) = 'array'),
  seo_title text,
  seo_description text,
  updated_at timestamptz not null default now(),
  unique (locale, slug),
  unique (idea_id, locale)
);

-- Articles -----------------------------------------------------------------------------------

-- published_at is set once, by publish_article on the first successful publish, and kept across
-- unpublish/republish so the archive order never changes. The author reference restricts
-- deletes: retiring an author is a status change, not a delete that orphans a byline.
create table public.articles (
  id uuid primary key default gen_random_uuid(),
  status public.content_status not null default 'draft',
  author_id uuid not null references public.authors(id),
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.article_localizations (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  locale text not null check (locale in ('vi', 'en')),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (length(trim(title)) > 0),
  excerpt text not null check (length(trim(excerpt)) > 0),
  body_blocks jsonb not null default '[]'::jsonb check (jsonb_typeof(body_blocks) = 'array'),
  seo_title text,
  seo_description text,
  updated_at timestamptz not null default now(),
  unique (locale, slug),
  unique (article_id, locale)
);

create index articles_author_id_idx on public.articles (author_id);

create trigger ideas_touch_updated_at before update on public.ideas
  for each row execute function public.touch_updated_at();
create trigger idea_localizations_touch_updated_at before update on public.idea_localizations
  for each row execute function public.touch_updated_at();
create trigger article_localizations_touch_updated_at before update on public.article_localizations
  for each row execute function public.touch_updated_at();

-- Relations ----------------------------------------------------------------------------------

-- Ordered relations: the pair is the key, position is the editorial order, positive and unique
-- within the parent so the order is total. Unordered topic tags are just the pair. Each table has
-- an index on the reverse direction, which is what the book and topic backlinks and the incoming
-- idea links read.
create table public.idea_books (
  idea_id uuid not null references public.ideas(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  position integer not null check (position > 0),
  primary key (idea_id, book_id),
  unique (idea_id, position)
);
create index idea_books_book_id_idx on public.idea_books (book_id);

create table public.idea_topics (
  idea_id uuid not null references public.ideas(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  primary key (idea_id, topic_id)
);
create index idea_topics_topic_id_idx on public.idea_topics (topic_id);

create table public.idea_links (
  idea_id uuid not null references public.ideas(id) on delete cascade,
  related_idea_id uuid not null references public.ideas(id) on delete cascade,
  position integer not null check (position > 0),
  primary key (idea_id, related_idea_id),
  unique (idea_id, position),
  constraint idea_links_not_self check (idea_id <> related_idea_id)
);
create index idea_links_related_idea_id_idx on public.idea_links (related_idea_id);

create table public.article_books (
  article_id uuid not null references public.articles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  position integer not null check (position > 0),
  primary key (article_id, book_id),
  unique (article_id, position)
);
create index article_books_book_id_idx on public.article_books (book_id);

create table public.article_ideas (
  article_id uuid not null references public.articles(id) on delete cascade,
  idea_id uuid not null references public.ideas(id) on delete cascade,
  position integer not null check (position > 0),
  primary key (article_id, idea_id),
  unique (article_id, position)
);
create index article_ideas_idea_id_idx on public.article_ideas (idea_id);

create table public.article_topics (
  article_id uuid not null references public.articles(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  primary key (article_id, topic_id)
);
create index article_topics_topic_id_idx on public.article_topics (topic_id);

-- Topic visibility for the relation policies ---------------------------------------------------

-- topics is not readable by anon at all, and only admins see rows as authenticated (20260911090000,
-- 20260913100000): public pages reach topics through definer RPCs. A policy subquery runs with the
-- caller's privileges, so the topic relation policies below cannot read topics directly. This
-- definer helper answers the one question they need and reveals nothing but whether a given topic
-- id is published.
create function public.knowledge_topic_is_published(p_topic_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.topics t
    where t.id = p_topic_id and t.status = 'published'
  );
$$;

revoke execute on function public.knowledge_topic_is_published(uuid) from public;
grant execute on function public.knowledge_topic_is_published(uuid) to anon, authenticated, service_role;

-- RLS ----------------------------------------------------------------------------------------

alter table public.ideas enable row level security;
alter table public.idea_localizations enable row level security;
alter table public.articles enable row level security;
alter table public.article_localizations enable row level security;
alter table public.idea_books enable row level security;
alter table public.idea_topics enable row level security;
alter table public.idea_links enable row level security;
alter table public.article_books enable row level security;
alter table public.article_ideas enable row level security;
alter table public.article_topics enable row level security;

-- Privileges first, because they are the part a policy cannot weaken. Browser roles, admins
-- included, hold SELECT and nothing else: every knowledge mutation goes through the audited
-- definer RPCs of 20260927110000. service_role keeps full DML for local fixtures and trusted
-- operations behind the application's admin gate.
revoke all on
  public.ideas,
  public.idea_localizations,
  public.articles,
  public.article_localizations,
  public.idea_books,
  public.idea_topics,
  public.idea_links,
  public.article_books,
  public.article_ideas,
  public.article_topics
from public, anon, authenticated, service_role;

grant select on
  public.ideas,
  public.idea_localizations,
  public.articles,
  public.article_localizations,
  public.idea_books,
  public.idea_topics,
  public.idea_links,
  public.article_books,
  public.article_ideas,
  public.article_topics
to anon, authenticated;

grant select, insert, update, delete on
  public.ideas,
  public.idea_localizations,
  public.articles,
  public.article_localizations,
  public.idea_books,
  public.idea_topics,
  public.idea_links,
  public.article_books,
  public.article_ideas,
  public.article_topics
to service_role;

-- Public reads. A parent and its localizations are public when the parent is published. A
-- relation row is public only when its parent AND its target are published, so a relation can
-- never reveal a draft book, idea or topic. Whether the target is localized in the requested
-- locale is checked by the public read RPCs (20260927120000), which also filter status explicitly
-- because an admin caller reads drafts under the admin policies below.
create policy "public read published ideas" on public.ideas
  for select to anon, authenticated
  using (status = 'published');

create policy "public read published idea localizations" on public.idea_localizations
  for select to anon, authenticated
  using (exists (
    select 1 from public.ideas i
    where i.id = idea_localizations.idea_id and i.status = 'published'
  ));

create policy "public read published articles" on public.articles
  for select to anon, authenticated
  using (status = 'published');

create policy "public read published article localizations" on public.article_localizations
  for select to anon, authenticated
  using (exists (
    select 1 from public.articles a
    where a.id = article_localizations.article_id and a.status = 'published'
  ));

create policy "public read published idea books" on public.idea_books
  for select to anon, authenticated
  using (
    exists (select 1 from public.ideas i where i.id = idea_books.idea_id and i.status = 'published')
    and exists (select 1 from public.books b where b.id = idea_books.book_id and b.status = 'published')
  );

create policy "public read published idea topics" on public.idea_topics
  for select to anon, authenticated
  using (
    exists (select 1 from public.ideas i where i.id = idea_topics.idea_id and i.status = 'published')
    and public.knowledge_topic_is_published(idea_topics.topic_id)
  );

create policy "public read published idea links" on public.idea_links
  for select to anon, authenticated
  using (
    exists (select 1 from public.ideas i where i.id = idea_links.idea_id and i.status = 'published')
    and exists (select 1 from public.ideas r where r.id = idea_links.related_idea_id and r.status = 'published')
  );

create policy "public read published article books" on public.article_books
  for select to anon, authenticated
  using (
    exists (select 1 from public.articles a where a.id = article_books.article_id and a.status = 'published')
    and exists (select 1 from public.books b where b.id = article_books.book_id and b.status = 'published')
  );

create policy "public read published article ideas" on public.article_ideas
  for select to anon, authenticated
  using (
    exists (select 1 from public.articles a where a.id = article_ideas.article_id and a.status = 'published')
    and exists (select 1 from public.ideas i where i.id = article_ideas.idea_id and i.status = 'published')
  );

create policy "public read published article topics" on public.article_topics
  for select to anon, authenticated
  using (
    exists (select 1 from public.articles a where a.id = article_topics.article_id and a.status = 'published')
    and public.knowledge_topic_is_published(article_topics.topic_id)
  );

-- Admin reads, the (select public.is_admin()) InitPlan idiom of 20260913100000. Read-only: there
-- is no admin write policy, because there is no write grant to browser roles either.
create policy "admin reads ideas" on public.ideas
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads idea localizations" on public.idea_localizations
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads articles" on public.articles
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads article localizations" on public.article_localizations
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads idea books" on public.idea_books
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads idea topics" on public.idea_topics
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads idea links" on public.idea_links
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads article books" on public.article_books
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads article ideas" on public.article_ideas
  for select to authenticated using ((select public.is_admin()));
create policy "admin reads article topics" on public.article_topics
  for select to authenticated using ((select public.is_admin()));
