# S7 Manual Bank-Transfer Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reader buys a paid ebook, transfers money to the company bank account, and an admin confirms receipt, which grants the entitlement and opens the reader.

**Architecture:** `manual` becomes a third `PaymentProvider` beside `disabled` and `simulator`. Admin confirmation synthesizes a payment event and applies it through the existing `apply_payment_event` RPC, so idempotency, the order state machine, and entitlement granting are reused rather than reimplemented. No new `order_status` or `payment_status` value is added; the reader-facing manual states are derived by a pure function.

**Tech Stack:** Next.js 16 App Router, React Server Components, Server Actions, Supabase (Postgres, Auth, RLS, `security definer` RPCs), TypeScript, Zod, Vitest, pgTAP, Playwright, Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-21-s7-manual-payment-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before changing Next.js code. This is not the Next.js in your training data.
- Every protected page and every Server Action calls `requireUser()` or `requireAdmin()` itself. A layout is never the only authorization control.
- Customer routes live under `/{locale}` with locales `vi` and `en`. `/admin` has no locale prefix.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` to browser code. A service-role client is created only after an admin gate passes, or in a route whose own secret gate has passed.
- Applied migrations are never edited. Every schema change is a new file in `supabase/migrations/` named `YYYYMMDDHHMMSS_<slug>.sql`, with a matching pgTAP file in `supabase/tests/` and an update to `lib/supabase/database.types.ts`.
- Every new table, policy, and RPC gets pgTAP tests including cross-user negative cases.
- Database functions that need elevated access to protected tables carry `security definer` with
  `set search_path = ''` and fully qualified object names. Pure computational helpers that read no
  table do not — definer rights there guard nothing and needlessly widen the surface that runs as
  the owner role. The codebase already draws this line: `is_admin`, `publish_book`, `search_catalog`
  and the trigger functions carry it; `catalog_normalize`, `catalog_match_score`, `touch_updated_at`,
  `audit_value_summary` and `reader_locator_is_valid` do not.
- Entitlements are granted only by the existing authenticated database functions. This plan adds no new entitlement insert.
- Run `npm run check` after every task. Run `npm run db:reset` and `npm run db:test` after every task that adds a migration. Run `npm run check:full` at the end.
- Amounts are integer minor units with an ISO 4217 currency. Never floating point.
- Preserve request IDs in server errors and operational logs: `getRequestId(await headers())`.
- User-facing copy exists in both `lib/i18n/dictionaries/vi.json` and `lib/i18n/dictionaries/en.json`. Admin copy is English only, matching the existing admin pages.
- New Postgres error codes introduced by this plan, documented in the migration header comment:
  - `EB020` — `claim_manual_transfer`: the order is not the caller's own pending manual order.
  - `EB021` — `confirm_manual_payment`: the received amount differs from the order total and the override was not given.
  - `EB022` — `confirm_manual_payment` / `reject_manual_payment`: the order is not a pending manual order.
  - `EB023` — `reject_manual_payment`: unknown outcome value.

---

### Task 1: Register the `manual` payment provider

**Files:**
- Modify: `lib/config/server-env-schema.ts`
- Create: `lib/commerce/manual.ts`
- Create: `lib/commerce/manual.test.ts`
- Modify: `lib/commerce/payment-provider.ts`
- Modify: `lib/commerce/payment-provider.test.ts`
- Modify: `lib/i18n/routes.ts`
- Modify: `lib/i18n/routes.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `PaymentProvider`, `CheckoutSessionInput`, `VerifiedPaymentEvent` from `lib/commerce/types.ts`; `ServerEnv` from `lib/config/server-env-schema.ts`.
- Produces:
  - `ServerEnv.paymentProvider: "disabled" | "simulator" | "manual"`.
  - `ServerEnv.bankTransfer: { bankCode: string; bankName: string; accountNumber: string; accountHolder: string } | null`.
  - `getCommerceRoutes(locale).checkoutTransfer(orderId: string): string` → `/{locale}/checkout/{orderId}/transfer`.
  - `class ManualProvider implements PaymentProvider` with `createSession(input) => Promise<{ redirectUrl: string }>` and `verifyEvent(request) => Promise<VerifiedPaymentEvent>`.
  - `class ManualProviderEventError extends Error`.
  - `buildVietQrImageUrl(input: { bankCode: string; accountNumber: string; accountHolder: string; amountMinor: number; reference: string }): string`.
  - `arePaymentsEnabled(env)` continues to return `true` for both `simulator` and `manual`.

- [ ] **Step 1: Write the failing tests for the manual provider**

Create `lib/commerce/manual.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ManualProvider, ManualProviderEventError, buildVietQrImageUrl } from "@/lib/commerce/manual";

describe("ManualProvider", () => {
  it("sends the reader to the internal transfer page, never off site", async () => {
    const session = await new ManualProvider().createSession({
      orderId: "11111111-1111-4111-8111-111111111111",
      locale: "vi",
    });
    expect(session.redirectUrl).toBe("/vi/checkout/11111111-1111-4111-8111-111111111111/transfer");
  });

  it("refuses every inbound request: a manual event never arrives over HTTP", async () => {
    const request = new Request("http://internal/api/payments/manual/webhook", { method: "POST", body: "{}" });
    await expect(new ManualProvider().verifyEvent(request)).rejects.toBeInstanceOf(ManualProviderEventError);
  });
});

describe("buildVietQrImageUrl", () => {
  it("builds a static image URL carrying the account, amount in major units, and reference", () => {
    const url = new URL(
      buildVietQrImageUrl({
        bankCode: "970436",
        accountNumber: "0123456789",
        accountHolder: "CONG TY INFINITY BOOKS",
        amountMinor: 129000,
        reference: "IB-7K3QX",
      }),
    );
    expect(url.origin).toBe("https://img.vietqr.io");
    expect(url.pathname).toBe("/image/970436-0123456789-compact2.png");
    expect(url.searchParams.get("amount")).toBe("129000");
    expect(url.searchParams.get("addInfo")).toBe("IB-7K3QX");
    expect(url.searchParams.get("accountName")).toBe("CONG TY INFINITY BOOKS");
  });

  it("never emits a credential or a secret in the query string", () => {
    const url = buildVietQrImageUrl({
      bankCode: "970436",
      accountNumber: "0123456789",
      accountHolder: "CONG TY INFINITY BOOKS",
      amountMinor: 1,
      reference: "IB-AAAAA",
    });
    expect(url).not.toMatch(/key|secret|token/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/commerce/manual.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/commerce/manual"`.

- [ ] **Step 3: Write `lib/commerce/manual.ts`**

```ts
import "server-only";

import type { CheckoutSessionInput, PaymentProvider, VerifiedPaymentEvent } from "@/lib/commerce/types";
import { getCommerceRoutes } from "@/lib/i18n/routes";

// The manual provider has no external system. A transfer is confirmed by an admin inside the
// application, and confirm_manual_payment synthesizes the payment event itself, so there is no
// inbound HTTP surface to verify and no signature to check.
export class ManualProviderEventError extends Error {
  constructor() {
    super("ManualProvider.verifyEvent: manual payments have no inbound webhook.");
    this.name = "ManualProviderEventError";
  }
}

// VietQR serves a static image; nothing is sent to it but the public payee details that the page
// already prints beside it. VND has no minor unit, so amountMinor is the major amount too.
export function buildVietQrImageUrl(input: {
  bankCode: string;
  accountNumber: string;
  accountHolder: string;
  amountMinor: number;
  reference: string;
}): string {
  const query = new URLSearchParams({
    amount: String(input.amountMinor),
    addInfo: input.reference,
    accountName: input.accountHolder,
  });
  return `https://img.vietqr.io/image/${input.bankCode}-${input.accountNumber}-compact2.png?${query}`;
}

export class ManualProvider implements PaymentProvider {
  async createSession(input: CheckoutSessionInput): Promise<{ redirectUrl: string }> {
    return { redirectUrl: getCommerceRoutes(input.locale).checkoutTransfer(input.orderId) };
  }

  async verifyEvent(_request: Request): Promise<VerifiedPaymentEvent> {
    throw new ManualProviderEventError();
  }
}
```

- [ ] **Step 4: Add the transfer route**

In `lib/i18n/routes.ts`, inside `getCommerceRoutes`, beside `checkoutSimulate`:

```ts
    checkoutTransfer: (orderId: string) => withLocale(locale, `/checkout/${orderId}/transfer`),
```

Add a case to `lib/i18n/routes.test.ts` mirroring the existing `checkoutSimulate` assertion:

```ts
it("builds the manual transfer path under the locale", () => {
  expect(getCommerceRoutes("vi").checkoutTransfer("abc")).toBe("/vi/checkout/abc/transfer");
});
```

- [ ] **Step 5: Widen the environment schema**

In `lib/config/server-env-schema.ts`:

```ts
  PAYMENT_PROVIDER: z.enum(["disabled", "simulator", "manual"]),
```

Add the bank fields to the schema object, after `PAYMENT_SIMULATOR_SECRET`:

```ts
  BANK_TRANSFER_BANK_CODE: z.string().regex(/^\d{6}$/).optional(),
  BANK_TRANSFER_BANK_NAME: z.string().min(1).optional(),
  BANK_TRANSFER_ACCOUNT_NUMBER: z.string().regex(/^\d{6,20}$/).optional(),
  BANK_TRANSFER_ACCOUNT_HOLDER: z.string().min(1).optional(),
```

Add this validation inside `parseServerEnv`, after the simulator secret check. The existing
`APP_ENV === "production" && PAYMENT_PROVIDER === "simulator"` rejection is left exactly as it is —
production still refuses the simulator and now accepts `manual`:

```ts
  // Manual payments print payee details on a page readers act on. A partial configuration would
  // show an incomplete instruction, so all four fields are required together.
  const bankFields = [
    parsed.BANK_TRANSFER_BANK_CODE,
    parsed.BANK_TRANSFER_BANK_NAME,
    parsed.BANK_TRANSFER_ACCOUNT_NUMBER,
    parsed.BANK_TRANSFER_ACCOUNT_HOLDER,
  ];
  if (parsed.PAYMENT_PROVIDER === "manual" && bankFields.some((value) => !value)) {
    throw new Error(
      "BANK_TRANSFER_BANK_CODE, BANK_TRANSFER_BANK_NAME, BANK_TRANSFER_ACCOUNT_NUMBER, and BANK_TRANSFER_ACCOUNT_HOLDER are required when PAYMENT_PROVIDER=manual",
    );
  }
```

And in the returned object, after `simulatorSecret`:

```ts
    bankTransfer:
      parsed.BANK_TRANSFER_BANK_CODE &&
      parsed.BANK_TRANSFER_BANK_NAME &&
      parsed.BANK_TRANSFER_ACCOUNT_NUMBER &&
      parsed.BANK_TRANSFER_ACCOUNT_HOLDER
        ? {
            bankCode: parsed.BANK_TRANSFER_BANK_CODE,
            bankName: parsed.BANK_TRANSFER_BANK_NAME,
            accountNumber: parsed.BANK_TRANSFER_ACCOUNT_NUMBER,
            accountHolder: parsed.BANK_TRANSFER_ACCOUNT_HOLDER,
          }
        : null,
```

- [ ] **Step 6: Teach the provider factory about `manual`**

In `lib/commerce/payment-provider.ts`, import `ManualProvider` and add the branch before the throw:

```ts
  if (env.paymentProvider === "manual") {
    return new ManualProvider();
  }
```

Widen the factory's parameter type to `Pick<ServerEnv, "appEnv" | "paymentProvider" | "simulatorSecret">` — it already is; no change is needed there.

Add to `lib/commerce/payment-provider.test.ts`:

```ts
it("builds a manual provider when PAYMENT_PROVIDER=manual, including in production", () => {
  const provider = getPaymentProvider({ appEnv: "production", paymentProvider: "manual", simulatorSecret: null });
  expect(provider).toBeInstanceOf(ManualProvider);
});

it("treats manual as payments enabled", () => {
  expect(arePaymentsEnabled({ paymentProvider: "manual" })).toBe(true);
});
```

Add a case to the server-env test file that already covers `parseServerEnv` (search for `Payment simulator cannot run in production` to find it):

```ts
it("refuses PAYMENT_PROVIDER=manual without complete bank details", () => {
  expect(() => parseServerEnv({ ...validEnv, PAYMENT_PROVIDER: "manual", BANK_TRANSFER_BANK_CODE: undefined })).toThrow(
    /BANK_TRANSFER_BANK_CODE/,
  );
});
```

- [ ] **Step 7: Document the variables in `.env.example`**

```
# disabled | simulator | manual. production refuses simulator and accepts manual.
PAYMENT_PROVIDER=simulator
# Required when PAYMENT_PROVIDER=manual. Napas bank code, e.g. 970436 for Vietcombank.
BANK_TRANSFER_BANK_CODE=
BANK_TRANSFER_BANK_NAME=
BANK_TRANSFER_ACCOUNT_NUMBER=
BANK_TRANSFER_ACCOUNT_HOLDER=
```

- [ ] **Step 8: Run the tests and the full check**

Run: `npx vitest run lib/commerce lib/config lib/i18n/routes.test.ts`
Expected: PASS
Run: `npm run check`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/commerce/manual.ts lib/commerce/manual.test.ts lib/commerce/payment-provider.ts lib/commerce/payment-provider.test.ts lib/config/server-env-schema.ts lib/config/server-env-schema.test.ts lib/i18n/routes.ts lib/i18n/routes.test.ts .env.example
git commit -m "feat(commerce): register the manual bank-transfer payment provider"
```

---

### Task 2: Let a payment event carry its own entitlement source

**Files:**
- Create: `supabase/migrations/20260922100000_manual_payment_provider.sql`
- Create: `supabase/tests/026_manual_payment_provider.sql`
- Modify: `lib/supabase/database.types.ts`
- Modify: `lib/data/admin-orders.ts:36` (the `sourceType` union)

**Interfaces:**
- Consumes: `public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)` as written in `supabase/migrations/20260911190000_entitlement_rpcs.sql`.
- Produces: `payments.provider` accepts `'manual'`; `public.entitlement_source` gains `'manual_payment'`; `apply_payment_event` keeps its exact signature and return shape and derives `source_type` from `p_provider`.

Read `supabase/migrations/20260911190000_entitlement_rpcs.sql` in full before writing this migration. The replacement function must be the existing body with exactly one changed line.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/026_manual_payment_provider.sql`:

```sql
begin;
select plan(6);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '71000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-provider-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select (select id from public.profiles where auth_user_id = '71000000-0000-0000-0000-000000000001') as reader_id;
grant select on t_ids to public;

insert into public.authors (id, canonical_slug, display_name) values ('73000000-0000-0000-0000-000000000001', 's7-provider-author', 'S7 Provider Author');
insert into public.books (id, canonical_key, original_language, primary_author_id) values ('72000000-0000-0000-0000-000000000001', 's7-provider-book', 'vi', '73000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code) values ('74000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code) values ('75000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-000000000001', 's7-provider-sku');

insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '76000000-0000-0000-0000-000000000001', reader_id, 'pending', 'pending', 'VN', 'VND', 129000 from t_ids;
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
values ('76000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'S7 Provider Book', 129000, 1);

-- The enum and the provider constraint both accept manual.
select has_enum_value('public', 'entitlement_source', 'manual_payment', 'entitlement_source has manual_payment');
select lives_ok(
  $$insert into public.payments (order_id, provider, status, amount_minor, currency)
    values ('76000000-0000-0000-0000-000000000001', 'manual', 'pending', 129000, 'VND')$$,
  'payments accepts provider manual');
select throws_ok(
  $$insert into public.payments (order_id, provider, status, amount_minor, currency)
    values ('76000000-0000-0000-0000-000000000001', 'bank_of_nowhere', 'pending', 129000, 'VND')$$,
  '23514', null, 'payments still refuses an unknown provider');

-- A manual event grants a manual_payment entitlement.
select lives_ok(
  $$select public.apply_payment_event('manual', 'manual:76000000-0000-0000-0000-000000000001:confirmed',
      '76000000-0000-0000-0000-000000000001', 'VCB-TXN-1', 'succeeded', 129000, 'VND', now())$$,
  'apply_payment_event accepts a manual event');
select is(
  (select source_type::text from public.entitlements where source_order_id = '76000000-0000-0000-0000-000000000001'),
  'manual_payment',
  'a manual event grants a manual_payment entitlement');

-- An unknown provider is refused rather than silently defaulting to a source type.
select throws_ok(
  $$select public.apply_payment_event('bank_of_nowhere', 'evt-x', '76000000-0000-0000-0000-000000000001',
      'x', 'succeeded', 129000, 'VND', now())$$,
  'EB014', null, 'apply_payment_event refuses an unknown provider');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — `has_enum_value` reports `manual_payment` missing.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260922100000_manual_payment_provider.sql`. Copy the entire body of
`apply_payment_event` from `supabase/migrations/20260911190000_entitlement_rpcs.sql` into the
`create or replace` below and change only the entitlement insert, as shown by the marked lines:

```sql
-- S7: the manual bank-transfer provider (docs/superpowers/specs/2026-09-21-s7-manual-payment-design.md 5.2).
--
-- New error code:
--   EB014 - apply_payment_event: the provider has no entitlement source mapping.

alter type public.entitlement_source add value if not exists 'manual_payment';

alter table public.payments drop constraint payments_provider_check;
alter table public.payments
  add constraint payments_provider_check
  check (provider in ('disabled', 'simulator', 'manual'));

-- apply_payment_event previously hard-coded source_type = 'simulated_payment'. With a second real
-- provider that is no longer true, so the source is derived from the provider. Everything else in
-- this function is byte-for-byte the S3 version: the order lock, the payment_events insert that
-- makes duplicate delivery safe, the terminal-order guard, and the amount check.
create or replace function public.apply_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_order_id uuid,
  p_external_payment_id text,
  p_status text,
  p_amount_minor bigint,
  p_currency text,
  p_occurred_at timestamptz
)
returns table (entitlement_id uuid, order_status public.order_status, payment_status public.payment_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.entitlement_source;
  -- ... every declaration from the S3 version, unchanged ...
begin
  -- NEW: resolve the entitlement source before anything else, so an unknown provider is refused
  -- before any row is locked or written.
  v_source := case p_provider
    when 'simulator' then 'simulated_payment'::public.entitlement_source
    when 'manual' then 'manual_payment'::public.entitlement_source
    else null
  end;
  if v_source is null then
    raise exception 'apply_payment_event: unknown provider %', p_provider using errcode = 'EB014';
  end if;

  -- ... the entire S3 body, unchanged, down to the success branch ...

    -- CHANGED: 'simulated_payment' becomes v_source.
    insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
    values (v_profile_id, v_book_id, v_source, p_order_id, 'active')
    on conflict (profile_id, book_id) where status = 'active' do nothing
    returning id into v_entitlement_id;

  -- ... the rest of the S3 body, unchanged ...
end;
$$;

revoke execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)
  to service_role;
```

`alter type ... add value` cannot run in the same transaction that uses the new value in some
Postgres versions. If `npm run db:reset` reports `unsafe use of new value of enum type`, split the
migration: put the `alter type` in `20260922100000_manual_payment_provider_enum.sql` on its own, and
everything else in `20260922100010_manual_payment_provider.sql`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, including the existing `008_entitlements.sql` and `018_ebook_orders.sql` suites.

- [ ] **Step 5: Regenerate the database types and widen the admin DTO**

Run: `npx supabase gen types typescript --local > lib/supabase/database.types.ts`

In `lib/data/admin-orders.ts`, change the entitlement source union:

```ts
    sourceType: "free_order" | "simulated_payment" | "manual_payment" | "admin_grant";
```

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations supabase/tests lib/supabase/database.types.ts lib/data/admin-orders.ts
git commit -m "feat(db): accept the manual provider and derive the entitlement source from it"
```

---

### Task 3: Give every order a human reference code

**Files:**
- Create: `lib/commerce/reference-code.ts`
- Create: `lib/commerce/reference-code.test.ts`
- Create: `supabase/migrations/20260922110000_order_reference_code.sql`
- Create: `supabase/tests/027_order_reference_code.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Consumes: `public.create_ebook_order(uuid)` from `supabase/migrations/20260915120000_ebook_orders.sql`.
- Produces:
  - `orders.reference_code text not null unique`, format `IB-` plus five characters from the alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
  - `ORDER_REFERENCE_PATTERN: RegExp` and `isOrderReference(value: string): boolean` in `lib/commerce/reference-code.ts`, used by the admin search in Task 10.

- [ ] **Step 1: Write the failing unit test**

Create `lib/commerce/reference-code.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { ORDER_REFERENCE_PATTERN, isOrderReference } from "@/lib/commerce/reference-code";

describe("isOrderReference", () => {
  it("accepts a well-formed reference in either case", () => {
    expect(isOrderReference("IB-7K3QX")).toBe(true);
    expect(isOrderReference("ib-7k3qx")).toBe(true);
  });

  it("rejects the ambiguous letters the alphabet excludes", () => {
    for (const code of ["IB-ILOU1", "IB-0OOO0".replace("0O", "OO")]) {
      expect(isOrderReference(code)).toBe(false);
    }
    expect(isOrderReference("IB-IIIII")).toBe(false);
    expect(isOrderReference("IB-LLLLL")).toBe(false);
    expect(isOrderReference("IB-OOOOO")).toBe(false);
    expect(isOrderReference("IB-UUUUU")).toBe(false);
  });

  it("rejects the wrong length, a missing prefix, and an email", () => {
    expect(isOrderReference("IB-7K3Q")).toBe(false);
    expect(isOrderReference("7K3QX")).toBe(false);
    expect(isOrderReference("buyer@example.test")).toBe(false);
  });

  it("anchors the pattern so it cannot match inside a longer string", () => {
    expect(ORDER_REFERENCE_PATTERN.test("prefix IB-7K3QX suffix")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/commerce/reference-code.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/commerce/reference-code.ts`**

```ts
// The order reference is the bank transfer memo: a person reads it off a screen and types it into a
// banking app. The alphabet is Crockford base32 without I, L, O, and U, so a mistyped memo is far
// less likely and no code can spell an unfortunate word. Generation lives in the database, beside
// the unique constraint that makes a retry correct; this module is the shape both sides agree on.
export const ORDER_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ORDER_REFERENCE_PATTERN = /^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/;

export function isOrderReference(value: string): boolean {
  return ORDER_REFERENCE_PATTERN.test(value.trim().toUpperCase());
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/commerce/reference-code.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing pgTAP test**

Create `supabase/tests/027_order_reference_code.sql`:

```sql
begin;
select plan(5);

select has_column('public', 'orders', 'reference_code', 'orders has reference_code');
select col_not_null('public', 'orders', 'reference_code', 'reference_code is not null');
select col_is_unique('public', 'orders', array['reference_code'], 'reference_code is unique');

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '81000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-ref-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select (select id from public.profiles where auth_user_id = '81000000-0000-0000-0000-000000000001') as reader_id;
grant select on t_ids to public;

insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '86000000-0000-0000-0000-000000000001', reader_id, 'pending', 'pending', 'VN', 'VND', 1000 from t_ids;

select matches(
  (select reference_code from public.orders where id = '86000000-0000-0000-0000-000000000001'),
  '^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$',
  'a new order gets a well-formed reference code without the caller supplying one');

select is(
  (select count(*) from public.orders where reference_code is null), 0::bigint,
  'no order is left without a reference code');

select * from finish();
rollback;
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — `orders` has no column `reference_code`.

- [ ] **Step 7: Write the migration**

Create `supabase/migrations/20260922110000_order_reference_code.sql`:

```sql
-- S7: the human-readable order reference (spec 5.3). It is the bank transfer memo, the string the
-- reader copies, and the admin's search key.

-- Crockford base32 without I, L, O and U: a memo typed from a screen into a banking app should not
-- depend on telling I from 1 or O from 0.
create function public.generate_order_reference()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'IB-' || string_agg(
    substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1), ''
  )
  from generate_series(1, 5);
$$;

alter table public.orders add column reference_code text;

-- The unique constraint comes BEFORE the backfill, deliberately. The loop below retries on a
-- unique violation, and Postgres can only raise one once a unique index exists — ordered the other
-- way round the handler is dead code and a collision aborts the whole migration at constraint
-- creation instead of self-healing. Spec 5.3 requires the backfill to precede the NOT NULL
-- constraint, which this still satisfies.
alter table public.orders add constraint orders_reference_code_key unique (reference_code);

-- Backfill before the NOT NULL and format constraints. The loop retries a collision rather than
-- assuming one cannot happen: 32^5 is large but not large enough to assume uniqueness.
do $$
declare
  v_id uuid;
  v_code text;
begin
  for v_id in select id from public.orders where reference_code is null loop
    loop
      v_code := public.generate_order_reference();
      begin
        update public.orders set reference_code = v_code where id = v_id;
        exit;
      exception when unique_violation then
        -- try another code
      end;
    end loop;
  end loop;
end;
$$;

alter table public.orders
  add constraint orders_reference_code_format
    check (reference_code ~ '^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$'),
  alter column reference_code set not null;

-- Every insert gets a code, including the ones create_ebook_order makes, without changing that
-- function's body. A trigger keeps the rule in one place for any future order-creating RPC.
create function public.orders_reference_code_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reference_code is null then
    loop
      new.reference_code := public.generate_order_reference();
      exit when not exists (select 1 from public.orders o where o.reference_code = new.reference_code);
    end loop;
  end if;
  return new;
end;
$$;

create trigger orders_set_reference_code
  before insert on public.orders
  for each row execute function public.orders_reference_code_trigger();
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS

- [ ] **Step 9: Regenerate types and run the full check**

Run: `npx supabase gen types typescript --local > lib/supabase/database.types.ts`
Run: `npm run check`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add lib/commerce/reference-code.ts lib/commerce/reference-code.test.ts supabase/migrations supabase/tests lib/supabase/database.types.ts
git commit -m "feat(commerce): give every order a human-readable reference code"
```

---

### Task 4: Derive the manual transfer state

**Files:**
- Create: `lib/commerce/manual-transfer-view.ts`
- Create: `lib/commerce/manual-transfer-view.test.ts`

**Interfaces:**
- Consumes: `OrderStatus` and `PaymentStatus` from `lib/commerce/order-state.ts`.
- Produces:
  - `type ManualTransferState = "awaiting_transfer" | "awaiting_confirmation" | "confirmed" | "declined" | "cancelled"`.
  - `resolveManualTransferState(input: { orderStatus: OrderStatus; paymentStatus: PaymentStatus; hasClaim: boolean }): ManualTransferState`.

This is the whole reason no enum value is added. Keep it pure: no imports beyond the two types.

- [ ] **Step 1: Write the failing test**

Create `lib/commerce/manual-transfer-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { resolveManualTransferState } from "@/lib/commerce/manual-transfer-view";

describe("resolveManualTransferState", () => {
  it("waits for the reader when nothing has been reported", () => {
    expect(resolveManualTransferState({ orderStatus: "pending", paymentStatus: "pending", hasClaim: false })).toBe(
      "awaiting_transfer",
    );
  });

  it("waits for us once the reader has reported a transfer", () => {
    expect(resolveManualTransferState({ orderStatus: "pending", paymentStatus: "pending", hasClaim: true })).toBe(
      "awaiting_confirmation",
    );
  });

  it("is declined when an admin marked the money as not received", () => {
    expect(resolveManualTransferState({ orderStatus: "pending", paymentStatus: "failed", hasClaim: false })).toBe(
      "declined",
    );
  });

  it("keeps declined ahead of a claim, so a stale claim cannot mask a decline", () => {
    expect(resolveManualTransferState({ orderStatus: "pending", paymentStatus: "failed", hasClaim: true })).toBe(
      "declined",
    );
  });

  it("is confirmed for a completed order regardless of the claim", () => {
    for (const hasClaim of [true, false]) {
      expect(resolveManualTransferState({ orderStatus: "completed", paymentStatus: "succeeded", hasClaim })).toBe(
        "confirmed",
      );
    }
  });

  it("is cancelled for a cancelled order, which outranks every other signal", () => {
    expect(resolveManualTransferState({ orderStatus: "cancelled", paymentStatus: "failed", hasClaim: true })).toBe(
      "cancelled",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/commerce/manual-transfer-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/commerce/manual-transfer-view.ts`:

```ts
import type { OrderStatus, PaymentStatus } from "@/lib/commerce/order-state";

// Manual transfers add no order_status or payment_status value (spec 5.4). Adding one would reopen
// the S3 transition table and its pgTAP mirror for a distinction that only ever changes a label, so
// the five reader-facing states are derived here instead.
export type ManualTransferState =
  | "awaiting_transfer"
  | "awaiting_confirmation"
  | "confirmed"
  | "declined"
  | "cancelled";

export function resolveManualTransferState(input: {
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  hasClaim: boolean;
}): ManualTransferState {
  if (input.orderStatus === "completed") return "confirmed";
  if (input.orderStatus === "cancelled") return "cancelled";
  // A decline outranks a claim: reject_manual_payment deletes the claim, but an order read taken
  // mid-transaction must still not tell the reader we are reviewing a transfer we already declined.
  if (input.paymentStatus === "failed") return "declined";
  return input.hasClaim ? "awaiting_confirmation" : "awaiting_transfer";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/commerce/manual-transfer-view.test.ts`
Expected: PASS
Run: `npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/commerce/manual-transfer-view.ts lib/commerce/manual-transfer-view.test.ts
git commit -m "feat(commerce): derive the manual transfer state from order data"
```

---

### Task 5: Let a reader report a transfer

**Files:**
- Create: `supabase/migrations/20260922120000_manual_transfer_claims.sql`
- Create: `supabase/tests/028_manual_transfer_claims.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Produces:
  - Table `public.manual_transfer_claims (order_id uuid primary key, profile_id uuid not null, claimed_at timestamptz not null default now(), note text)`.
  - `public.claim_manual_transfer(p_order_id uuid, p_note text) returns timestamptz`, executable by `authenticated`.
  - Error code `EB020` when the order is not the caller's own pending manual order.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/028_manual_transfer_claims.sql`:

```sql
begin;
select plan(9);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-claim-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's7-claim-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '91000000-0000-0000-0000-000000000001') as reader_a,
  (select id from public.profiles where auth_user_id = '91000000-0000-0000-0000-000000000002') as reader_b;
grant select on t_ids to public;

insert into public.authors (id, canonical_slug, display_name) values ('93000000-0000-0000-0000-000000000001', 's7-claim-author', 'S7 Claim Author');
insert into public.books (id, canonical_key, original_language, primary_author_id) values ('92000000-0000-0000-0000-000000000001', 's7-claim-book', 'vi', '93000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code) values ('94000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code) values ('95000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', 's7-claim-sku');

-- O1 pending manual (claimable), O2 completed (not claimable).
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select o.id::uuid, t_ids.reader_a, o.status::public.order_status, o.pay::public.payment_status, 'VN', 'VND', 129000
from t_ids, (values
  ('96000000-0000-0000-0000-000000000001', 'pending', 'pending'),
  ('96000000-0000-0000-0000-000000000002', 'completed', 'succeeded')
) as o(id, status, pay);

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
select o.id::uuid, '95000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'S7 Claim Book', 129000, 1
from (values ('96000000-0000-0000-0000-000000000001'), ('96000000-0000-0000-0000-000000000002')) as o(id);

insert into public.payments (order_id, provider, status, amount_minor, currency)
values
  ('96000000-0000-0000-0000-000000000001', 'manual', 'pending', 129000, 'VND'),
  ('96000000-0000-0000-0000-000000000002', 'manual', 'succeeded', 129000, 'VND');

-- Reader A owns O1.
set local role authenticated;
set local request.jwt.claims to '{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}';

select lives_ok(
  $$select public.claim_manual_transfer('96000000-0000-0000-0000-000000000001', 'chuyen luc 10h')$$,
  'the owner can report a transfer on a pending manual order');
select is(
  (select count(*) from public.manual_transfer_claims where order_id = '96000000-0000-0000-0000-000000000001'),
  1::bigint, 'reporting once writes one claim');
select lives_ok(
  $$select public.claim_manual_transfer('96000000-0000-0000-0000-000000000001', null)$$,
  'reporting twice does not raise');
select is(
  (select count(*) from public.manual_transfer_claims where order_id = '96000000-0000-0000-0000-000000000001'),
  1::bigint, 'reporting twice still leaves one claim');
select throws_ok(
  $$select public.claim_manual_transfer('96000000-0000-0000-0000-000000000002', null)$$,
  'EB020', null, 'a completed order cannot be claimed');
select is(
  (select count(*) from public.manual_transfer_claims), 1::bigint,
  'the owner reads their own claim');

-- Reader B owns nothing here.
set local request.jwt.claims to '{"sub":"91000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(
  $$select public.claim_manual_transfer('96000000-0000-0000-0000-000000000001', null)$$,
  'EB020', null, 'another reader cannot claim an order they do not own');
select is(
  (select count(*) from public.manual_transfer_claims), 0::bigint,
  'another reader cannot read the claim either');
select throws_ok(
  $$insert into public.manual_transfer_claims (order_id, profile_id)
    values ('96000000-0000-0000-0000-000000000001', (select reader_b from t_ids))$$,
  '42501', null, 'no role may insert into manual_transfer_claims directly');

reset role;
select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — relation `public.manual_transfer_claims` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260922120000_manual_transfer_claims.sql`:

```sql
-- S7: the reader's "I have transferred" report (spec 5.5).
--
-- New error code:
--   EB020 - claim_manual_transfer: the order is not the caller's own pending manual order.

create table public.manual_transfer_claims (
  order_id uuid primary key references public.orders(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  note text check (note is null or char_length(note) <= 500)
);

create index manual_transfer_claims_claimed_at_idx on public.manual_transfer_claims (claimed_at);

alter table public.manual_transfer_claims enable row level security;

-- Select only. claim_manual_transfer and reject_manual_payment are the only writers, and both run
-- as the table owner through security definer.
revoke all on public.manual_transfer_claims from public, anon, authenticated, service_role;
grant select on public.manual_transfer_claims to authenticated, service_role;

create policy manual_transfer_claims_owner_select on public.manual_transfer_claims
  for select to authenticated
  using (profile_id in (select p.id from public.profiles p where p.auth_user_id = auth.uid()));

create policy manual_transfer_claims_admin_select on public.manual_transfer_claims
  for select to authenticated
  using (public.is_admin());

-- Reporting a transfer is idempotent: a reader who clicks twice, or reloads the confirmation, must
-- not create a second claim or raise. The primary key does the work; on conflict makes it silent.
create function public.claim_manual_transfer(p_order_id uuid, p_note text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_claimed_at timestamptz;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'claim_manual_transfer: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.orders o
    join public.payments pay on pay.order_id = o.id and pay.provider = 'manual'
    where o.id = p_order_id and o.profile_id = v_profile_id and o.status = 'pending'
  ) then
    raise exception 'claim_manual_transfer: order % is not a claimable manual order for this reader', p_order_id
      using errcode = 'EB020';
  end if;

  insert into public.manual_transfer_claims (order_id, profile_id, note)
  values (p_order_id, v_profile_id, nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (order_id) do nothing;

  select c.claimed_at into v_claimed_at
  from public.manual_transfer_claims c where c.order_id = p_order_id;

  return v_claimed_at;
end;
$$;

revoke execute on function public.claim_manual_transfer(uuid, text) from public, anon;
grant execute on function public.claim_manual_transfer(uuid, text) to authenticated;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS

- [ ] **Step 5: Regenerate types and run the full check**

Run: `npx supabase gen types typescript --local > lib/supabase/database.types.ts`
Run: `npm run check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations supabase/tests lib/supabase/database.types.ts
git commit -m "feat(db): let a reader report a manual bank transfer"
```

---

### Task 6: Confirm and decline a manual payment

**Files:**
- Create: `supabase/migrations/20260922130000_manual_payment_decisions.sql`
- Create: `supabase/tests/029_manual_payment_decisions.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Consumes: `public.apply_payment_event(...)` as rewritten in Task 2; `public.manual_transfer_claims` from Task 5; `public.is_admin()`; `public.audit_logs`.
- Produces:
  - Tables `public.manual_payment_confirmations` and `public.manual_payment_declines`.
  - `public.confirm_manual_payment(p_order_id uuid, p_received_amount_minor bigint, p_bank_reference text, p_note text, p_accept_mismatch boolean) returns table (entitlement_id uuid, order_status public.order_status, payment_status public.payment_status)`.
  - `public.reject_manual_payment(p_order_id uuid, p_reason text, p_outcome text) returns table (order_status public.order_status, payment_status public.payment_status)`.
  - Error codes `EB021` (amount mismatch without override), `EB022` (not a pending manual order), `EB023` (unknown outcome).

Read `supabase/migrations/20260915130000_revoke_order_entitlement.sql` before writing this file: it is the closest existing example of an admin-gated `security definer` RPC that writes an audit row in the same transaction. Follow its audit-row shape exactly.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/029_manual_payment_decisions.sql`. Seed an admin, a reader, a book, and three
pending manual orders, following the pattern in `supabase/tests/019_revoke_order_entitlement.sql`,
then assert:

```sql
-- With `set local request.jwt.claims` set to the admin:
select throws_ok(
  $$select public.confirm_manual_payment('<order1>', 100000, 'VCB-1', null, false)$$,
  'EB021', null, 'a short payment is refused without an explicit override');
select is((select status::text from public.orders where id = '<order1>'), 'pending',
  'the refused confirmation changed nothing');
select is((select count(*) from public.manual_payment_confirmations), 0::bigint,
  'the refused confirmation wrote no evidence row');

select lives_ok(
  $$select public.confirm_manual_payment('<order1>', 129000, 'VCB-1', 'khop', false)$$,
  'a matching amount confirms');
select is((select status::text from public.orders where id = '<order1>'), 'completed', 'the order completes');
select is((select source_type::text from public.entitlements where source_order_id = '<order1>'),
  'manual_payment', 'the buyer gets a manual_payment entitlement');
select is((select count(*) from public.manual_transfer_claims where order_id = '<order1>'), 0::bigint,
  'confirming clears the claim so it leaves the review queue');

select lives_ok(
  $$select public.confirm_manual_payment('<order1>', 129000, 'VCB-1', null, false)$$,
  'confirming twice does not raise');
select is((select count(*) from public.entitlements where source_order_id = '<order1>'), 1::bigint,
  'confirming twice grants exactly one entitlement');

select lives_ok(
  $$select public.confirm_manual_payment('<order2>', 100000, 'VCB-2', 'thieu tien', true)$$,
  'an accepted mismatch confirms');
select is((select mismatch_accepted from public.manual_payment_confirmations where order_id = '<order2>'), true,
  'the override is recorded on the confirmation');
select is((select count(*) from public.audit_logs where action = 'manual_payment.confirmed'), 2::bigint,
  'each confirmation writes one audit row');

select lives_ok(
  $$select public.reject_manual_payment('<order3>', 'khong thay tien', 'not_received')$$,
  'not_received declines without ending the order');
select is((select status::text from public.orders where id = '<order3>'), 'pending',
  'a not_received order stays payable');
select is((select payment_status::text from public.orders where id = '<order3>'), 'failed',
  'a not_received order is marked failed');
select is((select count(*) from public.manual_transfer_claims where order_id = '<order3>'), 0::bigint,
  'declining releases the claim so the reader can report again');

select throws_ok(
  $$select public.reject_manual_payment('<order3>', '', 'not_received')$$,
  '22023', null, 'a decline requires a reason');
select throws_ok(
  $$select public.reject_manual_payment('<order3>', 'x', 'shrug')$$,
  'EB023', null, 'an unknown outcome is refused');

select lives_ok(
  $$select public.reject_manual_payment('<order3>', 'khach doi y', 'cancel')$$,
  'cancel ends the order');
select is((select status::text from public.orders where id = '<order3>'), 'cancelled', 'the order is cancelled');
select throws_ok(
  $$select public.confirm_manual_payment('<order3>', 129000, 'VCB-3', null, false)$$,
  'EB022', null, 'a cancelled order cannot be confirmed');

-- Switch request.jwt.claims to the ordinary reader:
select throws_ok(
  $$select public.confirm_manual_payment('<order2>', 129000, 'VCB-9', null, false)$$,
  '42501', null, 'a non-admin cannot confirm');
select throws_ok(
  $$select public.reject_manual_payment('<order2>', 'x', 'cancel')$$,
  '42501', null, 'a non-admin cannot decline');
select is((select count(*) from public.manual_payment_confirmations), 1::bigint,
  'a non-admin cannot read the confirmations table');
```

Replace `<order1>`, `<order2>`, `<order3>` with the seeded UUIDs and set `plan(N)` to the number of
assertions you write.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — function `public.confirm_manual_payment` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260922130000_manual_payment_decisions.sql`:

```sql
-- S7: admin confirmation and decline of a manual bank transfer (spec 5.6).
--
-- New error codes:
--   EB021 - confirm_manual_payment: received amount differs from the order total, no override given.
--   EB022 - confirm/reject_manual_payment: the order is not a pending manual order.
--   EB023 - reject_manual_payment: unknown outcome.

create table public.manual_payment_confirmations (
  order_id uuid primary key references public.orders(id) on delete cascade,
  admin_profile_id uuid not null references public.profiles(id),
  received_amount_minor bigint not null check (received_amount_minor >= 0),
  bank_reference text not null check (char_length(btrim(bank_reference)) > 0),
  note text check (note is null or char_length(note) <= 500),
  mismatch_accepted boolean not null default false,
  confirmed_at timestamptz not null default now()
);

create table public.manual_payment_declines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  sequence integer not null,
  admin_profile_id uuid not null references public.profiles(id),
  reason text not null check (char_length(btrim(reason)) > 0),
  outcome text not null check (outcome in ('not_received', 'cancel')),
  declined_at timestamptz not null default now(),
  unique (order_id, sequence)
);

alter table public.manual_payment_confirmations enable row level security;
alter table public.manual_payment_declines enable row level security;

revoke all on public.manual_payment_confirmations from public, anon, authenticated, service_role;
revoke all on public.manual_payment_declines from public, anon, authenticated, service_role;
grant select on public.manual_payment_confirmations to authenticated, service_role;
grant select on public.manual_payment_declines to authenticated, service_role;

create policy manual_payment_confirmations_admin_select on public.manual_payment_confirmations
  for select to authenticated using (public.is_admin());

-- A declined reader is shown the most recent reason on their own order page, so the owner reads
-- their own rows; everybody else needs the admin role.
create policy manual_payment_declines_owner_select on public.manual_payment_declines
  for select to authenticated
  using (order_id in (
    select o.id from public.orders o
    join public.profiles p on p.id = o.profile_id
    where p.auth_user_id = auth.uid()
  ));

create policy manual_payment_declines_admin_select on public.manual_payment_declines
  for select to authenticated using (public.is_admin());

-- Confirmation records what actually arrived, while the payment event carries the order total:
-- apply_payment_event raises EB004 on any other amount, and rightly so - the order snapshot is the
-- financial record. A difference is therefore a human decision, made once, and audited.
create function public.confirm_manual_payment(
  p_order_id uuid,
  p_received_amount_minor bigint,
  p_bank_reference text,
  p_note text,
  p_accept_mismatch boolean default false
)
returns table (entitlement_id uuid, order_status public.order_status, payment_status public.payment_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_total_minor bigint;
  v_currency text;
  v_order_status public.order_status;
  v_reference text;
  v_outcome record;
begin
  if not public.is_admin() then
    raise exception 'confirm_manual_payment: admin role required' using errcode = '42501';
  end if;
  select p.id into v_admin_id from public.profiles p where p.auth_user_id = auth.uid();

  v_reference := btrim(coalesce(p_bank_reference, ''));
  if v_reference = '' then
    raise exception 'confirm_manual_payment: a bank reference is required' using errcode = '22023';
  end if;

  select o.total_minor, o.currency, o.status
  into v_total_minor, v_currency, v_order_status
  from public.orders o
  join public.payments pay on pay.order_id = o.id and pay.provider = 'manual'
  where o.id = p_order_id
  for update of o;

  if v_total_minor is null then
    raise exception 'confirm_manual_payment: order % is not a manual order', p_order_id using errcode = 'EB022';
  end if;

  -- An already-confirmed order is idempotent, not an error: two admins may click at once.
  if v_order_status = 'completed' then
    select e.id, o.status, o.payment_status into v_outcome
    from public.orders o
    left join public.entitlements e on e.source_order_id = o.id and e.status = 'active'
    where o.id = p_order_id;
    return query select v_outcome.id, v_outcome.status, v_outcome.payment_status;
    return;
  end if;

  if v_order_status <> 'pending' then
    raise exception 'confirm_manual_payment: order % is %, not pending', p_order_id, v_order_status
      using errcode = 'EB022';
  end if;

  if p_received_amount_minor <> v_total_minor and not coalesce(p_accept_mismatch, false) then
    raise exception 'confirm_manual_payment: received % but the order total is %',
      p_received_amount_minor, v_total_minor using errcode = 'EB021';
  end if;

  insert into public.manual_payment_confirmations
    (order_id, admin_profile_id, received_amount_minor, bank_reference, note, mismatch_accepted)
  values
    (p_order_id, v_admin_id, p_received_amount_minor, v_reference,
     nullif(btrim(coalesce(p_note, '')), ''), p_received_amount_minor <> v_total_minor)
  on conflict (order_id) do nothing;

  -- The one place money becomes access. The event ID is derived from the order, so a second
  -- confirmation replays into apply_payment_event's no-op branch instead of granting again.
  return query
  select *
  from public.apply_payment_event(
    'manual',
    'manual:' || p_order_id::text || ':confirmed',
    p_order_id,
    v_reference,
    'succeeded',
    v_total_minor,
    v_currency,
    now()
  );

  delete from public.manual_transfer_claims where order_id = p_order_id;

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, summary)
  values (v_admin_id, 'manual_payment.confirmed', 'order', p_order_id,
    jsonb_build_object(
      'received_amount_minor', p_received_amount_minor,
      'order_total_minor', v_total_minor,
      'bank_reference', v_reference,
      'mismatch_accepted', p_received_amount_minor <> v_total_minor
    ));
end;
$$;

create function public.reject_manual_payment(p_order_id uuid, p_reason text, p_outcome text)
returns table (order_status public.order_status, payment_status public.payment_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid;
  v_reason text;
  v_total_minor bigint;
  v_currency text;
  v_order_status public.order_status;
  v_sequence integer;
  v_event_id text;
  v_result record;
begin
  if not public.is_admin() then
    raise exception 'reject_manual_payment: admin role required' using errcode = '42501';
  end if;
  select p.id into v_admin_id from public.profiles p where p.auth_user_id = auth.uid();

  if p_outcome not in ('not_received', 'cancel') then
    raise exception 'reject_manual_payment: unknown outcome %', p_outcome using errcode = 'EB023';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'reject_manual_payment: a reason is required' using errcode = '22023';
  end if;

  select o.total_minor, o.currency, o.status
  into v_total_minor, v_currency, v_order_status
  from public.orders o
  join public.payments pay on pay.order_id = o.id and pay.provider = 'manual'
  where o.id = p_order_id
  for update of o;

  if v_total_minor is null or v_order_status <> 'pending' then
    raise exception 'reject_manual_payment: order % is not a pending manual order', p_order_id
      using errcode = 'EB022';
  end if;

  select coalesce(max(d.sequence), 0) + 1 into v_sequence
  from public.manual_payment_declines d where d.order_id = p_order_id;

  insert into public.manual_payment_declines (order_id, sequence, admin_profile_id, reason, outcome)
  values (p_order_id, v_sequence, v_admin_id, v_reason, p_outcome);

  -- A cancellation is terminal, so its event ID is fixed and replay-safe. "Not received" can happen
  -- repeatedly on the same order, so each one is its own event.
  v_event_id := case p_outcome
    when 'cancel' then 'manual:' || p_order_id::text || ':cancelled'
    else 'manual:' || p_order_id::text || ':not_received:' || v_sequence::text
  end;

  select a.order_status, a.payment_status into v_result
  from public.apply_payment_event(
    'manual', v_event_id, p_order_id, 'manual-decline',
    case p_outcome when 'cancel' then 'cancelled' else 'failed' end,
    v_total_minor, v_currency, now()
  ) a;

  -- The reader must be able to report a fresh transfer after a decline.
  delete from public.manual_transfer_claims where order_id = p_order_id;

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, summary)
  values (v_admin_id, 'manual_payment.declined', 'order', p_order_id,
    jsonb_build_object('outcome', p_outcome, 'reason', v_reason, 'sequence', v_sequence));

  return query select v_result.order_status, v_result.payment_status;
end;
$$;

revoke execute on function public.confirm_manual_payment(uuid, bigint, text, text, boolean) from public, anon;
grant execute on function public.confirm_manual_payment(uuid, bigint, text, text, boolean) to authenticated;
revoke execute on function public.reject_manual_payment(uuid, text, text) from public, anon;
grant execute on function public.reject_manual_payment(uuid, text, text) to authenticated;
```

Before running, open `supabase/migrations/20260915130000_revoke_order_entitlement.sql` and make the
two `insert into public.audit_logs` statements above match that file's actual column names. If they
differ, change these inserts, not that file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS

- [ ] **Step 5: Regenerate types and run the full check**

Run: `npx supabase gen types typescript --local > lib/supabase/database.types.ts`
Run: `npm run check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations supabase/tests lib/supabase/database.types.ts
git commit -m "feat(db): confirm and decline manual bank transfers"
```

---

### Task 7: Read and write manual payments from the application

**Files:**
- Create: `lib/commerce/manual-payment.ts`
- Create: `lib/commerce/manual-payment.test.ts`
- Modify: `lib/data/orders.ts`
- Modify: `lib/data/orders.test.ts`
- Create: `lib/data/manual-payments.ts`
- Create: `lib/data/manual-payments.test.ts`

**Interfaces:**
- Consumes: `claim_manual_transfer`, `confirm_manual_payment`, `reject_manual_payment` from Tasks 5 and 6; `requireUser` from `lib/auth/session`; `requireAdmin` from `lib/auth/admin`; `createClient` from `lib/supabase/server`.
- Produces:
  - `CustomerOrderDTO` gains `referenceCode: string`, `provider: string | null`, `hasClaim: boolean`, `declineReason: string | null`.
  - `lib/commerce/manual-payment.ts`: `claimManualTransfer(locale: Locale, orderId: string, note: string | null): Promise<void>`, `confirmManualPayment(orderId: string, input: ConfirmManualPaymentInput): Promise<void>` where `ConfirmManualPaymentInput = { receivedAmountMinor: number; expectedAmountMinor: number; bankReference: string; note: string | null; acceptMismatch: boolean }`, `rejectManualPayment(orderId: string, reason: string, outcome: "not_received" | "cancel"): Promise<void>`, and the errors `NotAClaimableOrderError`, `AmountMismatchError` (carrying `receivedMinor` and `expectedMinor`), `NotAPendingManualOrderError`, `MissingBankReferenceError`, `MissingDeclineReasonError`.
  - `lib/data/manual-payments.ts`: `listManualPaymentQueue(query?: string): Promise<ManualPaymentQueueItemDTO[]>` where `ManualPaymentQueueItemDTO = { orderId, referenceCode, email, title, totalMinor, currency, createdAt, claimedAt: string | null, claimNote: string | null }`, sorted claimed-first then oldest-claim-first.

- [ ] **Step 1: Write the failing test for the error mapping**

Create `lib/commerce/manual-payment.test.ts`. Mock the Supabase client the way
`lib/access/grant.test.ts` already does — read that file first and copy its mocking setup — then
assert one case per Postgres error code:

```ts
it("maps EB021 to an AmountMismatchError carrying both amounts", async () => {
  rpc.mockResolvedValue({ data: null, error: { code: "EB021", message: "received 100000 but the order total is 129000" } });
  await expect(
    confirmManualPayment("order-1", {
      receivedAmountMinor: 100000,
      expectedAmountMinor: 129000,
      bankReference: "VCB-1",
      note: null,
      acceptMismatch: false,
    }),
  ).rejects.toMatchObject({ name: "AmountMismatchError", receivedMinor: 100000, expectedMinor: 129000 });
});

it("maps EB022 to NotAPendingManualOrderError", async () => { /* same shape */ });
it("maps EB020 to NotAClaimableOrderError", async () => { /* same shape */ });
it("maps EB023 to an ordinary Error, because the UI never sends an unknown outcome", async () => { /* same shape */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/commerce/manual-payment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/commerce/manual-payment.ts`**

Follow the exact structure of `lib/access/grant.ts`: `import "server-only"`, one exported error class
per failure the UI must distinguish, a `requireUser`/`requireAdmin` call at the top of each function,
the session client from `createClient()`, and an explicit `error.code` switch that rethrows anything
unrecognized with a message naming the function and the RPC.

```ts
import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import type { Locale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

export class NotAClaimableOrderError extends Error {
  constructor() {
    super("This order is not waiting for a bank transfer.");
    this.name = "NotAClaimableOrderError";
  }
}

export class AmountMismatchError extends Error {
  constructor(readonly receivedMinor: number, readonly expectedMinor: number) {
    super("The received amount does not match the order total.");
    this.name = "AmountMismatchError";
  }
}

export class NotAPendingManualOrderError extends Error {
  constructor() {
    super("This order is not a pending manual payment.");
    this.name = "NotAPendingManualOrderError";
  }
}

export class MissingBankReferenceError extends Error {
  constructor() {
    super("Enter the bank transaction reference before confirming.");
    this.name = "MissingBankReferenceError";
  }
}

export class MissingDeclineReasonError extends Error {
  constructor() {
    super("Enter a reason before declining.");
    this.name = "MissingDeclineReasonError";
  }
}

// The reader reports a transfer (spec 5.5). Idempotent in the database, so a double submit is safe.
export async function claimManualTransfer(locale: Locale, orderId: string, note: string | null): Promise<void> {
  await requireUser(locale);
  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_manual_transfer", { p_order_id: orderId, p_note: note });
  if (error) {
    if (error.code === "EB020" || error.code === "P0002") throw new NotAClaimableOrderError();
    throw new Error(`claimManualTransfer: claim_manual_transfer failed: ${error.message}`);
  }
}

export type ConfirmManualPaymentInput = {
  receivedAmountMinor: number;
  // The caller already holds the order, so the expected total travels with the call rather than
  // being parsed back out of the database's error message.
  expectedAmountMinor: number;
  bankReference: string;
  note: string | null;
  acceptMismatch: boolean;
};

// Admin confirmation (spec 5.6). The RPC checks is_admin() as well; this gate is the application
// half, and neither one is sufficient alone.
export async function confirmManualPayment(orderId: string, input: ConfirmManualPaymentInput): Promise<void> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_manual_payment", {
    p_order_id: orderId,
    p_received_amount_minor: input.receivedAmountMinor,
    p_bank_reference: input.bankReference,
    p_note: input.note,
    p_accept_mismatch: input.acceptMismatch,
  });
  if (error) {
    if (error.code === "EB021") {
      throw new AmountMismatchError(input.receivedAmountMinor, input.expectedAmountMinor);
    }
    if (error.code === "EB022") throw new NotAPendingManualOrderError();
    if (error.code === "22023") throw new MissingBankReferenceError();
    throw new Error(`confirmManualPayment: confirm_manual_payment failed: ${error.message}`);
  }
}

export type DeclineOutcome = "not_received" | "cancel";

export async function rejectManualPayment(orderId: string, reason: string, outcome: DeclineOutcome): Promise<void> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_manual_payment", {
    p_order_id: orderId,
    p_reason: reason,
    p_outcome: outcome,
  });
  if (error) {
    if (error.code === "EB022") throw new NotAPendingManualOrderError();
    if (error.code === "22023") throw new MissingDeclineReasonError();
    throw new Error(`rejectManualPayment: reject_manual_payment failed: ${error.message}`);
  }
}
```

- [ ] **Step 4: Extend the customer order DTO**

In `lib/data/orders.ts`, add to `CustomerOrderDTO`:

```ts
  referenceCode: string;
  provider: string | null;
  hasClaim: boolean;
  declineReason: string | null;
```

Extend `orderColumns` to fetch them in one round trip:

```ts
const orderColumns =
  "id, reference_code, status, payment_status, total_minor, currency, created_at, " +
  "items:order_items ( book_id, title_snapshot ), " +
  "payments ( provider ), " +
  "claims:manual_transfer_claims ( claimed_at ), " +
  "declines:manual_payment_declines ( reason, sequence )";
```

Extend `OrderRow` with the matching optional arrays and map them in `toDTO`. The decline reason is
the row with the highest `sequence`:

```ts
  const latestDecline = (row.declines ?? []).reduce<{ reason: string; sequence: number } | null>(
    (best, candidate) => (best === null || candidate.sequence > best.sequence ? candidate : best),
    null,
  );
  // ...
    referenceCode: row.reference_code,
    provider: row.payments?.[0]?.provider ?? null,
    hasClaim: (row.claims ?? []).length > 0,
    declineReason: latestDecline?.reason ?? null,
```

Add cases to `lib/data/orders.test.ts` asserting that a row with a claim maps to `hasClaim: true` and
that the highest-sequence decline reason wins over an earlier one.

- [ ] **Step 5: Write `lib/data/manual-payments.ts`**

Follow the structure of `lib/data/admin-orders.ts`: `import "server-only"`, `requireAdmin()` at the
top, the session client, an explicit column list, a `LIMIT` constant, and `emailsFor`-style
resolution of customer emails through `customer_identities`. Accept a query string that is matched
against the order reference (via `isOrderReference` from Task 3) or a normalized email (via
`normalizeEmailQuery` from `lib/data/users.ts`). Sort claimed orders first, then by `claimed_at`
ascending, then by `created_at` ascending.

Write `lib/data/manual-payments.test.ts` covering: an unclaimed order sorts after a claimed one;
two claimed orders sort oldest-claim-first; a query that looks like a reference searches
`reference_code`; a query containing `@` searches the email.

- [ ] **Step 6: Run the tests and the full check**

Run: `npx vitest run lib/commerce lib/data`
Expected: PASS
Run: `npm run check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/commerce/manual-payment.ts lib/commerce/manual-payment.test.ts lib/data/orders.ts lib/data/orders.test.ts lib/data/manual-payments.ts lib/data/manual-payments.test.ts
git commit -m "feat(commerce): read and write manual payments from the application"
```

---

### Task 8: The transfer instructions page

**Files:**
- Create: `app/[locale]/(account)/checkout/[orderId]/transfer/page.tsx`
- Create: `app/[locale]/(account)/checkout/[orderId]/transfer/actions.ts`
- Create: `app/[locale]/(account)/checkout/[orderId]/transfer/actions.test.ts`
- Create: `components/commerce/copy-reference.tsx`
- Modify: `lib/i18n/dictionaries/vi.json`
- Modify: `lib/i18n/dictionaries/en.json`

**Interfaces:**
- Consumes: `getCustomerOrder` (Task 7), `claimManualTransfer` (Task 7), `resolveManualTransferState` (Task 4), `buildVietQrImageUrl` (Task 1), `getServerEnv().bankTransfer` (Task 1), `getCommerceRoutes(locale).checkoutTransfer` (Task 1).
- Produces: the route `/{locale}/checkout/{orderId}/transfer` and the Server Action `claimTransferAction(locale: string, orderId: string, formData: FormData): Promise<void>`.

- [ ] **Step 1: Add the dictionary copy**

In both `lib/i18n/dictionaries/vi.json` and `en.json`, add a `transfer` object inside `checkout`.
Vietnamese:

```json
"transfer": {
  "eyebrow": "Chuyển khoản",
  "title": "Chuyển khoản để hoàn tất",
  "description": "Chuyển đúng số tiền và ghi đúng nội dung bên dưới. Chúng tôi xác nhận trong giờ làm việc.",
  "bankName": "Ngân hàng",
  "accountNumber": "Số tài khoản",
  "accountHolder": "Chủ tài khoản",
  "amount": "Số tiền",
  "reference": "Nội dung chuyển khoản",
  "copy": "Sao chép",
  "copied": "Đã sao chép",
  "qrAlt": "Mã QR chuyển khoản cho đơn hàng {reference}",
  "noteLabel": "Ghi chú cho chúng tôi (không bắt buộc)",
  "claim": "Tôi đã chuyển khoản",
  "claiming": "Đang gửi…",
  "claimedTitle": "Đã nhận báo chuyển khoản",
  "claimedBody": "Chúng tôi sẽ đối soát và mở quyền đọc cho bạn ngay khi xác nhận được.",
  "declinedTitle": "Chưa nhận được chuyển khoản",
  "declinedBody": "Lý do: {reason}. Bạn có thể chuyển lại và báo cho chúng tôi.",
  "unavailable": "Không lấy được thông tin chuyển khoản. Vui lòng liên hệ hỗ trợ."
}
```

English mirrors it exactly, same keys.

- [ ] **Step 2: Write the failing Server Action test**

Create `app/[locale]/(account)/checkout/[orderId]/transfer/actions.test.ts`, modelled on the existing
`app/[locale]/(account)/checkout/[orderId]/actions.test.ts` — read that file first for its mocking of
`requireUser`, `getCustomerOrder`, and `redirect`:

```ts
it("redirects to the locale home when the locale is not supported", async () => { /* ... */ });
it("refuses to claim an order the reader does not own", async () => {
  vi.mocked(getCustomerOrder).mockResolvedValue(null);
  await claimTransferAction("vi", "order-1", new FormData());
  expect(claimManualTransfer).not.toHaveBeenCalled();
});
it("passes a trimmed note through, and null for an empty one", async () => { /* ... */ });
it("sends the reader to the status page when the order is no longer pending", async () => { /* ... */ });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run "app/[locale]/(account)/checkout/[orderId]/transfer/actions.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the Server Action**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { claimManualTransfer } from "@/lib/commerce/manual-payment";
import { getCustomerOrder } from "@/lib/data/orders";
import { defaultLocale, isLocale, withLocale } from "@/lib/i18n/config";
import { getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

// Every runtime export below is an async function: a non-function export from a "use server" module
// builds cleanly and then crashes the client at request time.

export async function claimTransferAction(locale: string, orderId: string, formData: FormData): Promise<void> {
  if (!isLocale(locale)) redirect(withLocale(defaultLocale, "/"));
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.checkoutTransfer(orderId));

  const order = await getCustomerOrder(orderId);
  if (!order) redirect(getLocaleRoutes(locale).orders);
  if (order.status !== "pending") redirect(commerce.checkoutStatus(order.id));

  const note = String(formData.get("note") ?? "").trim();
  await claimManualTransfer(locale, order.id, note === "" ? null : note);

  revalidatePath(commerce.checkoutTransfer(order.id));
}
```

- [ ] **Step 5: Write the copy control**

Create `components/commerce/copy-reference.tsx`. It is a Client Component holding one `useState` for
the copied flag and rendering a button beside the reference. The reference itself is plain text in
the server-rendered page, so a reader without JavaScript can still read and type it.

- [ ] **Step 6: Write the page**

Create `app/[locale]/(account)/checkout/[orderId]/transfer/page.tsx`, modelled closely on the
existing `checkout/[orderId]/page.tsx`. It must:

- `export const metadata: Metadata = { robots: { index: false, follow: false } };`
- `notFound()` when the locale is unsupported;
- `await requireUser(locale, commerce.checkoutTransfer(orderId))`;
- `notFound()` when `getServerEnv().paymentProvider !== "manual"`;
- `notFound()` when `getCustomerOrder(orderId)` returns null;
- `redirect(commerce.checkoutStatus(order.id))` when `order.status !== "pending"`;
- render the `bankTransfer` details, the formatted total via `formatPrice`, `order.referenceCode`
  with `CopyReference`, and the VietQR image inside `<img>` with the localized `qrAlt`, wrapped so a
  failed load leaves the printed details intact;
- render the note field and the claim button when `resolveManualTransferState(order)` is
  `awaiting_transfer` or `declined`, and the claimed panel when it is `awaiting_confirmation`;
- render `copy.declinedTitle` and `copy.declinedBody` with `order.declineReason` when the state is
  `declined`;
- render `copy.unavailable` and no QR when `getServerEnv().bankTransfer` is null.

- [ ] **Step 7: Point the manual provider's session at the page**

Nothing to change: `ManualProvider.createSession` from Task 1 already returns this route, and
`payOrderAction` already redirects to whatever the provider returns.

- [ ] **Step 8: Run the tests and the full check**

Run: `npx vitest run "app/[locale]/(account)/checkout"`
Expected: PASS
Run: `npm run check`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add "app/[locale]/(account)/checkout/[orderId]/transfer" components/commerce/copy-reference.tsx lib/i18n/dictionaries
git commit -m "feat(checkout): show bank transfer instructions and accept a transfer report"
```

---

### Task 9: Manual states on the status page and in order history

**Files:**
- Modify: `lib/commerce/checkout-view.ts`
- Modify: `lib/commerce/checkout-view.test.ts`
- Modify: `app/[locale]/(account)/checkout/[orderId]/status/page.tsx`
- Modify: `app/[locale]/(account)/account/orders/page.tsx`
- Modify: `app/[locale]/(account)/account/orders/[orderId]/page.tsx`
- Modify: `lib/i18n/dictionaries/vi.json`
- Modify: `lib/i18n/dictionaries/en.json`

**Interfaces:**
- Consumes: `resolveManualTransferState` (Task 4), the extended `CustomerOrderDTO` (Task 7).
- Produces: `customerOrderStatus(order)` returns the two extra keys `awaitingTransfer` and `awaitingConfirmation` when `order.provider === "manual"`, matching new `orders.statuses` dictionary keys.

- [ ] **Step 1: Write the failing test**

Add to `lib/commerce/checkout-view.test.ts`:

```ts
it("labels a manual order awaiting a transfer", () => {
  expect(customerOrderStatus({ status: "pending", paymentStatus: "pending", provider: "manual", hasClaim: false }))
    .toBe("awaitingTransfer");
});

it("labels a manual order awaiting our confirmation", () => {
  expect(customerOrderStatus({ status: "pending", paymentStatus: "pending", provider: "manual", hasClaim: true }))
    .toBe("awaitingConfirmation");
});

it("leaves a simulator order's labels exactly as they were", () => {
  expect(customerOrderStatus({ status: "pending", paymentStatus: "pending", provider: "simulator", hasClaim: false }))
    .toBe("awaitingPayment");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/commerce/checkout-view.test.ts`
Expected: FAIL — `awaitingTransfer` is not a `CustomerOrderStatus`.

- [ ] **Step 3: Extend the view model**

```ts
export type CustomerOrderStatus =
  | "completed"
  | "awaitingPayment"
  | "awaitingTransfer"
  | "awaitingConfirmation"
  | "paymentFailed"
  | "cancelled";

export type CustomerOrderView = OrderState & { provider: string | null; hasClaim: boolean };

// Manual orders get their own labels; every other provider keeps the S3 labels untouched.
export function customerOrderStatus(order: CustomerOrderView): CustomerOrderStatus {
  if (order.provider === "manual") {
    switch (resolveManualTransferState({
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      hasClaim: order.hasClaim,
    })) {
      case "confirmed":
        return "completed";
      case "cancelled":
        return "cancelled";
      case "declined":
        return "paymentFailed";
      case "awaiting_confirmation":
        return "awaitingConfirmation";
      case "awaiting_transfer":
        return "awaitingTransfer";
    }
  }
  switch (checkoutStatusView(order)) {
    case "success":
      return "completed";
    case "failed":
      return "paymentFailed";
    case "processing":
      return "awaitingPayment";
    case "cancelled":
      return "cancelled";
  }
}
```

- [ ] **Step 4: Add the dictionary keys**

Add to `orders.statuses` in both dictionaries:

```json
"awaitingTransfer": "Chờ chuyển khoản",
"awaitingConfirmation": "Đang chờ xác nhận"
```

English: `"Awaiting transfer"` and `"Awaiting confirmation"`.

Add to `checkout.status` in both dictionaries:

```json
"awaitingTransferTitle": "Chờ bạn chuyển khoản",
"awaitingTransferBody": "Đơn hàng đã được tạo. Hãy chuyển khoản theo hướng dẫn để hoàn tất.",
"awaitingConfirmationTitle": "Đang chờ xác nhận",
"awaitingConfirmationBody": "Chúng tôi đã nhận báo chuyển khoản và sẽ mở quyền đọc ngay khi đối soát xong.",
"transferInstructions": "Xem hướng dẫn chuyển khoản"
```

- [ ] **Step 5: Render the manual states**

In the status page, when `order.provider === "manual"`, branch on `resolveManualTransferState` instead
of `checkoutStatusView`, mapping `awaiting_transfer` and `awaiting_confirmation` to the new copy and
showing a link to `commerce.checkoutTransfer(order.id)` for both `awaiting_transfer` and `declined`.
Every other branch keeps its current content. `StatusAutoRefresh` stays on `awaiting_confirmation`
and is removed from `awaiting_transfer`, where nothing will change until the reader acts.

In `account/orders/page.tsx` and `account/orders/[orderId]/page.tsx`, pass `provider` and `hasClaim`
into `customerOrderStatus`, and change the "Continue checkout" link to
`commerce.checkoutTransfer(order.id)` when the provider is `manual` and the state is
`awaiting_transfer` or `declined`.

- [ ] **Step 6: Run the tests and the full check**

Run: `npx vitest run lib/commerce "app/[locale]/(account)"`
Expected: PASS
Run: `npm run check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/commerce/checkout-view.ts lib/commerce/checkout-view.test.ts "app/[locale]/(account)" lib/i18n/dictionaries
git commit -m "feat(account): show manual transfer states on the status and order pages"
```

---

### Task 10: The admin payment queue and decision forms

**Files:**
- Create: `app/admin/payments/page.tsx`
- Create: `app/admin/payments/page.test.tsx`
- Create: `app/admin/orders/[orderId]/manual-actions.ts`
- Create: `app/admin/orders/[orderId]/manual-actions.test.ts`
- Create: `components/admin/manual-payment-decision.tsx`
- Modify: `app/admin/orders/[orderId]/page.tsx`
- Modify: `components/admin/admin-nav.tsx` (find the file holding the admin navigation links and add "Payments")

**Interfaces:**
- Consumes: `listManualPaymentQueue` (Task 7), `confirmManualPayment` and `rejectManualPayment` (Task 7), `getAdminOrder` from `lib/data/admin-orders.ts`.
- Produces:
  - `/admin/payments`, an admin page listing pending manual payments.
  - `confirmManualPaymentAction(orderId, previous, formData): Promise<ManualDecisionState>` and `declineManualPaymentAction(orderId, previous, formData): Promise<ManualDecisionState>` where `ManualDecisionState = { status: "idle" } | { status: "done" } | { status: "mismatch"; receivedMinor: number; expectedMinor: number } | { status: "error"; message: string }`.

- [ ] **Step 1: Write the failing action tests**

Create `app/admin/orders/[orderId]/manual-actions.test.ts`, modelled on the existing
`app/admin/orders/[orderId]/actions.test.ts`:

```ts
it("requires a bank reference", async () => {
  const state = await confirmManualPaymentAction("order-1", { status: "idle" }, formDataOf({ amount: "129000" }));
  expect(state).toEqual({ status: "error", message: "Enter the bank transaction reference." });
  expect(confirmManualPayment).not.toHaveBeenCalled();
});

it("returns a mismatch state instead of an error, so the form can offer an override", async () => {
  vi.mocked(confirmManualPayment).mockRejectedValue(new AmountMismatchError(100000, 129000));
  const state = await confirmManualPaymentAction("order-1", { status: "idle" }, formDataOf({ amount: "100000", reference: "VCB-1" }));
  expect(state).toEqual({ status: "mismatch", receivedMinor: 100000, expectedMinor: 129000 });
});

it("passes the override through when the admin ticks it", async () => { /* expect acceptMismatch: true */ });
it("rejects a non-integer amount before calling the RPC", async () => { /* ... */ });
it("requires a reason before declining", async () => { /* ... */ });
it("revalidates the order page and the queue after a decision", async () => {
  expect(revalidatePath).toHaveBeenCalledWith("/admin/orders/order-1");
  expect(revalidatePath).toHaveBeenCalledWith("/admin/payments");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run "app/admin/orders/[orderId]/manual-actions.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the actions**

Create `app/admin/orders/[orderId]/manual-actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { requireAdmin } from "@/lib/auth/admin";
import {
  AmountMismatchError,
  NotAPendingManualOrderError,
  confirmManualPayment,
  rejectManualPayment,
  type DeclineOutcome,
} from "@/lib/commerce/manual-payment";
import { getAdminOrder } from "@/lib/data/admin-orders";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export below is an async function; only type exports are safe beside them.

export type ManualDecisionState =
  | { status: "idle" }
  | { status: "done" }
  | { status: "mismatch"; receivedMinor: number; expectedMinor: number }
  | { status: "error"; message: string };

const GENERIC_ERROR = "Something went wrong. Try again.";

function revalidate(orderId: string): void {
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/payments");
}

async function logFailure(operation: string, orderId: string, error: unknown): Promise<void> {
  console.error("Manual payment decision failed.", {
    operation,
    orderId,
    requestId: getRequestId(await headers()),
    error: String(error),
  });
}

export async function confirmManualPaymentAction(
  orderId: string,
  _previous: ManualDecisionState,
  formData: FormData,
): Promise<ManualDecisionState> {
  await requireAdmin({ next: `/admin/orders/${orderId}` });

  const bankReference = String(formData.get("reference") ?? "").trim();
  if (!bankReference) return { status: "error", message: "Enter the bank transaction reference." };

  const rawAmount = String(formData.get("amount") ?? "").trim();
  // A price is integer minor units. Anything else is a typo, and guessing at it would write the
  // wrong number into the reconciliation record.
  if (!/^\d+$/.test(rawAmount)) {
    return { status: "error", message: "Enter the received amount as a whole number." };
  }
  const receivedAmountMinor = Number.parseInt(rawAmount, 10);

  const order = await getAdminOrder(orderId);
  if (!order) return { status: "error", message: "That order no longer exists." };

  const note = String(formData.get("note") ?? "").trim();

  try {
    await confirmManualPayment(orderId, {
      receivedAmountMinor,
      expectedAmountMinor: order.totalMinor,
      bankReference,
      note: note === "" ? null : note,
      acceptMismatch: formData.get("accept-mismatch") === "on",
    });
  } catch (error) {
    if (error instanceof AmountMismatchError) {
      return { status: "mismatch", receivedMinor: error.receivedMinor, expectedMinor: error.expectedMinor };
    }
    if (error instanceof NotAPendingManualOrderError) {
      return { status: "error", message: "This order is no longer awaiting a transfer." };
    }
    await logFailure("confirmManualPaymentAction", orderId, error);
    return { status: "error", message: GENERIC_ERROR };
  }

  revalidate(orderId);
  return { status: "done" };
}

export async function declineManualPaymentAction(
  orderId: string,
  _previous: ManualDecisionState,
  formData: FormData,
): Promise<ManualDecisionState> {
  await requireAdmin({ next: `/admin/orders/${orderId}` });

  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { status: "error", message: "Enter a reason before declining." };

  const outcome = String(formData.get("outcome") ?? "");
  if (outcome !== "not_received" && outcome !== "cancel") {
    return { status: "error", message: GENERIC_ERROR };
  }

  try {
    await rejectManualPayment(orderId, reason, outcome satisfies DeclineOutcome);
  } catch (error) {
    if (error instanceof NotAPendingManualOrderError) {
      return { status: "error", message: "This order is no longer awaiting a transfer." };
    }
    await logFailure("declineManualPaymentAction", orderId, error);
    return { status: "error", message: GENERIC_ERROR };
  }

  revalidate(orderId);
  return { status: "done" };
}
```

- [ ] **Step 4: Write the decision component and wire it into the order page**

`components/admin/manual-payment-decision.tsx` is a Client Component using `useActionState` for both
actions. It renders the confirm form (received amount prefilled with the order total, bank reference,
note) and the decline form (reason, and a choice between "Mark as not received" and "Cancel order").
On the `mismatch` state it renders a warning naming both amounts and a checkbox
`name="accept-mismatch"` that must be ticked before the confirm button re-enables.

In `app/admin/orders/[orderId]/page.tsx`, render it only when the order's payment provider is
`manual` and the order status is `pending`. Also render the order's `reference_code`, the claim
timestamp and note when present, and the confirmation evidence when the order is already confirmed.

- [ ] **Step 5: Write the queue page**

`app/admin/payments/page.tsx` calls `requireAdmin({ next: "/admin/payments" })`, reads
`searchParams.q`, calls `listManualPaymentQueue(q)`, and renders a table with the same markup
conventions as `app/admin/orders/page.tsx`: a `region` wrapper with `tabIndex={0}`, a `sr-only`
caption, `min-h-11` controls, and each row linking to `/admin/orders/{orderId}`. Columns: Reference,
Book, Customer, Placed, Total, Reported. A claimed row shows the claim time; an unclaimed row shows
an em dash.

Write `app/admin/payments/page.test.tsx` following `app/admin/books/page.test.tsx`, asserting that
the page renders a claimed order above an unclaimed one and that an empty queue renders its empty
state.

- [ ] **Step 6: Add the navigation entry**

Run `grep -rn "admin/orders" components/admin app/admin/layout.tsx` to find the navigation list and
add `{ href: "/admin/payments", label: "Payments" }` beside the Orders entry.

- [ ] **Step 7: Run the tests and the full check**

Run: `npx vitest run app/admin`
Expected: PASS
Run: `npm run check`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add app/admin/payments "app/admin/orders/[orderId]" components/admin
git commit -m "feat(admin): review, confirm, and decline manual bank transfers"
```

---

### Task 11: Surface unreviewed claims to operators

**Files:**
- Modify: `lib/ops/types.ts`
- Modify: `lib/ops/checks.ts`
- Modify: `lib/ops/checks.test.ts`
- Modify: `lib/data/operations.ts`
- Modify: `components/admin/operations-panel.tsx` (only if it enumerates rules explicitly)

**Interfaces:**
- Consumes: `OperationsSnapshot`, `OpsFinding`, `evaluateOperations` from `lib/ops`.
- Produces:
  - `OPS_RULE_NAMES` gains `"unreviewed_manual_transfer_claim"`, with the label `"Unreviewed bank transfer reports"`.
  - `OperationsSnapshot` gains `manualTransferClaims: ManualTransferClaimRow[]` where
    `ManualTransferClaimRow = { orderId: string; claimedAt: string }`.
  - A finding per claim, `id` = the order ID, `occurredAt` = `claimedAt`, `repairPath` = `/admin/orders/{orderId}`.

Note the deliberate absence of a time threshold: a claim is a finding the moment it is made. The
existing fingerprint logic in `lib/ops/alerts.ts` then sends one alert per change in the set of
claims, rather than one email per claim. Read `lib/ops/alerts.ts` before starting to confirm that.

- [ ] **Step 1: Write the failing test**

Add to `lib/ops/checks.test.ts`:

```ts
it("reports every unreviewed claim immediately, with no age threshold", () => {
  const now = "2026-09-22T10:00:00.000Z";
  const report = evaluateOperations(
    { ...emptySnapshot(), manualTransferClaims: [{ orderId: "order-1", claimedAt: now }] },
    new Date(now),
  );
  expect(report.findings.unreviewed_manual_transfer_claim).toEqual([
    {
      id: "order-1",
      rule: "unreviewed_manual_transfer_claim",
      occurredAt: now,
      summary: "A reader reported a bank transfer that has not been reviewed.",
      repairPath: "/admin/orders/order-1",
    },
  ]);
});

it("orders claims oldest first", () => {
  const report = evaluateOperations(
    {
      ...emptySnapshot(),
      manualTransferClaims: [
        { orderId: "newer", claimedAt: "2026-09-22T10:00:00.000Z" },
        { orderId: "older", claimedAt: "2026-09-22T08:00:00.000Z" },
      ],
    },
    new Date("2026-09-22T11:00:00.000Z"),
  );
  expect(report.findings.unreviewed_manual_transfer_claim.map((f) => f.id)).toEqual(["older", "newer"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ops/checks.test.ts`
Expected: FAIL — `manualTransferClaims` is not in `OperationsSnapshot`.

- [ ] **Step 3: Add the rule**

In `lib/ops/types.ts`, append `"unreviewed_manual_transfer_claim"` to `OPS_RULE_NAMES`, add
`unreviewed_manual_transfer_claim: "Unreviewed bank transfer reports"` to `RULE_LABELS`, export
`ManualTransferClaimRow`, and add `manualTransferClaims: ManualTransferClaimRow[]` to
`OperationsSnapshot`.

In `lib/ops/checks.ts`, add to `SUMMARIES`:

```ts
  unreviewedClaim: "A reader reported a bank transfer that has not been reviewed.",
```

and the rule function, called from `evaluateOperations` alongside the others and wrapped in
`oldestFirst`:

```ts
// No threshold: an unreviewed claim is a finding from the moment it is made. The loader only
// returns claims whose order is still pending, so confirming or declining clears the finding.
function unreviewedManualTransferClaims(snapshot: OperationsSnapshot): OpsFinding[] {
  return snapshot.manualTransferClaims.map((claim) =>
    finding(
      "unreviewed_manual_transfer_claim",
      claim.orderId,
      claim.claimedAt,
      SUMMARIES.unreviewedClaim,
      `/admin/orders/${claim.orderId}`,
    ),
  );
}
```

- [ ] **Step 4: Add the loader**

In `lib/data/operations.ts`, add a `loadManualTransferClaims` following the shape of
`loadEpubJobs`. It selects `order_id, claimed_at` from `manual_transfer_claims` with an inner join
constraining `orders.status` to `pending`, orders by `claimed_at` ascending, and caps at
`MAX_ROWS_PER_RULE`. Add it to the snapshot the loader assembles.

- [ ] **Step 5: Check the admin panel**

Run `grep -n "RULE_LABELS\|OPS_RULE_NAMES" components/admin/operations-panel.tsx`. If it iterates
`OPS_RULE_NAMES`, no change is needed. If it hard-codes the four rules, add the fifth.

- [ ] **Step 6: Run the tests and the full check**

Run: `npx vitest run lib/ops lib/data`
Expected: PASS
Run: `npm run check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/ops lib/data/operations.ts components/admin
git commit -m "feat(ops): alert operators about unreviewed bank transfer reports"
```

---

### Task 12: End-to-end journey, runbook, and documentation

**Files:**
- Create: `e2e/manual-payment.spec.ts`
- Modify: `e2e/support/commerce.ts`
- Create: `docs/runbooks/manual-payment.md`
- Modify: `docs/runbooks/checkout.md`
- Modify: `docs/runbooks/deployment.md`

**Interfaces:**
- Consumes: every surface built in Tasks 1 to 11.
- Produces: `enableManualPayments()` in `e2e/support/commerce.ts`, beside the existing `enablePayments()`.

Read `e2e/checkout.spec.ts` and `e2e/support/commerce.ts` in full before starting. `enablePayments()`
sets `commerce_settings.payments_enabled`; the provider itself comes from the environment, so the
Playwright web-server configuration in `playwright.config.ts` is what must set
`PAYMENT_PROVIDER=manual` for this spec. If the existing config runs a single server with
`PAYMENT_PROVIDER=simulator`, add a second Playwright project with its own `webServer` entry on a
separate port and the manual environment, and restrict this spec to that project.

- [ ] **Step 1: Write the failing end-to-end test**

Create `e2e/manual-payment.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { activeEntitlementCount, createReader, enableManualPayments, signInAs } from "./support/commerce";

// S7 acceptance. Removing the transfer page, the reader's report, the admin confirmation, or the
// entitlement it grants must fail here.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test.beforeAll(async () => {
  await enableManualPayments();
});

test("a reader transfers, reports it, and an admin confirms", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `manual-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Manual Harbour ${suffix}` } },
    priceMinor: 129000,
  });

  const email = `manual-buyer-${suffix}@example.test`;
  await createReader(email);
  await signInAs(page, email);

  await page.goto(`/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();

  await expect(page).toHaveURL(/\/en\/checkout\/[0-9a-f-]{36}\/transfer$/);
  const orderId = /checkout\/([0-9a-f-]{36})\/transfer/.exec(page.url())![1];
  const reference = (await page.getByTestId("order-reference").textContent())!.trim();
  expect(reference).toMatch(/^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);

  await page.getByRole("button", { name: "I have transferred" }).click();
  await expect(page.getByText("We have your transfer report")).toBeVisible();
  expect(await activeEntitlementCount(email, bookId)).toBe(0);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, process.env.E2E_ADMIN_EMAIL!);
  await adminPage.goto("/admin/payments");
  await adminPage.getByRole("link", { name: reference }).click();
  await adminPage.getByLabel("Bank reference").fill("VCB-E2E-1");
  await adminPage.getByRole("button", { name: "Confirm payment" }).click();
  await expect(adminPage.getByText("Payment confirmed")).toBeVisible();
  await adminContext.close();

  expect(await activeEntitlementCount(email, bookId)).toBe(1);
  await page.goto(`/en/checkout/${orderId}/status`);
  await page.getByRole("link", { name: "Read now" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/read/${bookId}`));
});

test("a declined transfer returns the reader to the instructions", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `manual-declined-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Manual Declined ${suffix}` } },
    priceMinor: 129000,
  });

  const email = `manual-declined-${suffix}@example.test`;
  await createReader(email);
  await signInAs(page, email);

  await page.goto(`/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/checkout\/[0-9a-f-]{36}\/transfer$/);
  const reference = (await page.getByTestId("order-reference").textContent())!.trim();
  await page.getByRole("button", { name: "I have transferred" }).click();
  await expect(page.getByText("We have your transfer report")).toBeVisible();

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, process.env.E2E_ADMIN_EMAIL!);
  await adminPage.goto("/admin/payments");
  await adminPage.getByRole("link", { name: reference }).click();
  await adminPage.getByLabel("Reason").fill("No transfer found on the statement");
  await adminPage.getByLabel("Mark as not received").check();
  await adminPage.getByRole("button", { name: "Decline payment" }).click();
  await expect(adminPage.getByText("Payment declined")).toBeVisible();
  await adminContext.close();

  // A decline leaves the order payable: the reason is shown and the reader can report again.
  await page.reload();
  await expect(page.getByText("No transfer found on the statement")).toBeVisible();
  await expect(page.getByRole("button", { name: "I have transferred" })).toBeEnabled();
  expect(await activeEntitlementCount(email, bookId)).toBe(0);
});
```

Add `data-testid="order-reference"` to the reference element on the transfer page in Task 8, and
`aria-label`s matching the selectors above to the decision forms in Task 10.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/manual-payment.spec.ts`
Expected: FAIL — `enableManualPayments` is not exported.

- [ ] **Step 3: Add the fixture helper and the Playwright project**

Add `enableManualPayments()` to `e2e/support/commerce.ts`, and the manual-environment project to
`playwright.config.ts` as described above.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx playwright test e2e/manual-payment.spec.ts`
Expected: PASS

If a browser download times out, run against the installed Chrome channel rather than downloading
one. Never run Playwright fixtures against the cloud project: confirm the Supabase URL in the test
shell points at the local stack first.

- [ ] **Step 5: Write the runbook**

Create `docs/runbooks/manual-payment.md` covering:

- the environment variables from Task 1 and which of them production needs;
- setting `commerce_settings.payments_enabled` to true, and the fact that production refuses
  `PAYMENT_PROVIDER=simulator` while accepting `manual`;
- the daily reconciliation loop: open `/admin/payments`, match the bank memo to the order reference,
  confirm with the received amount and the bank transaction reference;
- what to do when the amount is short or over: the override, and that the difference is audited;
- declining as "not received" versus cancelling the order, and what each does to the reader;
- a reader who transferred without an order, or with a wrong memo — search
  `/admin/orders` by email, then confirm against the right order;
- that operator alerts arrive on the scheduler's interval, not instantly, and where that interval is
  configured.

- [ ] **Step 6: Update the neighbouring documentation**

In `docs/runbooks/checkout.md`, add the manual provider beside the simulator and link the new
runbook. In `docs/runbooks/deployment.md`, add the four bank variables to the production environment
list.

- [ ] **Step 7: Run the full check**

Run: `npm run db:reset && npm run db:test`
Expected: PASS
Run: `npm run check:full`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add e2e docs/runbooks playwright.config.ts
git commit -m "test(e2e): cover the manual bank-transfer journey, and document it"
```

---

## Verification Against the Spec

| Spec section | Task |
| --- | --- |
| 5.2 Provider registration | 1, 2 |
| 5.3 Order reference code | 3 |
| 5.4 Derived manual states | 4, 9 |
| 5.5 Claims | 5, 7, 8 |
| 5.6 Confirmation and decline | 6, 7, 10 |
| 6.1 Transfer instructions | 8 |
| 6.2 Status and order history | 9 |
| 6.3 Admin | 10 |
| 7 Notifications and operations | 11 |
| 8 Extension point for physical books | 6 (money-only RPCs), documented in the spec |
| 9 Testing | every task, plus 12 |
| 10 Exit criteria | 12 |
