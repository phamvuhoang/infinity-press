-- S5: database-owned product outcome events
-- (docs/superpowers/specs/2026-09-16-s5-seo-operations-design.md 8.1, 8.3).
--
-- Three security-definer triggers write analytics_events rows in the same transaction as the
-- state change they describe, so a customer or admin action is never followed by a separate,
-- possibly-failing write to record it happened. Each insert relies on the partial unique index
-- created in 20260916110000_s5_observability_outbox.sql via
-- `on conflict (dedupe_key) where dedupe_key is not null do nothing`, so a retried or replayed
-- transition never produces a duplicate row.

-- Progress milestones: fires once per winning save (insert, or update of total_progression) on
-- reading_progress. A winning save can cross more than one threshold at once (e.g. 0.10 -> 0.76
-- crosses 25, 50, and 75 in the same row), so this inserts a set, not a single row. OLD is
-- unbound on INSERT - coalesce(old.total_progression, 0) treats "no prior figure" as 0, so a
-- first save that already reaches a threshold still counts as crossing it. A null
-- new.total_progression needs no explicit guard: `null >= m.threshold` is null (never true), so
-- the `where` clause below already yields zero candidate rows and the insert is a no-op. The
-- join to book_id mirrors save_reading_progress's own lookup in
-- 20260916100000_reader_completion.sql.
create function public.analytics_events_progress_milestone_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_id uuid;
begin
  select e.book_id into v_book_id
  from public.ebook_publications pub
  join public.ebook_assets a on a.id = pub.ebook_asset_id
  join public.editions e on e.id = a.edition_id
  where pub.id = new.publication_id;

  insert into public.analytics_events (event_name, dedupe_key, profile_id, book_id, publication_id)
  select
    m.event_name,
    'progress/' || new.profile_id::text || '/' || new.publication_id::text || '/' || m.label,
    new.profile_id,
    v_book_id,
    new.publication_id
  from (values
    ('progress_25', 0.25::numeric, '25'),
    ('progress_50', 0.50::numeric, '50'),
    ('progress_75', 0.75::numeric, '75'),
    ('progress_100', 0.99::numeric, '100')
  ) as m(event_name, threshold, label)
  where new.total_progression >= m.threshold
    and coalesce(old.total_progression, 0) < m.threshold
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return new;
end;
$$;

create trigger reading_progress_milestone_events
  after insert or update of total_progression on public.reading_progress
  for each row execute function public.analytics_events_progress_milestone_trigger();

-- Book publication: fires once per publish_book audit row. `entity_type = 'books'` matches the
-- literal publish_book itself writes in 20260913120000_book_publish_readiness.sql (the audit_logs
-- convention is the plural table name, not the singular noun) - unpublish_book and every other
-- audit_logs writer use a different action, so the WHEN clause only ever matches a real publish.
-- The dedupe key is keyed by the audit row's own id, so a hypothetical re-publish of the same book
-- later gets its own audit row and its own event, never colliding with this one.
create function public.analytics_events_book_published_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.analytics_events (event_name, dedupe_key, book_id)
  values ('book_published', 'publish/' || new.id::text, new.entity_id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return new;
end;
$$;

create trigger audit_logs_book_published_events
  after insert on public.audit_logs
  for each row
  when (new.action = 'publish_book' and new.entity_type = 'books')
  execute function public.analytics_events_book_published_trigger();

-- EPUB processing jobs: fires once per attempt per terminal-or-started state. attempt rides
-- along in the dedupe key (epub/<job-id>/<attempt>/<state>) so a retried job's second failure -
-- or second start - is a distinct row from its first, per claim_processing_job's
-- `attempt = attempt + 1` on every claim (20260911170000_processing_job_rpcs.sql).
--
-- Ruling R10: claim_processing_job's expired-lease reclaim path moves an already-'processing'
-- job from processing to processing while incrementing attempt - a real new attempt starting,
-- not a no-op. So 'processing' emits epub_job_started whenever THIS update actually changed
-- something (status or attempt), not only when status itself changed; 'completed' and 'failed'
-- are terminal and still only fire when status changes into them. The trigger's WHEN clause
-- (not `UPDATE OF status`, which fires whenever a column is merely named in the SET clause
-- regardless of whether its value changed) is what keeps a same-status-same-attempt update, or
-- an unrelated-column-only update, from invoking this function at all.
create function public.analytics_events_epub_job_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_name text;
  v_label text;
  v_book_id uuid;
begin
  if new.status = 'processing' then
    v_event_name := 'epub_job_started';
    v_label := 'started';
  elsif new.status = 'completed' and old.status is distinct from new.status then
    v_event_name := 'epub_job_completed';
    v_label := 'completed';
  elsif new.status = 'failed' and old.status is distinct from new.status then
    v_event_name := 'epub_job_failed';
    v_label := 'failed';
  else
    return new;
  end if;

  select e.book_id into v_book_id
  from public.ebook_assets a
  join public.editions e on e.id = a.edition_id
  where a.id = new.target_id;

  insert into public.analytics_events (event_name, dedupe_key, book_id, processing_job_id)
  values (
    v_event_name,
    'epub/' || new.id::text || '/' || new.attempt::text || '/' || v_label,
    v_book_id,
    new.id
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return new;
end;
$$;

create trigger processing_jobs_epub_events
  after update on public.processing_jobs
  for each row
  when (old.status is distinct from new.status or old.attempt is distinct from new.attempt)
  execute function public.analytics_events_epub_job_trigger();
