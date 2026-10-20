-- S7: the manual bank-transfer provider (docs/superpowers/specs/2026-09-21-s7-manual-payment-design.md 5.2).
--
-- The enum value stands alone in its own migration because Postgres refuses to use a value added
-- by `alter type ... add value` in the same transaction that added it, and
-- 20260922100010_manual_payment_provider.sql uses it immediately in a check constraint.
alter type public.entitlement_source add value if not exists 'manual_payment';
