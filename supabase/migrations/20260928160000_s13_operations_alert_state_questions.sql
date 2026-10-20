-- S13: let the operations worker record an alert state for reader questions left unanswered.
--
-- lib/ops/types.ts gained the 'stale_reader_question' rule. operations_alert_state enumerates its
-- rule names in a check constraint and seeds one row per rule, and reconcileAlerts writes a row for
-- EVERY rule on every run, so a rule name missing here makes the insert fail with 23514 and
-- POST /api/operations/run return 500 for all rules (the S7 failure that
-- 20260922150000_operations_alert_state_manual_claims.sql repaired). Extend the list and seed the
-- row in the same change as the rule.
--
-- The list is duplicated between here and OPS_RULE_NAMES on purpose: the constraint is what stops a
-- typo'd rule name becoming a silent, permanently inactive alert.
alter table public.operations_alert_state
  drop constraint operations_alert_state_rule_name_check;

alter table public.operations_alert_state
  add constraint operations_alert_state_rule_name_check check (rule_name in (
    'stale_epub_job', 'missing_order_entitlement',
    'unprocessed_payment_event', 'stuck_notification',
    'unreviewed_manual_transfer_claim', 'stale_reader_question'
  ));

-- on conflict so a re-applied environment is a no-op rather than a failure.
insert into public.operations_alert_state (rule_name)
values ('stale_reader_question')
on conflict (rule_name) do nothing;
