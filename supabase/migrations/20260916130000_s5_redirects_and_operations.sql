-- S5 operations alert state (docs/superpowers/specs/2026-09-16-s5-seo-operations-design.md 6.4,
-- 6.5, 10).
--
-- One row per operational rule. The scheduled worker (POST /api/operations/run) evaluates the
-- rules with one supplied `now`, then upserts each row through a service-role client after its
-- bearer-token gate. /admin/operations reads the rows through an admin's normal session.
--
-- fingerprint is the SHA-256 of the rule's sorted finding IDs as of the last alert decision that
-- did not fail to send: while an alert is still owed (because the provider rejected it), the row
-- keeps the previously alerted fingerprint, so the next run sees the difference and retries.
--
-- The source tables the rules read (processing_jobs, ebook_assets, editions, orders, entitlements,
-- payments, payment_events, notification_outbox) already carry admin-only select policies and
-- authenticated select grants from earlier migrations, so no source-table policy changes here.
create table public.operations_alert_state (
  rule_name text primary key check (rule_name in (
    'stale_epub_job', 'missing_order_entitlement',
    'unprocessed_payment_event', 'stuck_notification'
  )),
  active boolean not null default false,
  fingerprint text,
  first_detected_at timestamptz,
  -- Null until the first scheduled worker run, so /admin/operations can show "Not yet run"
  -- instead of a migration timestamp that looks like a scheduler evaluation.
  last_evaluated_at timestamptz,
  last_alerted_at timestamptz,
  resolved_at timestamptz
);

insert into public.operations_alert_state (rule_name)
values
  ('stale_epub_job'),
  ('missing_order_entitlement'),
  ('unprocessed_payment_event'),
  ('stuck_notification');

alter table public.operations_alert_state enable row level security;
create policy operations_alert_state_admin_select on public.operations_alert_state
  for select to authenticated using ((select public.is_admin()));

-- Explicit privileges: nothing for anon, read-only for authenticated (the policy above limits it
-- to admins), and insert/update - never delete - for service_role, which bypasses RLS and owns the
-- state transition behind the worker's bearer-token gate.
revoke all on public.operations_alert_state from anon, authenticated, service_role;
grant select on public.operations_alert_state to authenticated;
grant select, insert, update on public.operations_alert_state to service_role;

-- S5 stored public redirects (spec 7.6, 12). Proxy calls this with the public (anon) client
-- before session refresh. It returns one relative destination for an exact source path, or null.
-- It never exposes the redirect table: anon keeps no select on public.redirects, and the function
-- returns no id, source path, or timestamp. source_path is unique, so the lookup is one index probe.
create or replace function public.resolve_public_redirect(p_source_path text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.destination_path
  from public.redirects r
  where r.source_path = p_source_path
  limit 1
$$;

revoke execute on function public.resolve_public_redirect(text) from public;
grant execute on function public.resolve_public_redirect(text) to anon, authenticated;
