-- S7: let the operations worker record an alert state for unreviewed bank transfer reports.
--
-- lib/ops/types.ts gained the 'unreviewed_manual_transfer_claim' rule, but operations_alert_state
-- enumerates its rule names in a check constraint and seeds one row per rule, and neither was
-- extended. reconcileAlerts writes a row for EVERY rule on every run, so the new name made the
-- insert fail with 23514 and POST /api/operations/run returned 500 - not only for the new rule but
-- for all of them. S7 broke S5's worker outright, including the very alert S7 added.
--
-- The list is duplicated between here and OPS_RULE_NAMES on purpose (the S5 table's own design):
-- the constraint is what stops a typo'd rule name becoming a silent, permanently inactive alert.
-- Adding a rule therefore means touching both, and an end-to-end run of e2e/seo-operations.spec.ts
-- is what proves they agree.
alter table public.operations_alert_state
  drop constraint operations_alert_state_rule_name_check;

alter table public.operations_alert_state
  add constraint operations_alert_state_rule_name_check check (rule_name in (
    'stale_epub_job', 'missing_order_entitlement',
    'unprocessed_payment_event', 'stuck_notification',
    'unreviewed_manual_transfer_claim'
  ));

-- One row per rule, as the S5 migration seeds them. on conflict so a re-applied environment is a
-- no-op rather than a failure.
insert into public.operations_alert_state (rule_name)
values ('unreviewed_manual_transfer_claim')
on conflict (rule_name) do nothing;
