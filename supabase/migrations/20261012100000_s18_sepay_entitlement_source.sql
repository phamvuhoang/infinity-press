-- S18: the SePay payment gateway (docs/superpowers/specs/2026-10-12-s18-sepay-payment-gateway-design.md 7.2).
--
-- The enum value stands alone for the reason 20260922100000 gives: Postgres refuses to use a value
-- added by `alter type ... add value` in the transaction that added it, and
-- 20261012100010_s18_sepay_provider.sql uses it immediately.
alter type public.entitlement_source add value if not exists 'sepay_payment';
