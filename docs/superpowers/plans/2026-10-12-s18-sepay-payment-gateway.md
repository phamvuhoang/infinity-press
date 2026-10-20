# S18 SePay Payment Gateway (VietQR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `PAYMENT_PROVIDER=sepay`, a reader pays for an order by scanning a VietQR code on SePay's hosted page, and SePay's payment notification completes the order and grants access with no admin step.

**Architecture:** `sepay` is a third `PaymentProvider` beside `simulator` and `manual`. **Pay** redirects to a new `/{locale}/checkout/[orderId]/sepay` page that renders a signed, self-submitting form to SePay's checkout. SePay's IPN lands on `POST /api/payments/sepay/ipn`, which checks the `X-Secret-Key` header, maps the notification to the existing `VerifiedPaymentEvent`, and calls the existing `apply_payment_event`. The database gains the provider value `sepay` and the entitlement source `sepay_payment`; no table, column, or function signature is added.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase/Postgres, TypeScript, Zod, `node:crypto`, Vitest, pgTAP, Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-12-s18-sepay-payment-gateway-design.md`

## Global Constraints

- Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` and `page.md` (the `searchParams` prop) before Tasks 5 and 6.
- Customer routes stay under `/{locale}` for `vi` and `en`. The IPN route is `/api/payments/sepay/ipn`, with no locale.
- Every protected page calls `requireUser()` itself.
- The service-role client is created only after the `X-Secret-Key` check passes.
- `SEPAY_SECRET_KEY` never reaches browser code, a rendered page, or a log line.
- Only a verified payment event changes an order. A redirect back from SePay never does.
- Amount and currency sent to SePay come from the order row. VND only.
- `payment_method` is always `BANK_TRANSFER`.
- No `sepay-pg-node` dependency. The signature is `base64(HMAC-SHA256(secret, "k1=v1,k2=v2,..."))` over the fields in the order they are posted, `merchant` last.
- Invoice number format: `<reference_code>-<totalMinor>`, matching `^(IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5})-(\d+)$`.
- `APP_ENV=production` requires `SEPAY_ENV=production`. `APP_ENV=local` and `test` refuse `SEPAY_ENV=production`.
- Migrations: `supabase/migrations/20261012100000_s18_sepay_entitlement_source.sql` and `20261012100010_s18_sepay_provider.sql`. pgTAP: `supabase/tests/069_s18_sepay_provider.sql` (066 and 067 belong to S15 and S16; 068 is left for S17).
- Regenerate `lib/supabase/database.types.ts` against a reset local stack after the migrations.
- Dictionary keys go in both `en.json` and `vi.json`; `lib/i18n/dictionary.test.ts` enforces parity.
- Logs carry the request ID. Server errors keep it.
- Docker context is OrbStack. Node 22.14 for Playwright, a scratch Supabase stack, never the dev server on `:3000` (it points at the cloud database).
- Never run `db:reset`, `db:test`, or Playwright against the cloud project.
- Final gate: `npm run check`, `npm run db:reset && npm run db:test`, `npm run check:full`.

## Review Focus

1. **A coupon reprices the order after the QR is on screen, and the reader pays the old amount.** Expected: the order is not completed, and the log line names the invoice number and SePay's order ID so an operator can find the money. Test in Task 5 (`logs what an operator needs when apply_payment_event refuses the event`).
2. **SePay delivers the same notification twice.** Expected: 200 both times, one entitlement. Tests in Task 4 (pgTAP, repeated event) and Task 5 (`answers 200 for a repeat`).
3. **The operator switches providers while a reader is on SePay's page.** A still-pending order settles. If another **Buy** cancels the old order as stale, a late payment must return 422 `manual_resolution_required`, log all payment identifiers, and grant no entitlement. Cover the handler in Task 5 and the real stale-order/database flow in Task 7; a mocked completed outcome is insufficient.
4. **`order_amount` arrives as `"89000.00"`, `"89000"`, `89000`, `"89000.50"`, `""`, or missing.** Expected: the first three are 89000; the rest are a 400, never a rounded amount. Tests in Task 3.
5. **The reader comes back before the IPN arrives, or comes back after cancelling, or reloads a `?sepay=cancel` URL after the order completed.** Expected: processing with auto-refresh; the failed view with **Try again**; success. Tests in Task 6.

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/config/server-env-schema.ts` (modify) | `PAYMENT_PROVIDER=sepay`, the three `SEPAY_*` variables, their rules, `env.sepay` |
| `lib/commerce/sepay.ts` (create) | Checkout fields and signature, invoice number, IPN parsing, `SepayProvider` |
| `lib/commerce/sepay-ipn.ts` (create) | `handleSepayIpn`: the HTTP status for every case |
| `lib/commerce/payment-outcome.ts` (create) | `recordPaymentOutcome`, moved out of `simulator-webhook.ts` so both handlers use it |
| `lib/commerce/payment-provider.ts` (modify) | `getPaymentProvider` returns `SepayProvider` |
| `lib/access/grant.ts` (modify) | `findOrderIdByReference`, beside the other service-role payment call |
| `lib/i18n/routes.ts` (modify) | `checkoutSepay` |
| `app/api/payments/sepay/ipn/route.ts` (create) | Route handler, one line |
| `app/[lang]/(account)/checkout/[orderId]/sepay/page.tsx` (create) | Guards, then the form |
| `app/[lang]/(account)/checkout/[orderId]/sepay/auto-submit-form.tsx` (create) | Client component: the form that submits itself |
| `app/[lang]/(account)/checkout/[orderId]/status/page.tsx` (modify) | `?sepay=cancel|error` on a pending SePay order shows the failed view |
| `supabase/migrations/2026101210*.sql` (create) | Enum value; constraints and three functions |
| `e2e/sepay-payment.spec.ts`, `playwright.config.ts`, `e2e/support/*` (create/modify) | Third web server and the journey |
| `docs/runbooks/sepay-payment.md` (create), `docs/runbooks/checkout.md`, `.env.example` (modify) | Operations |

---

### Task 1: Sandbox verification (needs the owner's SePay sandbox account)

This task writes no product code. It answers the four questions in spec section 11. Tasks 2-7 do not wait for it, but nothing ships until it is done, and a "no" changes one function named below.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-s18-sepay-payment-gateway-design.md` (section 11, record the answers)

- [ ] **Step 1: Get sandbox credentials**

At <https://my.sepay.vn>, activate the payment gateway, choose Sandbox, and copy `MERCHANT ID` and `SECRET KEY`. Keep them out of the repository.

- [ ] **Step 2: Post a signed checkout by hand**

Save as a scratch file outside the repository and run with `SEPAY_MERCHANT_ID=... SEPAY_SECRET_KEY=... node probe.mjs > probe.html`, then open `probe.html`:

```js
import { createHmac } from "node:crypto";

const fields = [
  ["operation", "PURCHASE"],
  ["payment_method", "BANK_TRANSFER"],
  ["order_invoice_number", `IB-7K2MX-${process.argv[2] ?? "10000"}`],
  ["order_amount", process.argv[2] ?? "10000"],
  ["currency", "VND"],
  ["order_description", "Infinity Books IB-7K2MX"],
  ["success_url", "https://example.com/?sepay=success"],
  ["error_url", "https://example.com/?sepay=error"],
  ["cancel_url", "https://example.com/?sepay=cancel"],
  ["merchant", process.env.SEPAY_MERCHANT_ID],
];
const signature = createHmac("sha256", process.env.SEPAY_SECRET_KEY)
  .update(fields.map(([name, value]) => `${name}=${value}`).join(","))
  .digest("base64");
const inputs = [...fields, ["signature", signature]]
  .map(([name, value]) => `<input type="hidden" name="${name}" value="${value}">`)
  .join("\n");
console.log(
  `<form method="post" action="https://pay-sandbox.sepay.vn/v1/checkout/init">${inputs}<button>Pay</button></form>`,
);
```

Expected: SePay shows a QR page for 10,000 VND. A signature error here means question 1 is "no".

- [ ] **Step 3: Answer the four questions**

1. Signature accepted? If not: add `sepay-pg-node` and replace the body of `signSepayFields` (Task 3) with the SDK call.
2. Hyphens accepted in `order_invoice_number`? If not: change the separator in `buildSepayInvoiceNumber` and `INVOICE_PATTERN` (Task 3) to `_`.
3. Close the QR page without paying, then submit `probe.html` again. Reopened or refused? If refused: append `-${Date.now().toString(36)}` in `buildSepayInvoiceNumber` and widen `INVOICE_PATTERN` to `^(IB-[...]{5})-(\d+)(?:-[0-9a-z]+)?$`.
4. Point the sandbox IPN URL at a tunnel to a local server you control. Enable IPN auth type `SECRET_KEY` and confirm a delivery carries the expected `X-Secret-Key` without logging or saving the header. Do not send authenticated IPNs to a third-party request bin. Complete a sandbox payment and save only the JSON body. Is `transaction.transaction_id` present for a bank transfer? If not: use `order.order_id` as `eventId` in `parseSepayNotification` (Task 3).

- [ ] **Step 4: Record the answers**

Replace spec section 11's questions with the answers and the date. Paste the captured IPN body, with the customer fields removed, into the spec as the reference payload. If any fallback was taken, update spec sections 5 and 6 to match.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-12-s18-sepay-payment-gateway-design.md
git commit -m "docs(s18): record SePay sandbox findings"
```

---

### Task 2: Environment

**Files:**
- Modify: `lib/config/server-env-schema.ts`
- Test: `lib/config/server-env.test.ts`

**Interfaces:**
- Produces: `ServerEnv["paymentProvider"]` includes `"sepay"`; `ServerEnv["sepay"]: { merchantId: string; secretKey: string; env: "sandbox" | "production" } | null`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("parseServerEnv", ...)` in `lib/config/server-env.test.ts`:

```ts
  const sepay = {
    PAYMENT_PROVIDER: "sepay",
    SEPAY_MERCHANT_ID: "MERCHANT_TEST",
    SEPAY_SECRET_KEY: "secret_test_key",
    SEPAY_ENV: "sandbox",
  };

  it("accepts sepay with all three settings", () => {
    const env = parseServerEnv({ ...base, ...sepay });
    expect(env.paymentProvider).toBe("sepay");
    expect(env.sepay).toEqual({ merchantId: "MERCHANT_TEST", secretKey: "secret_test_key", env: "sandbox" });
  });

  it.each(["simulator", "manual"])("accepts blank optional settings with %s", (provider) => {
    // Use the existing valid fixture for this provider, including its required settings.
    const values = { ...base, ...sepay, PAYMENT_PROVIDER: provider };
    if (provider === "manual") Object.assign(values, {
      BANK_TRANSFER_BANK_CODE: "VCB", BANK_TRANSFER_BANK_NAME: "Vietcombank",
      BANK_TRANSFER_ACCOUNT_NUMBER: "123456789", BANK_TRANSFER_ACCOUNT_HOLDER: "TEST",
    });
    expect(parseServerEnv({ ...values, SEPAY_MERCHANT_ID: "", SEPAY_SECRET_KEY: "", SEPAY_ENV: "" }).sepay).toBeNull();
  });

  it("rejects blank settings when sepay is selected", () => {
    expect(() => parseServerEnv({ ...base, PAYMENT_PROVIDER: "sepay", SEPAY_MERCHANT_ID: "", SEPAY_SECRET_KEY: "", SEPAY_ENV: "" }))
      .toThrow("SEPAY_MERCHANT_ID, SEPAY_SECRET_KEY, and SEPAY_ENV are required when PAYMENT_PROVIDER=sepay");
  });

  it("has no sepay configuration when none is set", () => {
    expect(parseServerEnv(base).sepay).toBeNull();
  });

  it.each(["SEPAY_MERCHANT_ID", "SEPAY_SECRET_KEY", "SEPAY_ENV"])("rejects sepay without %s", (name) => {
    expect(() => parseServerEnv({ ...base, ...sepay, [name]: undefined })).toThrow(
      "SEPAY_MERCHANT_ID, SEPAY_SECRET_KEY, and SEPAY_ENV must be set together",
    );
  });

  it("rejects PAYMENT_PROVIDER=sepay with no sepay settings", () => {
    expect(() => parseServerEnv({ ...base, PAYMENT_PROVIDER: "sepay" })).toThrow(
      "SEPAY_MERCHANT_ID, SEPAY_SECRET_KEY, and SEPAY_ENV are required when PAYMENT_PROVIDER=sepay",
    );
  });

  // Keeps the IPN route alive after a switch back to manual (spec 6.3).
  it("keeps sepay settings when another provider is active", () => {
    expect(parseServerEnv({ ...base, ...sepay, PAYMENT_PROVIDER: "simulator" }).sepay?.merchantId).toBe("MERCHANT_TEST");
  });

  it("rejects sandbox credentials in production", () => {
    expect(() =>
      parseServerEnv({
        ...base,
        ...sepay,
        APP_ENV: "production",
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_test",
        EMAIL_FROM: "books@example.com",
        OPS_ALERT_EMAIL: "ops@example.com",
        OPS_WORKER_SECRET: "worker-secret-0123456789abcdef0123456789",
      }),
    ).toThrow("SEPAY_ENV must be production when APP_ENV=production");
  });

  it.each(["local", "test"])("rejects production credentials when APP_ENV=%s", (appEnv) => {
    expect(() => parseServerEnv({ ...base, ...sepay, APP_ENV: appEnv, SEPAY_ENV: "production" })).toThrow(
      "SEPAY_ENV=production is not allowed when APP_ENV is local or test",
    );
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/config/server-env.test.ts`
Expected: FAIL. The first new test fails on the `PAYMENT_PROVIDER` enum.

- [ ] **Step 3: Implement**

In `lib/config/server-env-schema.ts`, change the enum and add three fields to `schema`:

```ts
  PAYMENT_PROVIDER: z.enum(["disabled", "simulator", "manual", "sepay"]),
  SEPAY_MERCHANT_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  SEPAY_SECRET_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  SEPAY_ENV: z.preprocess((value) => value === "" ? undefined : value, z.enum(["sandbox", "production"]).optional()),
```

After the manual `bankFields` check in `parseServerEnv`, add:

```ts
  // All three or none. The settings may be present while another provider is active: the IPN
  // route keeps answering to settle pending orders or flag late payments on cancelled orders.
  const sepaySet = [parsed.SEPAY_MERCHANT_ID, parsed.SEPAY_SECRET_KEY, parsed.SEPAY_ENV].filter(Boolean).length;
  if (sepaySet !== 0 && sepaySet !== 3) {
    throw new Error("SEPAY_MERCHANT_ID, SEPAY_SECRET_KEY, and SEPAY_ENV must be set together");
  }
  if (parsed.PAYMENT_PROVIDER === "sepay" && sepaySet !== 3) {
    throw new Error("SEPAY_MERCHANT_ID, SEPAY_SECRET_KEY, and SEPAY_ENV are required when PAYMENT_PROVIDER=sepay");
  }
  // Sandbox payments move no money, so production must never complete an order from one.
  if (parsed.SEPAY_ENV && parsed.APP_ENV === "production" && parsed.SEPAY_ENV !== "production") {
    throw new Error("SEPAY_ENV must be production when APP_ENV=production");
  }
  if (parsed.SEPAY_ENV === "production" && (parsed.APP_ENV === "local" || parsed.APP_ENV === "test")) {
    throw new Error("SEPAY_ENV=production is not allowed when APP_ENV is local or test");
  }
```

In the returned object, after `bankTransfer`, add:

```ts
    sepay:
      parsed.SEPAY_MERCHANT_ID && parsed.SEPAY_SECRET_KEY && parsed.SEPAY_ENV
        ? { merchantId: parsed.SEPAY_MERCHANT_ID, secretKey: parsed.SEPAY_SECRET_KEY, env: parsed.SEPAY_ENV }
        : null,
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/config/server-env.test.ts && npm run typecheck`
Expected: PASS. If `typecheck` reports a test fixture that builds a full `ServerEnv` literal without `sepay`, add `sepay: null` to that fixture.

- [ ] **Step 5: Commit**

```bash
git add lib/config/server-env-schema.ts lib/config/server-env.test.ts
git commit -m "feat(s18): sepay payment provider environment"
```

---

### Task 3: Checkout fields, signature, and IPN parsing

Pure functions only. No network, no database.

**Files:**
- Create: `lib/commerce/sepay.ts`
- Test: `lib/commerce/sepay.test.ts`

**Interfaces:**
- Produces:
  - `type SepayConfig = { merchantId: string; secretKey: string; env: "sandbox" | "production" }`
  - `sepayCheckoutUrl(env: SepayConfig["env"]): string`
  - `buildSepayInvoiceNumber(referenceCode: string, totalMinor: number): string`
  - `parseSepayInvoiceNumber(value: string): { referenceCode: string; amountMinor: number } | null`
  - `signSepayFields(fields: ReadonlyArray<readonly [string, string]>, secretKey: string): string`
  - `buildSepayCheckoutFields(input: { order: { id: string; referenceCode: string; totalMinor: number; currency: string }; locale: Locale; siteUrl: string; config: SepayConfig }): Array<[string, string]> | null`
  - `hasValidSepaySecret(header: string | null, secretKey: string): boolean`
  - `type SepayPaidNotification = { referenceCode: string; invoiceNumber: string; eventId: string; externalPaymentId: string; amountMinor: number; currency: string; occurredAt: string }`
  - `parseSepayNotification(raw: string): SepayPaidNotification`
  - `SEPAY_SECRET_HEADER = "x-secret-key"`
  - Errors: `MalformedSepayNotificationError`, `SepayNotificationIgnoredError` (has `reason: string`)

- [ ] **Step 1: Write the failing tests**

Create `lib/commerce/sepay.test.ts`. The signature in the first test is the output of `sepay-pg-node` 1.0.0 for the same input, generated on 2026-10-12; do not recompute it with the function under test.

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildSepayCheckoutFields,
  buildSepayInvoiceNumber,
  hasValidSepaySecret,
  MalformedSepayNotificationError,
  parseSepayInvoiceNumber,
  parseSepayNotification,
  sepayCheckoutUrl,
  SepayNotificationIgnoredError,
  signSepayFields,
} from "@/lib/commerce/sepay";

const config = { merchantId: "MERCHANT_TEST", secretKey: "secret_test_key", env: "sandbox" } as const;
const order = { id: "o1", referenceCode: "IB-7K2MX", totalMinor: 89000, currency: "VND" };

describe("buildSepayCheckoutFields", () => {
  it("produces the request the official SDK produces", () => {
    const fields = buildSepayCheckoutFields({ order, locale: "vi", siteUrl: "https://books.test", config });
    expect(fields).toEqual([
      ["operation", "PURCHASE"],
      ["payment_method", "BANK_TRANSFER"],
      ["order_invoice_number", "IB-7K2MX-89000"],
      ["order_amount", "89000"],
      ["currency", "VND"],
      ["order_description", "Infinity Books IB-7K2MX"],
      ["success_url", "https://books.test/vi/checkout/o1/status?sepay=success"],
      ["error_url", "https://books.test/vi/checkout/o1/status?sepay=error"],
      ["cancel_url", "https://books.test/vi/checkout/o1/status?sepay=cancel"],
      ["merchant", "MERCHANT_TEST"],
      ["signature", "hZ+asjDXkl1g9oKmfcJIpSTkbPAMP+e0gqcT04hvW2I="],
    ]);
  });

  it("never carries the secret", () => {
    const fields = buildSepayCheckoutFields({ order, locale: "en", siteUrl: "https://books.test", config });
    expect(JSON.stringify(fields)).not.toContain("secret_test_key");
  });

  // order_amount passes the minor amount through, which is 100x wrong for a currency with one.
  it("refuses a currency other than VND", () => {
    expect(
      buildSepayCheckoutFields({ order: { ...order, currency: "USD" }, locale: "en", siteUrl: "https://books.test", config }),
    ).toBeNull();
  });
});

describe("signSepayFields", () => {
  it("depends on field order", () => {
    const a = signSepayFields([["a", "1"], ["b", "2"]], "k");
    const b = signSepayFields([["b", "2"], ["a", "1"]], "k");
    expect(a).not.toBe(b);
  });
});

describe("sepayCheckoutUrl", () => {
  it("keeps sandbox and production apart", () => {
    expect(sepayCheckoutUrl("sandbox")).toBe("https://pay-sandbox.sepay.vn/v1/checkout/init");
    expect(sepayCheckoutUrl("production")).toBe("https://pay.sepay.vn/v1/checkout/init");
  });
});

describe("invoice number", () => {
  it("round-trips the reference and the amount", () => {
    const invoice = buildSepayInvoiceNumber("IB-7K2MX", 89000);
    expect(invoice).toBe("IB-7K2MX-89000");
    expect(parseSepayInvoiceNumber(invoice)).toEqual({ referenceCode: "IB-7K2MX", amountMinor: 89000 });
  });

  it.each(["IB-7K2MX", "IB-7K2MX-", "IB-7K2MX-12a", "XX-7K2MX-100", "IB-7K2M-100", "", "IB-7K2MX-100-1"])(
    "rejects %j",
    (value) => {
      expect(parseSepayInvoiceNumber(value)).toBeNull();
    },
  );
});

describe("hasValidSepaySecret", () => {
  it("accepts only the exact secret", () => {
    expect(hasValidSepaySecret("secret_test_key", "secret_test_key")).toBe(true);
    expect(hasValidSepaySecret("secret_test_kez", "secret_test_key")).toBe(false);
    expect(hasValidSepaySecret("secret", "secret_test_key")).toBe(false);
    expect(hasValidSepaySecret("", "secret_test_key")).toBe(false);
    expect(hasValidSepaySecret(null, "secret_test_key")).toBe(false);
  });
});

function notification(overrides: { root?: object; order?: object; transaction?: object } = {}): string {
  return JSON.stringify({
    timestamp: 1757058220,
    notification_type: "ORDER_PAID",
    order: {
      order_id: "NPSETVI00101000042R",
      order_status: "CAPTURED",
      order_currency: "VND",
      order_amount: "89000.00",
      order_invoice_number: "IB-7K2MX-89000",
      ...overrides.order,
    },
    transaction: {
      transaction_id: "TXN-1",
      payment_method: "BANK_TRANSFER",
      transaction_status: "APPROVED",
      ...overrides.transaction,
    },
    ...overrides.root,
  });
}

describe("parseSepayNotification", () => {
  it("maps a paid order", () => {
    expect(parseSepayNotification(notification())).toEqual({
      referenceCode: "IB-7K2MX",
      invoiceNumber: "IB-7K2MX-89000",
      eventId: "TXN-1",
      externalPaymentId: "NPSETVI00101000042R",
      amountMinor: 89000,
      currency: "VND",
      occurredAt: "2025-09-05T07:43:40.000Z",
    });
  });

  it.each([["89000.00"], ["89000"], [89000]])("reads order_amount %j as 89000", (amount) => {
    expect(parseSepayNotification(notification({ order: { order_amount: amount } })).amountMinor).toBe(89000);
  });

  // Never a rounded amount: apply_payment_event compares it to the order's total.
  it.each([["89000.50"], [""], [" "], ["-1"], ["1e5"], [null], [undefined], [89000.5]])(
    "rejects order_amount %j",
    (amount) => {
      expect(() => parseSepayNotification(notification({ order: { order_amount: amount } }))).toThrow(
        MalformedSepayNotificationError,
      );
    },
  );

  it.each([
    ["not json", "{"],
    ["a JSON string", '"x"'],
    ["no notification_type", notification({ root: { notification_type: undefined } })],
    ["no order", notification({ root: { order: null } })],
    ["no transaction", notification({ root: { transaction: "x" } })],
    ["a foreign invoice number", notification({ order: { order_invoice_number: "SUB_202509_001" } })],
    ["no payment_method", notification({ transaction: { payment_method: undefined } })],
    ["empty payment_method", notification({ transaction: { payment_method: "" } })],
    ["invalid payment_method", notification({ transaction: { payment_method: 7 } })],
    ["no transaction_id", notification({ transaction: { transaction_id: "" } })],
    ["no order_id", notification({ order: { order_id: 7 } })],
    ["no currency", notification({ order: { order_currency: "" } })],
    ["a string timestamp", notification({ root: { timestamp: "1757058220" } })],
    ["a zero timestamp", notification({ root: { timestamp: 0 } })],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseSepayNotification(raw)).toThrow(MalformedSepayNotificationError);
  });

  it.each([
    ["card payment", notification({ transaction: { payment_method: "CARD" } })],
    ["NAPAS payment", notification({ transaction: { payment_method: "NAPAS_BANK_TRANSFER" } })],
    ["another notification type", notification({ root: { notification_type: "TRANSACTION_VOID" } })],
    ["an order that is not captured", notification({ order: { order_status: "PENDING" } })],
    ["a transaction that is not approved", notification({ transaction: { transaction_status: "DECLINED" } })],
  ])("ignores %s", (_label, raw) => {
    expect(() => parseSepayNotification(raw)).toThrow(SepayNotificationIgnoredError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/commerce/sepay.test.ts`
Expected: FAIL, cannot resolve `@/lib/commerce/sepay`.

- [ ] **Step 3: Implement**

Create `lib/commerce/sepay.ts`:

```ts
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { Locale } from "@/lib/i18n/config";
import { getCommerceRoutes } from "@/lib/i18n/routes";

// SePay's hosted payment gateway, bank-transfer (VietQR) method only (S18 spec). The reader pays on
// SePay's page; SePay's notification (IPN) is the only thing that completes an order.
export type SepayConfig = { merchantId: string; secretKey: string; env: "sandbox" | "production" };

const CHECKOUT_URLS = {
  sandbox: "https://pay-sandbox.sepay.vn/v1/checkout/init",
  production: "https://pay.sepay.vn/v1/checkout/init",
} as const;

export function sepayCheckoutUrl(env: SepayConfig["env"]): string {
  return CHECKOUT_URLS[env];
}

// The amount is part of the invoice number because a coupon can reprice a pending order after a
// first trip to SePay, and SePay keys an order on this number. Unchanged order, same SePay order;
// repriced order, new one - with nothing stored (S18 spec 5.2).
const INVOICE_PATTERN = /^(IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5})-(\d+)$/;

export function buildSepayInvoiceNumber(referenceCode: string, totalMinor: number): string {
  return `${referenceCode}-${totalMinor}`;
}

export function parseSepayInvoiceNumber(value: string): { referenceCode: string; amountMinor: number } | null {
  const match = INVOICE_PATTERN.exec(value);
  return match ? { referenceCode: match[1], amountMinor: Number(match[2]) } : null;
}

// base64(HMAC-SHA256(secret, "k1=v1,k2=v2,...")) over the fields in the order they are posted.
// This is what sepay-pg-node 1.0.0 computes; the docs do not describe it. Every field this module
// sends is in SePay's signed set, so there is no filtering step.
export function signSepayFields(fields: ReadonlyArray<readonly [string, string]>, secretKey: string): string {
  return createHmac("sha256", secretKey)
    .update(fields.map(([name, value]) => `${name}=${value}`).join(","))
    .digest("base64");
}

// The form's inputs, in the order they must be rendered: the signature covers that order. Null for
// an order SePay cannot take. order_amount is the minor amount passed straight through, which is
// right for VND and 100x wrong for any currency with a minor unit - the same rule as
// buildVietQrImageUrl in lib/commerce/manual.ts.
export function buildSepayCheckoutFields(input: {
  order: { id: string; referenceCode: string; totalMinor: number; currency: string };
  locale: Locale;
  siteUrl: string;
  config: SepayConfig;
}): Array<[string, string]> | null {
  const { order, config } = input;
  if (order.currency !== "VND") return null;
  // A return to any of these never changes the order; the parameter only picks what the status
  // page says while the order is still pending.
  const statusUrl = `${input.siteUrl}${getCommerceRoutes(input.locale).checkoutStatus(order.id)}`;
  const fields: Array<[string, string]> = [
    ["operation", "PURCHASE"],
    ["payment_method", "BANK_TRANSFER"],
    ["order_invoice_number", buildSepayInvoiceNumber(order.referenceCode, order.totalMinor)],
    ["order_amount", String(order.totalMinor)],
    ["currency", "VND"],
    ["order_description", `Infinity Books ${order.referenceCode}`],
    ["success_url", `${statusUrl}?sepay=success`],
    ["error_url", `${statusUrl}?sepay=error`],
    ["cancel_url", `${statusUrl}?sepay=cancel`],
    ["merchant", config.merchantId],
  ];
  return [...fields, ["signature", signSepayFields(fields, config.secretKey)]];
}

export const SEPAY_SECRET_HEADER = "x-secret-key";

// The IPN's whole authentication: SePay sends the merchant secret in a header and signs nothing.
export function hasValidSepaySecret(header: string | null, secretKey: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(secretKey);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class MalformedSepayNotificationError extends Error {
  constructor(reason: string) {
    super(`SePay notification is malformed (${reason})`);
    this.name = "MalformedSepayNotificationError";
  }
}

// A well-formed notification that is not a completed bank-transfer payment. Acknowledged and
// logged, never applied.
export class SepayNotificationIgnoredError extends Error {
  constructor(readonly reason: string) {
    super(`SePay notification ignored (${reason})`);
    this.name = "SepayNotificationIgnoredError";
  }
}

export type SepayPaidNotification = {
  referenceCode: string;
  invoiceNumber: string;
  eventId: string;
  externalPaymentId: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new MalformedSepayNotificationError(field);
  return value;
}

export function parseSepayNotification(raw: string): SepayPaidNotification {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new MalformedSepayNotificationError("json");
  }
  if (!isRecord(body)) throw new MalformedSepayNotificationError("json");

  const type = text(body.notification_type, "notification_type");
  if (type !== "ORDER_PAID") throw new SepayNotificationIgnoredError(`notification_type=${type}`);

  const { order, transaction, timestamp } = body;
  if (!isRecord(order)) throw new MalformedSepayNotificationError("order");
  if (!isRecord(transaction)) throw new MalformedSepayNotificationError("transaction");
  if (order.order_status !== "CAPTURED" || transaction.transaction_status !== "APPROVED") {
    throw new SepayNotificationIgnoredError(
      `order_status=${String(order.order_status)} transaction_status=${String(transaction.transaction_status)}`,
    );
  }

  const method = text(transaction.payment_method, "payment_method");
  if (method !== "BANK_TRANSFER") throw new SepayNotificationIgnoredError(`payment_method=${method}`);

  const invoiceNumber = text(order.order_invoice_number, "order_invoice_number");
  const invoice = parseSepayInvoiceNumber(invoiceNumber);
  if (!invoice) throw new MalformedSepayNotificationError("order_invoice_number");

  // "89000.00", "89000", or 89000. Anything with a fraction is refused rather than rounded:
  // apply_payment_event compares this to the order's total.
  const amountText = typeof order.order_amount === "number" ? String(order.order_amount) : order.order_amount;
  if (typeof amountText !== "string" || !/^\d+(\.0+)?$/.test(amountText)) {
    throw new MalformedSepayNotificationError("order_amount");
  }
  const amountMinor = Number(amountText);
  if (!Number.isSafeInteger(amountMinor)) throw new MalformedSepayNotificationError("order_amount");

  if (typeof timestamp !== "number" || !Number.isInteger(timestamp) || timestamp <= 0) {
    throw new MalformedSepayNotificationError("timestamp");
  }

  return {
    referenceCode: invoice.referenceCode,
    invoiceNumber,
    eventId: text(transaction.transaction_id, "transaction_id"),
    externalPaymentId: text(order.order_id, "order_id"),
    amountMinor,
    currency: text(order.order_currency, "order_currency"),
    occurredAt: new Date(timestamp * 1000).toISOString(),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/commerce/sepay.test.ts`
Expected: PASS, including the SDK vector.

- [ ] **Step 5: Commit**

```bash
git add lib/commerce/sepay.ts lib/commerce/sepay.test.ts
git commit -m "feat(s18): sepay checkout fields, signature, and notification parsing"
```

---

### Task 4: Database

**Files:**
- Create: `supabase/migrations/20261012100000_s18_sepay_entitlement_source.sql`
- Create: `supabase/migrations/20261012100010_s18_sepay_provider.sql`
- Create: `supabase/tests/069_s18_sepay_provider.sql`
- Modify: `lib/supabase/database.types.ts` (regenerated), `lib/data/admin-orders.ts:37,140`, `lib/data/users.ts:14`

**Interfaces:**
- Produces: provider value `'sepay'` accepted by `payments.provider`, `orders.payment_provider`, `commerce_settings.payment_provider`; `apply_payment_event('sepay', ...)` grants `source_type = 'sepay_payment'`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/069_s18_sepay_provider.sql`:

```sql
begin;
select plan(11);

-- S18: 'sepay' is a provider the database books orders under, settles, gifts, and revokes exactly
-- as it does 'manual'. Every order here comes from create_ebook_order, because the agreement
-- between commerce_settings, orders.payment_provider, and payments.provider is what is under test
-- and only the real RPC produces it.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a1800000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's18-buyer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1800000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's18-recipient@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- The buyer doubles as the admin for the revoke case.
insert into public.user_roles (profile_id, role)
select p.id, 'admin' from public.profiles p where p.auth_user_id = 'a1800000-0000-0000-0000-000000000001';

create temporary table t_orders (label text primary key, order_id uuid not null);
grant select, insert on t_orders to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('a1830000-0000-0000-0000-000000000001', 's18-author', 'S18 Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status)
select ('a1820000-0000-0000-0000-00000000000' || n)::uuid, 's18-book-' || n, 'vi',
       'a1830000-0000-0000-0000-000000000001', 'published'
from generate_series(1, 2) as n;

insert into public.book_localizations (book_id, locale, slug, title)
select ('a1820000-0000-0000-0000-00000000000' || n)::uuid, 'vi', 's18-sach-' || n, 'Sách S18 ' || n
from generate_series(1, 2) as n;

insert into public.editions (id, book_id, language_code)
select ('a1840000-0000-0000-0000-00000000000' || n)::uuid, ('a1820000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 2) as n;

insert into public.skus (id, edition_id, sku_code)
select ('a1850000-0000-0000-0000-00000000000' || n)::uuid, ('a1840000-0000-0000-0000-00000000000' || n)::uuid, 's18-sku-' || n
from generate_series(1, 2) as n;

insert into public.offers (sku_id, market_code, currency, price_minor)
select ('a1850000-0000-0000-0000-00000000000' || n)::uuid, 'VN', 'VND', 89000
from generate_series(1, 2) as n;

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
select ('a1860000-0000-0000-0000-00000000000' || n)::uuid, ('a1840000-0000-0000-0000-00000000000' || n)::uuid,
       's18/' || n || '.epub', 1, 'published'
from generate_series(1, 2) as n;

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
select ('a1870000-0000-0000-0000-00000000000' || n)::uuid, ('a1860000-0000-0000-0000-00000000000' || n)::uuid, 1,
       's18/' || n || '/manifest.json', 'published'
from generate_series(1, 2) as n;

update public.books b set active_publication_id = ('a1870000-0000-0000-0000-00000000000' || right(b.canonical_key, 1))::uuid
where b.canonical_key in ('s18-book-1', 's18-book-2');

-- The settings row accepts the provider (1)
select lives_ok(
  $$ update public.commerce_settings set payments_enabled = true, payment_provider = 'sepay' $$,
  'commerce_settings accepts sepay');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1800000-0000-0000-0000-000000000001', true);
insert into t_orders values ('own', public.create_ebook_order('a1820000-0000-0000-0000-000000000001'));
insert into t_orders values ('gift', public.create_ebook_order('a1820000-0000-0000-0000-000000000002'));
select public.configure_gift(
  (select order_id from t_orders where label = 'gift'), 's18-recipient@example.test', null,
  encode(extensions.digest(convert_to('s18-gift-token', 'UTF8'), 'sha256'), 'hex'),
  '/vi/gifts/claim/s18-gift-token');
reset role;

-- The order and its payments row are both booked under sepay (2, 3)
select is(
  (select o.payment_provider from public.orders o where o.id = (select order_id from t_orders where label = 'own')),
  'sepay', 'the order is booked under sepay');
select is(
  (select pay.provider from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'own')),
  'sepay', 'the payments row is booked under sepay');

-- A provider the order was not booked under is still refused (4)
select throws_ok(
  $$ select public.apply_payment_event('manual', 's18-evt-wrong',
       (select order_id from t_orders where label = 'own'), 'ext-wrong', 'succeeded', 89000, 'VND', now()) $$,
  'EB016', null, 'a manual event against a sepay order is refused');

-- The call and the assertions are separate statements: a query that both invokes the RPC and
-- reads the rows it writes can plan the read against a snapshot that predates them (see 029).
create temporary table t_paid as
select * from public.apply_payment_event('sepay', 'TXN-S18-1',
  (select order_id from t_orders where label = 'own'), 'NPSETVI001', 'succeeded', 89000, 'VND', now());

-- It completes the order and grants a sepay_payment entitlement (5, 6)
select is((select order_status::text from t_paid), 'completed', 'a sepay event completes the order');
select is(
  (select e.source_type::text from public.entitlements e where e.id in (select unnest(entitlement_ids) from t_paid)),
  'sepay_payment', 'the entitlement records sepay_payment as its source');

-- A repeated delivery changes nothing (7)
select public.apply_payment_event('sepay', 'TXN-S18-1',
  (select order_id from t_orders where label = 'own'), 'NPSETVI001', 'succeeded', 89000, 'VND', now());
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = (select order_id from t_orders where label = 'own')),
  1::bigint, 'a repeated sepay event grants nothing more');

-- A wrong amount is refused (8)
select throws_ok(
  $$ select public.apply_payment_event('sepay', 'TXN-S18-amount',
       (select order_id from t_orders where label = 'gift'), 'NPSETVI002', 'succeeded', 79000, 'VND', now()) $$,
  'EB004', null, 'a sepay event for another amount is refused');

-- A gift order paid through sepay grants the buyer nothing, and the recipient's claim is a
-- sepay_payment entitlement (9, 10). This is the claim_gift mapping.
select public.apply_payment_event('sepay', 'TXN-S18-2',
  (select order_id from t_orders where label = 'gift'), 'NPSETVI002', 'succeeded', 89000, 'VND', now());
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = (select order_id from t_orders where label = 'gift')),
  0::bigint, 'the buyer of a gift order holds nothing');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1800000-0000-0000-0000-000000000002', true);
select public.claim_gift('s18-gift-token');
reset role;

select is(
  (select e.source_type::text from public.entitlements e
   where e.source_order_id = (select order_id from t_orders where label = 'gift')),
  'sepay_payment', 'a claimed sepay gift is a sepay_payment entitlement');

-- An admin can revoke what a sepay order granted (11). S7 left manual_payment out of this list.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1800000-0000-0000-0000-000000000001', true);
select is(
  cardinality(public.revoke_order_entitlement((select order_id from t_orders where label = 'own'), 'Refunded')),
  1, 'revoke_order_entitlement finds a sepay_payment entitlement');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
docker context use orbstack
npm run db:reset && npx supabase test db supabase/tests/069_s18_sepay_provider.sql
```

Expected: FAIL at test 1 with a check-constraint violation on `commerce_settings`.

If `claim_gift` or `configure_gift` rejects the fixture for a reason unrelated to the provider (for example, an email-verification rule on the recipient), read the first passing claim in `supabase/tests/048_s9_gift_lifecycle.sql` and match its fixture; do not weaken the assertion.

- [ ] **Step 3: Write the enum migration**

Create `supabase/migrations/20261012100000_s18_sepay_entitlement_source.sql`:

```sql
-- S18: the SePay payment gateway (docs/superpowers/specs/2026-10-12-s18-sepay-payment-gateway-design.md 7.2).
--
-- The enum value stands alone for the reason 20260922100000 gives: Postgres refuses to use a value
-- added by `alter type ... add value` in the transaction that added it, and
-- 20261012100010_s18_sepay_provider.sql uses it immediately.
alter type public.entitlement_source add value if not exists 'sepay_payment';
```

- [ ] **Step 4: Write the provider migration**

Create `supabase/migrations/20261012100010_s18_sepay_provider.sql`. Start with the constraints:

```sql
-- S18: 'sepay' joins 'simulator' and 'manual' as a payment provider.
--
-- Three check constraints name the providers, and three functions map a provider to an
-- entitlement source or list the order-backed sources. All six change here, together, because S7
-- changed five of them and S9 had to come back for the sixth (revoke_order_entitlement).
--
-- No signature, grant, lock order, or error code changes. Each function below is its latest
-- definition, copied whole, with one line added.

alter table public.payments drop constraint payments_provider_check;
alter table public.payments
  add constraint payments_provider_check
  check (provider in ('disabled', 'simulator', 'manual', 'sepay'));

alter table public.orders drop constraint orders_payment_provider_check;
alter table public.orders
  add constraint orders_payment_provider_check
  check (payment_provider in ('disabled', 'simulator', 'manual', 'sepay'));

alter table public.commerce_settings drop constraint commerce_settings_payment_provider_check;
alter table public.commerce_settings
  add constraint commerce_settings_payment_provider_check
  check (payment_provider in ('simulator', 'manual', 'sepay'));
```

Confirm the third constraint's name before relying on it (it was declared inline in `20260922140000_commerce_payment_provider.sql`, so Postgres named it):

```bash
psql "$(npx supabase status -o env | sed -n 's/^DB_URL=//p' | tr -d '"')" -c "select conname from pg_constraint where conrelid = 'public.commerce_settings'::regclass and contype = 'c';"
```

Expected: a row `commerce_settings_payment_provider_check`. If the name differs, use the name printed.

Then append the three functions. For each, copy the source range exactly, change `create function` to `create or replace function`, and make the one edit. Do not copy the `drop function`, `revoke`, or `grant` lines: `create or replace` keeps the existing grants.

| Function | Copy from | Edit |
| --- | --- | --- |
| `public.claim_gift(text)` | `supabase/migrations/20260924160000_s9_gift_lifecycle.sql` lines 281-423 | After the line `when v_order.payment_provider = 'manual' then 'manual_payment'::public.entitlement_source` add `when v_order.payment_provider = 'sepay' then 'sepay_payment'::public.entitlement_source` |
| `public.apply_payment_event(text, text, uuid, text, text, bigint, text, timestamptz)` | the same file, lines 460-644 | After the line `when 'manual' then 'manual_payment'::public.entitlement_source` add `when 'sepay' then 'sepay_payment'::public.entitlement_source` |
| `public.revoke_order_entitlement(uuid, text)` | `supabase/migrations/20260924100000_s9_multi_item_orders.sql` lines 435-512 | In **both** occurrences, change `in ('free_order', 'simulated_payment', 'manual_payment')` to `in ('free_order', 'simulated_payment', 'manual_payment', 'sepay_payment')` |

Before copying, confirm no later migration redefined any of the three:

```bash
command grep -l -E "function public\.(claim_gift|apply_payment_event|revoke_order_entitlement)\(" supabase/migrations/*.sql | tail -3
```

Expected: the last file listed for each function is the one named in the table. If a later file appears, copy from that file instead.

Then confirm nothing else in the schema lists providers or order-backed sources:

```bash
npm run db:reset
psql "$(npx supabase status -o env | sed -n 's/^DB_URL=//p' | tr -d '"')" -At -c "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.prosrc like '%manual_payment''%' or p.prosrc like '%''manual''%') order by 1;"
```

Expected: every function printed is either one of the three above or a manual-only function (`confirm_manual_payment`, `reject_manual_payment`, `claim_manual_transfer`, and the manual admin and operations readers). Open any other function, and if it lists providers or sources generically, add it to this migration with `sepay` included and add a pgTAP assertion for it.

- [ ] **Step 5: Run the database tests**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, all files, including `069_s18_sepay_provider.sql`.

- [ ] **Step 6: Regenerate types and update the hand-written unions**

```bash
npx supabase gen types typescript --local > lib/supabase/database.types.ts
git diff --stat lib/supabase/database.types.ts
```

Expected: the diff adds `"sepay_payment"` to `entitlement_source` in two places and nothing else. If the file's header or formatting changed wholesale, check `docs/runbooks/testing-environments.md` for the project's own generation command and use that instead.

In `lib/data/admin-orders.ts` (lines 37 and 140) and `lib/data/users.ts` (line 14), add `| "sepay_payment"` to the `sourceType` / `source_type` union.

Run: `npm run typecheck && npx vitest run lib/data`
Expected: PASS. If an admin component switches over the source type to pick a label and now fails exhaustiveness, add a `sepay_payment` label ("SePay payment" / "Thanh toán SePay") to both dictionaries at that key.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261012100000_s18_sepay_entitlement_source.sql supabase/migrations/20261012100010_s18_sepay_provider.sql supabase/tests/069_s18_sepay_provider.sql lib/supabase/database.types.ts lib/data/admin-orders.ts lib/data/users.ts
git commit -m "feat(s18): sepay provider and entitlement source in the database"
```

---

### Task 5: Provider, order lookup, and the IPN endpoint

**Files:**
- Modify: `lib/commerce/sepay.ts`, `lib/commerce/payment-provider.ts`, `lib/commerce/simulator-webhook.ts`, `lib/access/grant.ts`, `lib/i18n/routes.ts`
- Create: `lib/commerce/payment-outcome.ts`, `lib/commerce/sepay-ipn.ts`, `app/api/payments/sepay/ipn/route.ts`
- Test: `lib/commerce/sepay-ipn.test.ts`, `lib/commerce/payment-provider.test.ts`, `lib/i18n/routes.test.ts`

**Interfaces:**
- Consumes: Task 2 `env.sepay`; Task 3 `SepayConfig`, `hasValidSepaySecret`, `parseSepayNotification`, `SEPAY_SECRET_HEADER`, the two error classes.
- Produces:
  - `findOrderIdByReference(referenceCode: string): Promise<string | null>` in `lib/access/grant.ts`
  - `getCommerceRoutes(locale).checkoutSepay(orderId: string): string`
  - `class SepayProvider implements PaymentProvider` with `constructor(config: SepayConfig)`
  - `InvalidSepaySecretError`, `SepayOrderNotFoundError` (has `invoiceNumber`, `externalPaymentId`)
  - `recordPaymentOutcome(event: VerifiedPaymentEvent, outcome: AppliedPaymentEventOutcome, requestId: string): Promise<void>`
  - `handleSepayIpn(request: Request): Promise<Response>`

- [ ] **Step 1: Write the failing handler tests**

Create `lib/commerce/sepay-ipn.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyVerifiedPaymentEvent, findOrderIdByReference } from "@/lib/access/grant";
import { trackEventBestEffort } from "@/lib/analytics/events";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import { handleSepayIpn } from "@/lib/commerce/sepay-ipn";
import { getServerEnv } from "@/lib/config/server-env";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/access/grant", () => ({ applyVerifiedPaymentEvent: vi.fn(), findOrderIdByReference: vi.fn() }));
vi.mock("@/lib/analytics/events", () => ({ trackEventBestEffort: vi.fn() }));

const SECRET = "secret_test_key";
const ORDER_ID = "10000000-0000-4000-8000-000000000001";
const sepay = { merchantId: "MERCHANT_TEST", secretKey: SECRET, env: "sandbox" } as const;

function env(overrides: Record<string, unknown> = {}) {
  return { appEnv: "test", paymentProvider: "sepay", sepay, ...overrides } as unknown as ReturnType<typeof getServerEnv>;
}

const paid = {
  timestamp: 1757058220,
  notification_type: "ORDER_PAID",
  order: {
    order_id: "NPSETVI00101000042R",
    order_status: "CAPTURED",
    order_currency: "VND",
    order_amount: "89000.00",
    order_invoice_number: "IB-7K2MX-89000",
  },
  transaction: { transaction_id: "TXN-1", payment_method: "BANK_TRANSFER", transaction_status: "APPROVED" },
};

function ipn(body: unknown = paid, secret: string | null = SECRET): Request {
  return new Request("https://books.test/api/payments/sepay/ipn", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-12345678", ...(secret ? { "X-Secret-Key": secret } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue(env());
  vi.mocked(findOrderIdByReference).mockResolvedValue(ORDER_ID);
  vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({ entitlementIds: ["e1"], orderStatus: "completed", paymentStatus: "succeeded" });
  vi.mocked(trackEventBestEffort).mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSepayIpn", () => {
  it("applies a paid order and answers the way SePay expects", async () => {
    const response = await handleSepayIpn(ipn());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(findOrderIdByReference).toHaveBeenCalledWith("IB-7K2MX");
    expect(applyVerifiedPaymentEvent).toHaveBeenCalledWith({
      provider: "sepay",
      eventId: "TXN-1",
      externalPaymentId: "NPSETVI00101000042R",
      orderId: ORDER_ID,
      status: "succeeded",
      amountMinor: 89000,
      currency: "VND",
      occurredAt: "2025-09-05T07:43:40.000Z",
    });
    expect(trackEventBestEffort).toHaveBeenCalledWith(
      { eventName: "purchase", dedupeKey: `purchase/${ORDER_ID}`, orderId: ORDER_ID },
      expect.anything(),
    );
  });

  // apply_payment_event ignores a repeated event ID and returns the order as it stands.
  it("answers 200 for a repeat", async () => {
    await handleSepayIpn(ipn());
    const second = await handleSepayIpn(ipn());
    expect(second.status).toBe(200);
  });

  it("flags a paid cancelled order on first delivery and replay", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({
      entitlementIds: [], orderStatus: "cancelled", paymentStatus: "cancelled",
    });
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await handleSepayIpn(ipn());
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "manual_resolution_required" });
    }
    expect(trackEventBestEffort).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      requestId: "req-12345678", orderId: ORDER_ID, eventId: "TXN-1",
      invoiceNumber: "IB-7K2MX-89000", externalPaymentId: "NPSETVI00101000042R",
      amountMinor: 89000, currency: "VND",
    }));
  });

  it("is 404 when SePay is not configured", async () => {
    vi.mocked(getServerEnv).mockReturnValue(env({ sepay: null, paymentProvider: "manual" }));
    expect((await handleSepayIpn(ipn())).status).toBe(404);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  // A reader may be on SePay's page when the operator switches providers (spec 6.3).
  it("still settles when the deployment has moved to another provider", async () => {
    vi.mocked(getServerEnv).mockReturnValue(env({ paymentProvider: "manual" }));
    expect((await handleSepayIpn(ipn())).status).toBe(200);
    expect(applyVerifiedPaymentEvent).toHaveBeenCalledOnce();
  });

  it.each([["missing", null], ["wrong", "not-the-secret"]])("is 401 for a %s secret, before any lookup", async (_label, secret) => {
    const response = await handleSepayIpn(ipn(paid, secret));
    expect(response.status).toBe(401);
    expect(findOrderIdByReference).not.toHaveBeenCalled();
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  it("is 400 for a malformed body", async () => {
    expect((await handleSepayIpn(ipn("{"))).status).toBe(400);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  it("acknowledges a notification that is not a payment, without applying it", async () => {
    const response = await handleSepayIpn(ipn({ ...paid, notification_type: "TRANSACTION_VOID" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  it("is 422 when no order has that reference", async () => {
    vi.mocked(findOrderIdByReference).mockResolvedValue(null);
    expect((await handleSepayIpn(ipn())).status).toBe(422);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  // The reader paid an amount the order no longer has (a coupon was applied after the QR was
  // shown). The money is in the bank and the order is not completed, so the log is the only trail.
  it("logs what an operator needs when apply_payment_event refuses the event", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new PaymentEventRejectedError());
    const response = await handleSepayIpn(ipn());

    expect(response.status).toBe(422);
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        requestId: "req-12345678",
        orderId: ORDER_ID,
        invoiceNumber: "IB-7K2MX-89000",
        externalPaymentId: "NPSETVI00101000042R",
        amountMinor: 89000,
      }),
    );
  });

  it("is 500 for an unexpected failure, so SePay retries", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new Error("database is down"));
    expect((await handleSepayIpn(ipn())).status).toBe(500);
  });

  it("never logs the secret or echoes it", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new Error("boom"));
    const response = await handleSepayIpn(ipn());
    const logged = JSON.stringify([vi.mocked(console.error).mock.calls, vi.mocked(console.warn).mock.calls]);
    expect(logged).not.toContain(SECRET);
    expect(await response.text()).not.toContain(SECRET);
  });
});
```

If the request-ID header in this repository is not `x-request-id`, read `REQUEST_ID_HEADER` from `lib/observability/request-id.ts` and use that constant in the `ipn()` helper.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/commerce/sepay-ipn.test.ts`
Expected: FAIL, cannot resolve `@/lib/commerce/sepay-ipn`.

- [ ] **Step 3: Add the route helper and the order lookup**

In `lib/i18n/routes.ts`, inside `getCommerceRoutes`, after `checkoutTransfer`:

```ts
    checkoutSepay: (orderId: string) => withLocale(locale, `/checkout/${orderId}/sepay`),
```

Add to `lib/i18n/routes.test.ts`, in the block that covers `getCommerceRoutes`:

```ts
  it("builds the SePay hand-off path", () => {
    expect(getCommerceRoutes("vi").checkoutSepay("o1")).toBe("/vi/checkout/o1/sepay");
  });
```

In `lib/access/grant.ts`, directly above `applyVerifiedPaymentEvent`:

```ts
// The order a provider's notification names by its reference code. Service role, so it is called
// only after the notification has been authenticated - the same condition applyVerifiedPaymentEvent
// runs under. It returns an ID and nothing else.
export async function findOrderIdByReference(referenceCode: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("orders")
    .select("id")
    .eq("reference_code", referenceCode)
    .maybeSingle();
  if (error) {
    throw new Error(`findOrderIdByReference: ${error.message}`);
  }
  return data?.id ?? null;
}
```

- [ ] **Step 4: Move `recordPaymentOutcome` to a shared module**

Create `lib/commerce/payment-outcome.ts` with the function cut from `lib/commerce/simulator-webhook.ts`, exported, comment unchanged:

```ts
import "server-only";

import type { AppliedPaymentEventOutcome } from "@/lib/access/grant";
import { trackEventBestEffort } from "@/lib/analytics/events";
import type { VerifiedPaymentEvent } from "@/lib/commerce/types";

// Payment analytics from the state apply_payment_event RETURNED, never from the event's own status
// (S5 spec 8.3): a replay or an out-of-order event reports the order as it now stands. Keys are
// deterministic - purchase by order, payment_failed by provider event - so a replay inserts nothing.
// Runs after the payment has committed and cannot throw into the response.
export async function recordPaymentOutcome(
  event: VerifiedPaymentEvent,
  outcome: AppliedPaymentEventOutcome,
  requestId: string,
): Promise<void> {
  try {
    if (outcome.orderStatus === "completed" && outcome.paymentStatus === "succeeded") {
      await trackEventBestEffort(
        { eventName: "purchase", dedupeKey: `purchase/${event.orderId}`, orderId: event.orderId },
        { requestId },
      );
    } else if (outcome.paymentStatus === "failed") {
      await trackEventBestEffort(
        { eventName: "payment_failed", dedupeKey: `payment-failed/${event.eventId}`, orderId: event.orderId },
        { requestId },
      );
    }
  } catch {
    // trackEventBestEffort logs its own failures; the payment result stands either way.
  }
}
```

In `lib/commerce/simulator-webhook.ts`, delete the local `recordPaymentOutcome` and its comment, delete the now-unused `trackEventBestEffort` import, change the grant import to `import { applyVerifiedPaymentEvent } from "@/lib/access/grant";`, and add `import { recordPaymentOutcome } from "@/lib/commerce/payment-outcome";`.

Run: `npx vitest run lib/commerce/simulator-webhook.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Add the provider**

Append to `lib/commerce/sepay.ts`, and add these imports at the top of the file:

```ts
import { findOrderIdByReference } from "@/lib/access/grant";
import type { CheckoutSessionInput, PaymentProvider, VerifiedPaymentEvent } from "@/lib/commerce/types";
```

```ts
export class InvalidSepaySecretError extends Error {
  constructor() {
    super("SepayProvider.verifyEvent: missing or invalid X-Secret-Key");
    this.name = "InvalidSepaySecretError";
  }
}

// SePay took a payment for a reference no order has. The fields are what an operator needs to
// find the money.
export class SepayOrderNotFoundError extends Error {
  constructor(
    readonly invoiceNumber: string,
    readonly externalPaymentId: string,
  ) {
    super("SepayProvider.verifyEvent: no order has this reference");
    this.name = "SepayOrderNotFoundError";
  }
}

export class SepayProvider implements PaymentProvider {
  constructor(private readonly config: SepayConfig) {}

  // SePay's checkout takes a signed form POST, which a redirect cannot carry, so Pay lands on a
  // page of ours that posts it.
  async createSession(input: CheckoutSessionInput): Promise<{ redirectUrl: string }> {
    return { redirectUrl: getCommerceRoutes(input.locale).checkoutSepay(input.orderId) };
  }

  // The secret is checked before the body is parsed and before any database read. The invoice
  // number rides along for the handler's logs; it is not part of the provider-neutral event.
  async verifyEvent(request: Request): Promise<VerifiedPaymentEvent & { invoiceNumber: string }> {
    if (!hasValidSepaySecret(request.headers.get(SEPAY_SECRET_HEADER), this.config.secretKey)) {
      throw new InvalidSepaySecretError();
    }
    const paid = parseSepayNotification(await request.text());
    const orderId = await findOrderIdByReference(paid.referenceCode);
    if (!orderId) throw new SepayOrderNotFoundError(paid.invoiceNumber, paid.externalPaymentId);
    return {
      provider: "sepay",
      eventId: paid.eventId,
      externalPaymentId: paid.externalPaymentId,
      orderId,
      status: "succeeded",
      amountMinor: paid.amountMinor,
      currency: paid.currency,
      occurredAt: paid.occurredAt,
      invoiceNumber: paid.invoiceNumber,
    };
  }
}
```

`lib/commerce/sepay.test.ts` now imports a module that imports `lib/access/grant`. Add at the top of that test file, below the imports:

```ts
vi.mock("@/lib/access/grant", () => ({ findOrderIdByReference: vi.fn() }));
```

and add `vi` to its `vitest` import.

In `lib/commerce/payment-provider.ts`, import `SepayProvider`, widen the `Pick` to include `"sepay"`, and add before the final `throw`:

```ts
  // parseServerEnv guarantees the settings exist when the provider is sepay; this is for a caller
  // that hands in an environment it built itself.
  if (env.paymentProvider === "sepay" && env.sepay) {
    return new SepayProvider(env.sepay);
  }
```

The signature becomes `getPaymentProvider(env: Pick<ServerEnv, "appEnv" | "paymentProvider" | "simulatorSecret" | "sepay">)`.

Add to `lib/commerce/payment-provider.test.ts`:

```ts
  it("returns the SePay provider, which sends Pay to the hand-off page", async () => {
    const provider = getPaymentProvider({
      appEnv: "test",
      paymentProvider: "sepay",
      simulatorSecret: null,
      sepay: { merchantId: "M", secretKey: "s", env: "sandbox" },
    });
    expect(await provider.createSession({ orderId: "o1", locale: "vi" })).toEqual({ redirectUrl: "/vi/checkout/o1/sepay" });
  });
```

Add `sepay: null` to the environment objects the existing cases in that file pass, so they still typecheck. If that test file does not already mock `@/lib/access/grant`, add `vi.mock("@/lib/access/grant", () => ({ findOrderIdByReference: vi.fn() }));`.

- [ ] **Step 6: Add the handler and the route**

Create `lib/commerce/sepay-ipn.ts`:

```ts
import "server-only";

import { applyVerifiedPaymentEvent } from "@/lib/access/grant";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import { recordPaymentOutcome } from "@/lib/commerce/payment-outcome";
import {
  InvalidSepaySecretError,
  MalformedSepayNotificationError,
  SepayNotificationIgnoredError,
  SepayOrderNotFoundError,
  SepayProvider,
} from "@/lib/commerce/sepay";
import type { VerifiedPaymentEvent } from "@/lib/commerce/types";
import { getServerEnv } from "@/lib/config/server-env";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";

function respond(status: number, body: Record<string, unknown>, requestId: string): Response {
  return Response.json({ ...body, requestId }, { status, headers: { [REQUEST_ID_HEADER]: requestId } });
}

// SePay's payment notification (S18 spec 6). The only path by which a SePay order completes.
//
// It answers whenever SePay credentials are configured, not only while PAYMENT_PROVIDER=sepay: a
// reader can be on SePay's page when an operator switches providers, and their payment must still
// settle while the order remains pending. A stale-order cancellation is preserved and flagged
// for manual resolution. apply_payment_event checks the booked provider (EB016).
//
// 200 tells SePay the notification is dealt with. 422 means SePay took money this application could
// not attach to an order; it is logged with everything an operator needs to find it.
export async function handleSepayIpn(request: Request): Promise<Response> {
  const requestId = getRequestId(request.headers);
  const env = getServerEnv();
  if (!env.sepay) {
    console.warn("SePay IPN received, but SePay is not configured.", { requestId });
    return respond(404, { error: "not_found" }, requestId);
  }

  let verified: VerifiedPaymentEvent & { invoiceNumber: string };
  try {
    verified = await new SepayProvider(env.sepay).verifyEvent(request);
  } catch (error) {
    if (error instanceof InvalidSepaySecretError) {
      console.warn("SePay IPN rejected: bad secret.", { requestId });
      return respond(401, { error: "unauthorized" }, requestId);
    }
    if (error instanceof MalformedSepayNotificationError) {
      console.warn("SePay IPN rejected: malformed.", { requestId, reason: error.message });
      return respond(400, { error: "malformed_event" }, requestId);
    }
    if (error instanceof SepayNotificationIgnoredError) {
      console.warn("SePay IPN acknowledged without action.", { requestId, reason: error.reason });
      return respond(200, { success: true }, requestId);
    }
    if (error instanceof SepayOrderNotFoundError) {
      console.error("SePay IPN names no order. A payment may need a refund.", {
        requestId,
        invoiceNumber: error.invoiceNumber,
        externalPaymentId: error.externalPaymentId,
      });
      return respond(422, { error: "event_rejected" }, requestId);
    }
    console.error("SePay IPN could not be verified.", { requestId, error: String(error) });
    return respond(500, { error: "unexpected" }, requestId);
  }

  // Only the provider-neutral fields go on: the invoice number is for the logs below.
  const { invoiceNumber, ...event } = verified;
  try {
    const outcome = await applyVerifiedPaymentEvent(event);
    if (outcome.orderStatus === "cancelled") {
      // The RPC records the event but intentionally preserves the cancelled order.
      // Preserve payment details in the operational log on first delivery AND retries.
      console.error("SePay IPN paid a cancelled order. Manual resolution required.", {
        requestId, orderId: event.orderId, eventId: event.eventId, invoiceNumber,
        externalPaymentId: event.externalPaymentId, amountMinor: event.amountMinor,
        currency: event.currency,
      });
      return respond(422, { error: "manual_resolution_required" }, requestId);
    }
    await recordPaymentOutcome(event, outcome, requestId);
    return respond(200, { success: true, orderStatus: outcome.orderStatus, paymentStatus: outcome.paymentStatus }, requestId);
  } catch (error) {
    if (error instanceof PaymentEventRejectedError) {
      console.error("SePay IPN does not match its order. A payment may need a refund or a manual grant.", {
        requestId,
        orderId: event.orderId,
        eventId: event.eventId,
        invoiceNumber,
        externalPaymentId: event.externalPaymentId,
        amountMinor: event.amountMinor,
      });
      return respond(422, { error: "event_rejected" }, requestId);
    }
    console.error("SePay IPN failed.", { requestId, orderId: event.orderId, eventId: event.eventId, error: String(error) });
    return respond(500, { error: "unexpected" }, requestId);
  }
}
```

The first handler test asserts `applyVerifiedPaymentEvent` receives exactly the eight provider-neutral fields, so an invoice number leaking through fails it.

Create `app/api/payments/sepay/ipn/route.ts`:

```ts
import { handleSepayIpn } from "@/lib/commerce/sepay-ipn";

// SePay's payment notification. Authenticated by the X-Secret-Key header; 404 when SePay is not
// configured on this deployment.
export async function POST(request: Request) {
  return handleSepayIpn(request);
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run lib/commerce lib/i18n/routes.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/commerce lib/access/grant.ts lib/i18n/routes.ts lib/i18n/routes.test.ts app/api/payments/sepay
git commit -m "feat(s18): sepay provider and payment notification endpoint"
```

---

### Task 6: The hand-off page and the return states

**Files:**
- Create: `app/[lang]/(account)/checkout/[orderId]/sepay/page.tsx`, `app/[lang]/(account)/checkout/[orderId]/sepay/auto-submit-form.tsx`
- Modify: `app/[lang]/(account)/checkout/[orderId]/status/page.tsx`, `lib/i18n/dictionaries/en.json`, `lib/i18n/dictionaries/vi.json`
- Test: `app/[lang]/(account)/checkout/[orderId]/sepay/page.test.tsx`, `app/[lang]/(account)/checkout/[orderId]/status/page.test.tsx`

**Interfaces:**
- Consumes: Task 2 `env.sepay`; Task 3 `buildSepayCheckoutFields`, `sepayCheckoutUrl`; Task 5 `checkoutSepay`.

- [ ] **Step 1: Write the failing page tests**

Create `app/[lang]/(account)/checkout/[orderId]/sepay/page.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CheckoutSepayPage from "@/app/[lang]/(account)/checkout/[orderId]/sepay/page";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/orders", () => ({ getCustomerOrder: vi.fn() }));
vi.mock("@/lib/access/grant", () => ({ findOrderIdByReference: vi.fn() }));
// The real component submits the form on mount, which jsdom cannot do.
vi.mock("@/app/[lang]/(account)/checkout/[orderId]/sepay/auto-submit-form", () => ({
  AutoSubmitForm: ({ action, fields, children }: { action: string; fields: Array<[string, string]>; children: React.ReactNode }) => (
    <form action={action} data-testid="sepay-form" method="post">
      {fields.map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} readOnly />
      ))}
      {children}
    </form>
  ),
}));

const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const order: CustomerOrderDTO = {
  id: ORDER_ID,
  bundleId: null,
  title: "A Book",
  items: [{ bookId: "30000000-0000-4000-8000-000000000001", title: "A Book", hasActiveEntitlement: false }],
  status: "pending",
  paymentStatus: "pending",
  totalMinor: 89000,
  currency: "VND",
  subtotalMinor: 89000,
  discountMinor: 0,
  couponCode: null,
  createdAt: "2026-10-12T00:00:00Z",
  hasAllActiveEntitlements: false,
  referenceCode: "IB-7K2MX",
  provider: "sepay",
  claimedAt: null,
  declinedAt: null,
  declineReason: null,
};

const params = Promise.resolve({ lang: "en", orderId: ORDER_ID });
const STATUS = `/en/checkout/${ORDER_ID}/status`;
const sepay = { merchantId: "MERCHANT_TEST", secretKey: "secret_test_key", env: "sandbox" } as const;

function env(overrides: Record<string, unknown> = {}) {
  return { appEnv: "test", paymentProvider: "sepay", siteUrl: "https://books.test", sepay, ...overrides } as unknown as ReturnType<typeof getServerEnv>;
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue(env());
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
});

describe("CheckoutSepayPage", () => {
  it("renders the signed form for SePay's sandbox, in signing order, without the secret", async () => {
    const { container } = render(await CheckoutSepayPage({ params }));

    const form = screen.getByTestId("sepay-form");
    expect(form).toHaveAttribute("action", "https://pay-sandbox.sepay.vn/v1/checkout/init");
    const names = Array.from(form.querySelectorAll("input")).map((input) => input.name);
    expect(names).toEqual([
      "operation", "payment_method", "order_invoice_number", "order_amount", "currency",
      "order_description", "success_url", "error_url", "cancel_url", "merchant", "signature",
    ]);
    expect(form.querySelector<HTMLInputElement>('input[name="order_invoice_number"]')!.value).toBe("IB-7K2MX-89000");
    expect(form.querySelector<HTMLInputElement>('input[name="order_amount"]')!.value).toBe("89000");
    expect(form.querySelector<HTMLInputElement>('input[name="success_url"]')!.value).toBe(
      `https://books.test${STATUS}?sepay=success`,
    );
    expect(container.innerHTML).not.toContain("secret_test_key");
    expect(screen.getByRole("button", { name: "Continue to SePay" })).toBeInTheDocument();
  });

  it("asks for a signed-in reader itself", async () => {
    await CheckoutSepayPage({ params });
    expect(requireUser).toHaveBeenCalledWith("en", `/en/checkout/${ORDER_ID}/sepay`);
  });

  it("is not found for an order the reader does not own", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(null);
    await expect(CheckoutSepayPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([
    ["the order is already completed", { status: "completed", paymentStatus: "succeeded" }, {}],
    ["the reader already owns everything in it", { hasAllActiveEntitlements: true }, {}],
    ["the order was booked under another provider", { provider: "manual" }, {}],
    ["the deployment runs another provider", {}, { paymentProvider: "manual" }],
    ["the order is not in VND", { currency: "USD" }, {}],
  ])("sends the reader to the status page when %s", async (_label, orderOverrides, envOverrides) => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, ...orderOverrides } as CustomerOrderDTO);
    vi.mocked(getServerEnv).mockReturnValue(env(envOverrides));
    await expect(CheckoutSepayPage({ params })).rejects.toThrow(`NEXT_REDIRECT ${STATUS}`);
  });
});
```

Append to the `describe` in `app/[lang]/(account)/checkout/[orderId]/status/page.test.tsx`. These use that file's existing `order`, `params`, and `env` helpers:

```tsx
  describe("returning from SePay", () => {
    const sepayOrder = { ...order, provider: "sepay", status: "pending", paymentStatus: "pending" } as CustomerOrderDTO;

    beforeEach(() => {
      vi.mocked(getServerEnv).mockReturnValue(env("sepay"));
      vi.mocked(getCustomerOrder).mockResolvedValue(sepayOrder);
    });

    // The reader is usually back before SePay's notification arrives.
    it("shows processing after a successful payment that has not been notified yet", async () => {
      render(await CheckoutStatusPage({ params, searchParams: Promise.resolve({ sepay: "success" }) }));
      expect(screen.getByRole("heading", { level: 1, name: "Processing your payment" })).toBeInTheDocument();
    });

    it.each(["cancel", "error"])("offers Try again after ?sepay=%s", async (value) => {
      render(await CheckoutStatusPage({ params, searchParams: Promise.resolve({ sepay: value }) }));
      expect(screen.getByRole("heading", { level: 1, name: "Payment did not go through" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", `/en/checkout/${ORDER_ID}`);
    });

    // The parameter picks a view for a pending order only. It is in the address bar, so a reload
    // after the order completed must not hide the book.
    it("ignores ?sepay=cancel once the order is completed", async () => {
      vi.mocked(getCustomerOrder).mockResolvedValue({
        ...sepayOrder,
        status: "completed",
        paymentStatus: "succeeded",
        hasAllActiveEntitlements: true,
      } as CustomerOrderDTO);
      render(await CheckoutStatusPage({ params, searchParams: Promise.resolve({ sepay: "cancel" }) }));
      expect(screen.getByRole("heading", { level: 1, name: "Payment complete" })).toBeInTheDocument();
    });

    it("ignores the parameter on an order from another provider", async () => {
      vi.mocked(getServerEnv).mockReturnValue(env("simulator"));
      vi.mocked(getCustomerOrder).mockResolvedValue({ ...sepayOrder, provider: "simulator" } as CustomerOrderDTO);
      render(await CheckoutStatusPage({ params, searchParams: Promise.resolve({ sepay: "cancel" }) }));
      expect(screen.getByRole("heading", { level: 1, name: "Processing your payment" })).toBeInTheDocument();
    });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run "app/[lang]/(account)/checkout/[orderId]/sepay" "app/[lang]/(account)/checkout/[orderId]/status"`
Expected: FAIL. The sepay page does not resolve; the status cases for `cancel` and `error` show "Processing your payment".

- [ ] **Step 3: Add the copy**

In `lib/i18n/dictionaries/en.json`, inside `"checkout"`, beside `"simulate"`:

```json
    "sepay": {
      "eyebrow": "Payment",
      "title": "Taking you to SePay",
      "description": "You will pay by scanning a VietQR code with your banking app. If nothing happens, use the button below.",
      "continue": "Continue to SePay"
    },
```

In `lib/i18n/dictionaries/vi.json`, at the same place:

```json
    "sepay": {
      "eyebrow": "Thanh toán",
      "title": "Đang chuyển bạn đến SePay",
      "description": "Bạn sẽ thanh toán bằng cách quét mã VietQR trong ứng dụng ngân hàng. Nếu trang không tự chuyển, hãy bấm nút bên dưới.",
      "continue": "Tiếp tục đến SePay"
    },
```

- [ ] **Step 4: Add the form component**

Create `app/[lang]/(account)/checkout/[orderId]/sepay/auto-submit-form.tsx`:

```tsx
"use client";

import { type ReactNode, useEffect, useRef } from "react";

// SePay's checkout takes a form POST, so the hand-off cannot be a redirect. The form submits itself
// once mounted; its children hold a visible button for a browser where that does not happen. The
// inputs are rendered in the order given, because SePay's signature covers that order.
export function AutoSubmitForm({
  action,
  fields,
  children,
}: {
  action: string;
  fields: Array<[string, string]>;
  children: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.submit();
  }, []);

  return (
    <form action={action} method="post" ref={form}>
      {fields.map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      {children}
    </form>
  );
}
```

- [ ] **Step 5: Add the page**

Create `app/[lang]/(account)/checkout/[orderId]/sepay/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { buildSepayCheckoutFields, sepayCheckoutUrl } from "@/lib/commerce/sepay";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCommerceRoutes } from "@/lib/i18n/routes";

import { AutoSubmitForm } from "./auto-submit-form";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ lang: string; orderId: string }> };

// The hand-off to SePay's hosted payment page (S18 spec 5.3). Everything posted is built here from
// the order row; nothing comes from the request. The form carries a signature and no secret.
//
// Any order this page cannot hand off goes to the status page, which explains it. The provider is
// checked on the order AND on the environment, as the transfer page does: an order booked under
// another provider cannot be settled by a SePay notification (EB016), and a deployment that has
// left SePay should start no new payments on it.
export default async function CheckoutSepayPage({ params }: Props) {
  const { lang: locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.checkoutSepay(orderId));

  const order = await getCustomerOrder(orderId);
  if (!order) notFound();

  const env = getServerEnv();
  const status = commerce.checkoutStatus(order.id);
  if (order.status !== "pending" || order.hasAllActiveEntitlements) redirect(status);
  if (order.provider !== "sepay" || env.paymentProvider !== "sepay" || !env.sepay) redirect(status);

  const fields = buildSepayCheckoutFields({ order, locale, siteUrl: env.siteUrl, config: env.sepay });
  if (!fields) redirect(status);

  const dictionary = await getDictionary(locale);
  const copy = dictionary.checkout.sepay;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{copy.title}</h1>
        <p className="mb-8 text-[0.9375rem] text-ink-soft">{copy.description}</p>
        <p className="mb-8 border-y border-hairline py-4">
          <span className="font-serif text-xl">{order.title}</span>
          <span className="ml-3 font-medium">{formatPrice(order.totalMinor, order.currency, locale)}</span>
        </p>
        <AutoSubmitForm action={sepayCheckoutUrl(env.sepay.env)} fields={fields}>
          <Button size="lg" type="submit">
            {copy.continue}
          </Button>
        </AutoSubmitForm>
      </main>
    </div>
  );
}
```

- [ ] **Step 6: Teach the status page the return parameter**

In `app/[lang]/(account)/checkout/[orderId]/status/page.tsx`:

Change `Props` and the signature. `searchParams` is optional in the type so the existing tests, which pass only `params`, keep compiling:

```tsx
type Props = {
  params: Promise<{ lang: string; orderId: string }>;
  searchParams?: Promise<{ sepay?: string | string[] }>;
};

export default async function CheckoutStatusPage({ params, searchParams }: Props) {
```

Rename the existing `const view = paymentsOff ? ... : checkoutStatusView(order);` declaration to `const baseView = ...` without touching its expression, and add directly below it:

```tsx
  // S18. SePay sends a reader who cancelled or hit an error back here with a marker. The order is
  // still pending and nothing has failed in the database, so without this the page would say
  // "processing" and offer no way back to checkout. The marker picks a VIEW for a pending SePay
  // order and does nothing else: it is in the address bar, so it must never outrank the order.
  const sepayReturn = (await searchParams)?.sepay;
  const view =
    baseView === "processing" && order.provider === "sepay" && (sepayReturn === "cancel" || sepayReturn === "error")
      ? "failed"
      : baseView;
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run "app/[lang]/(account)/checkout" lib/i18n && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Check the reader's other order pages**

`payOrderAction` needs no change: it already redirects to whatever `createSession` returns. Confirm with a test in `app/[lang]/(account)/checkout/[orderId]/actions.test.ts`, using that file's existing mocks and order fixture:

```ts
  it("hands a SePay order to the SePay hand-off page", async () => {
    vi.mocked(getServerEnv).mockReturnValue({
      appEnv: "test",
      paymentProvider: "sepay",
      simulatorSecret: null,
      sepay: { merchantId: "M", secretKey: "s", env: "sandbox" },
    } as unknown as ReturnType<typeof getServerEnv>);
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, provider: "sepay" });

    await expect(payOrderAction("vi", order.id)).rejects.toThrow(`NEXT_REDIRECT /vi/checkout/${order.id}/sepay`);
  });
```

If that file mocks `getPaymentProvider` instead of using the real one, assert the mock was called with an environment whose `paymentProvider` is `"sepay"` instead.

Run: `npx vitest run "app/[lang]/(account)"`
Expected: PASS. `/account/orders/[orderId]` already sends a non-manual pending order to checkout with **Continue checkout**, which is right for SePay.

- [ ] **Step 9: Commit**

```bash
git add "app/[lang]/(account)/checkout" lib/i18n/dictionaries
git commit -m "feat(s18): sepay hand-off page and return states"
```

---

### Task 7: End-to-end journey

A provider is a property of the running server, so SePay gets its own web server, as S7 gave the manual provider one. SePay itself is never contacted: the browser's POST to SePay is intercepted, and the test plays SePay's part by posting the notification.

**Files:**
- Modify: `e2e/support/server-env.ts`, `e2e/support/commerce.ts`, `playwright.config.ts`
- Create: `e2e/sepay-payment.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `sepayServerUrl`, `sepayServerPort`, `sepayDefaults`, `sepayValue(name)` in `e2e/support/server-env.ts`; `enableSepayPayments()` in `e2e/support/commerce.ts`; Playwright project `chromium-sepay`.

- [ ] **Step 1: Add the server settings**

In `e2e/support/server-env.ts`, below `manualServerPort`:

```ts
// S18: a third origin, for the same reason as the second. PAYMENT_PROVIDER=sepay.
export const sepayServerUrl = "http://127.0.0.1:3200";
export const sepayServerPort = new URL(sepayServerUrl).port;
```

At the end of the file:

```ts
// S18: what the SePay web server is started with. Sandbox, and not real credentials: the spec
// intercepts the browser's POST to SePay and posts the notification itself with this secret.
export const sepayDefaults = {
  SEPAY_MERCHANT_ID: "E2E_MERCHANT",
  SEPAY_SECRET_KEY: "e2e-sepay-secret-not-for-real-use",
  SEPAY_ENV: "sandbox",
} as const;

export type SepayName = keyof typeof sepayDefaults;

export function sepayValue(name: SepayName): string {
  return process.env[name] ?? sepayDefaults[name];
}
```

In `e2e/support/commerce.ts`, widen `setCommerceSettings` to `provider: "simulator" | "manual" | "sepay"` and add:

```ts
// The database half of the gate for SePay (S18). The app half is the third web server in
// playwright.config.ts.
export async function enableSepayPayments(): Promise<void> {
  await setCommerceSettings("sepay");
}
```

- [ ] **Step 2: Add the project and the server**

In `playwright.config.ts`:

Import `sepayDefaults`, `sepayServerPort`, `sepayServerUrl`, `sepayValue`, and `type SepayName` from `./e2e/support/server-env`.

Below `manualServerEnvironment`:

```ts
const sepayServerEnvironment = webServerEnvironment({
  PAYMENT_PROVIDER: "sepay",
  SITE_URL: sepayServerUrl,
  ...Object.fromEntries((Object.keys(sepayDefaults) as SepayName[]).map((name) => [name, sepayValue(name)])),
});

const sepaySpecs = ["**/sepay-payment.spec.ts"];
const sepayProject = "chromium-sepay";
```

Below `manualServerNeeded`:

```ts
const sepayServerNeeded = selection.length === 0 || selection.includes(sepayProject);
```

Change `testIgnore` so no other project collects the spec:

```ts
  testIgnore: [...(process.env.E2E_VISUAL_PLATFORM ? [] : [visualSpec]), ...manualSpecs, ...sepaySpecs],
```

Add to `projects`, after the manual project:

```ts
    // S18. The same arrangement as chromium-manual, for the SePay server.
    {
      name: sepayProject,
      testIgnore: [],
      testMatch: sepaySpecs,
      use: { ...devices["Desktop Chrome"], baseURL: sepayServerUrl },
    },
```

Add to `webServer`, after the manual entry, copying that entry's remaining options (`reuseExistingServer`, `timeout`) exactly:

```ts
    ...(sepayServerNeeded
      ? [
          {
            // Starts only - never builds. The first entry builds.
            command: `npm run start -- --port ${sepayServerPort}`,
            url: sepayServerUrl,
            reuseExistingServer: false,
            timeout: 60_000,
            env: sepayServerEnvironment,
          },
        ]
      : []),
```

- [ ] **Step 3: Write the spec**

Create `e2e/sepay-payment.spec.ts`:

```ts
import { type Page, expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { activeEntitlementCount, createReader, enableSepayPayments, signInAs } from "./support/commerce";
import { sepayServerUrl, sepayValue } from "./support/server-env";

// S18 acceptance. Removing the hand-off page, the notification endpoint, its secret check, or the
// entitlement it grants must fail here.
//
// Runs in the chromium-sepay project only, against the web server started with
// PAYMENT_PROVIDER=sepay. SePay is never contacted: the browser's POST to SePay is intercepted and
// recorded, and the test then plays SePay's part by posting the notification.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SEPAY_CHECKOUT = "https://pay-sandbox.sepay.vn/v1/checkout/init";

test.beforeAll(async () => {
  await enableSepayPayments();
});

test.beforeEach(({ baseURL }) => {
  expect(baseURL, "sepay-payment.spec.ts is only meaningful against the SePay web server").toBe(sepayServerUrl);
});

// Buy, press Pay, and capture what the hand-off page posts to SePay.
async function buyAndCaptureCheckout(page: Page, slug: string): Promise<{ orderId: string; fields: URLSearchParams }> {
  let posted: string | null = null;
  await page.route(SEPAY_CHECKOUT, async (route) => {
    posted = route.request().postData();
    await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>SePay stub</h1>" });
  });

  await page.goto(`/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(/\/en\/checkout\/[0-9a-f-]{36}$/);
  const orderId = /\/checkout\/([0-9a-f-]{36})$/.exec(page.url())![1];
  await page.getByRole("button", { name: "Pay", exact: true }).click();

  await expect(page.getByRole("heading", { name: "SePay stub" })).toBeVisible();
  expect(posted, "the hand-off page posted to SePay's sandbox checkout").not.toBeNull();
  return { orderId, fields: new URLSearchParams(posted!) };
}

function paidNotification(fields: URLSearchParams, transactionId: string) {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    notification_type: "ORDER_PAID",
    order: {
      order_id: `E2E-${transactionId}`,
      order_status: "CAPTURED",
      order_currency: fields.get("currency"),
      order_amount: `${fields.get("order_amount")}.00`,
      order_invoice_number: fields.get("order_invoice_number"),
    },
    transaction: { transaction_id: transactionId, payment_method: "BANK_TRANSFER", transaction_status: "APPROVED" },
  };
}

test("a reader pays through SePay and reads the book", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `sepay-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `SePay Harbour ${suffix}` } },
    priceMinor: 89000,
  });
  const reader = await createReader("sepay-buyer");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  const { orderId, fields } = await buyAndCaptureCheckout(page, slug);

  expect(fields.get("merchant")).toBe(sepayValue("SEPAY_MERCHANT_ID"));
  expect(fields.get("payment_method")).toBe("BANK_TRANSFER");
  expect(fields.get("order_amount")).toBe("89000");
  expect(fields.get("currency")).toBe("VND");
  expect(fields.get("order_invoice_number")).toMatch(/^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}-89000$/);
  expect(fields.get("success_url")).toBe(`${sepayServerUrl}/en/checkout/${orderId}/status?sepay=success`);
  expect(fields.get("signature")).toBeTruthy();
  expect([...fields.values()]).not.toContain(sepayValue("SEPAY_SECRET_KEY"));

  // Coming back does not complete anything, whatever the URL says.
  await page.goto(`/en/checkout/${orderId}/status?sepay=success`);
  await expect(page.getByRole("heading", { level: 1, name: "Processing your payment" })).toBeVisible();
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  // Neither does a notification without the secret, or with the wrong one.
  const transactionId = `TXN-${suffix}`;
  const body = paidNotification(fields, transactionId);
  expect((await request.post("/api/payments/sepay/ipn", { data: body })).status()).toBe(401);
  expect(
    (await request.post("/api/payments/sepay/ipn", { data: body, headers: { "X-Secret-Key": "wrong" } })).status(),
  ).toBe(401);
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  // Nor one for a different amount.
  const underpaid = paidNotification(fields, `${transactionId}-under`);
  underpaid.order.order_amount = "1000.00";
  expect(
    (
      await request.post("/api/payments/sepay/ipn", {
        data: underpaid,
        headers: { "X-Secret-Key": sepayValue("SEPAY_SECRET_KEY") },
      })
    ).status(),
  ).toBe(422);
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  // SePay's notification does, and a second delivery changes nothing.
  for (let delivery = 0; delivery < 2; delivery += 1) {
    const response = await request.post("/api/payments/sepay/ipn", {
      data: body,
      headers: { "X-Secret-Key": sepayValue("SEPAY_SECRET_KEY") },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
  }
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);

  await page.goto(`/en/checkout/${orderId}/status?sepay=success`);
  await expect(page.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read now" })).toBeVisible();
});

test("a reader who cancels on SePay can try again", async ({ page }) => {
  const suffix = unique();
  const slug = `sepay-cancel-${suffix}`;
  await seedCatalogBook({ suffix, localizations: { en: { slug, title: `SePay Cancel ${suffix}` } }, priceMinor: 89000 });
  const reader = await createReader("sepay-canceller");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  const { orderId, fields } = await buyAndCaptureCheckout(page, slug);

  await page.goto(new URL(fields.get("cancel_url")!).pathname + "?sepay=cancel");
  await expect(page.getByRole("heading", { level: 1, name: "Payment did not go through" })).toBeVisible();
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}$`));
});
```

If the **Buy ebook** click lands somewhere other than `/en/checkout/<id>` (the manual spec does not assert this URL), take `orderId` from the hand-off URL instead: wait for `/\/en\/checkout\/([0-9a-f-]{36})\/sepay$/` with `page.waitForURL` before the stub loads.

Before running, add a third Playwright regression using the real local database (no mocked RPC):

1. Buy through the SePay server and capture the old invoice with `buyAndCaptureCheckout`.
2. Change local `commerce_settings.payment_provider` to `manual` through the fixture helper.
3. Invoke the real authenticated `create_ebook_order` for the same buyer and book. Assert a new
   manual order was created and the old SePay order/payment are cancelled. This exercises the
   exact stale-order path used by **Buy** without requiring a live server restart.
4. Post the old signed-invoice IPN twice with the test secret. Both responses must be 422 with
   `error: "manual_resolution_required"`; the old order stays cancelled and the buyer receives
   no entitlement. Assert one recorded provider event after both deliveries.
5. Restore SePay commerce settings in `finally`, so other tests are not affected. Task 5 checks
   the corresponding operational log fields and absence of purchase analytics.

- [ ] **Step 4: Run it**

In a shell with Node 22.14, the OrbStack Docker context, a scratch local Supabase stack, and its variables exported as `docs/runbooks/testing-environments.md` describes:

```bash
node -v   # v22.14.x
npx playwright test --project=chromium-sepay
```

Expected: 3 passed. If the browser download is blocked, run through the installed Chrome channel as the runbook describes.

This is the first time the real `findOrderIdByReference` query, the real constraints, and the real `apply_payment_event` run together. A 500 from the notification endpoint with `42501` in the server log means the service role cannot select `orders.reference_code`; add the grant in a new migration and a pgTAP assertion for it, rather than changing the query.

- [ ] **Step 5: Run the whole suite**

Run: `npm run check:full`
Expected: PASS. The simulator and manual projects are unaffected; the SePay server adds one more `next start`.

- [ ] **Step 6: Commit**

```bash
git add e2e/sepay-payment.spec.ts e2e/support/server-env.ts e2e/support/commerce.ts playwright.config.ts
git commit -m "test(s18): sepay payment journey end to end"
```

---

### Task 8: Runbooks, environment example, and the final gate

**Files:**
- Create: `docs/runbooks/sepay-payment.md`
- Modify: `docs/runbooks/checkout.md`, `docs/runbooks/testing-environments.md`, `.env.example`, `AGENTS.md`

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/sepay-payment.md`:

````markdown
# Runbook: SePay payment gateway

Readers pay for an order by scanning a VietQR code on SePay's hosted payment page. SePay then
notifies this application, and the order completes with no admin step. This is the `sepay` payment
provider. [Get and buy](checkout.md) covers what every provider shares.

Only the bank-transfer (VietQR) method is used. Card and NAPAS QR are not.

## 1. Turn it on

Four settings in the app and two in the database. They must name the same provider; nothing
enforces that.

| Variable | Value |
| --- | --- |
| `PAYMENT_PROVIDER` | `sepay` |
| `SEPAY_MERCHANT_ID` | from my.sepay.vn → Payment gateway → integration details |
| `SEPAY_SECRET_KEY` | the same screen. Server-only. Never in a client bundle, a log, or a ticket |
| `SEPAY_ENV` | `sandbox` or `production`. Must match the credentials |

`APP_ENV=production` refuses `SEPAY_ENV=sandbox`. `APP_ENV=local` and `test` refuse
`SEPAY_ENV=production`. The app does not start otherwise.

```sql
update public.commerce_settings set payments_enabled = true, payment_provider = 'sepay';
```

In SePay (Payment gateway → Configuration → IPN), set the IPN URL to
`https://<site>/api/payments/sepay/ipn`. Sandbox and production each have their own. Set IPN
authentication type to `SECRET_KEY` and verify the configured key matches `SEPAY_SECRET_KEY`.
Without this authentication type, SePay does not send `X-Secret-Key` and the app refuses every IPN.
Confirm this with an actual sandbox delivery; never log the header value.

## 2. What happens

| Step | Where |
| --- | --- |
| Reader presses **Pay** | `/{locale}/checkout/<orderId>` |
| A signed form posts the order to SePay | `/{locale}/checkout/<orderId>/sepay` |
| Reader scans the QR and pays | SePay |
| SePay notifies the app; the order completes | `POST /api/payments/sepay/ipn` |
| Reader is sent back | `/{locale}/checkout/<orderId>/status` |

Only the notification completes an order. Coming back from SePay never does.

The invoice number SePay shows is the order reference plus the amount: `IB-7K2MX-89000` is order
`IB-7K2MX` for 89,000 VND. Search `/admin/orders` by the reference.

## 3. Test in the sandbox

1. Use sandbox credentials and `SEPAY_ENV=sandbox` on a staging deployment, or locally behind a
   tunnel (`cloudflared tunnel --url http://localhost:3000`). SePay cannot reach `localhost`.
2. Set the sandbox IPN URL to that HTTPS origin and enable auth type `SECRET_KEY`. Verify the
   header matches without storing its value. An unset or wrong header must produce 401.
3. Buy a paid book and complete the sandbox payment.
4. The status page shows **Payment complete** within a few seconds.

## 4. Go live

1. In SePay, link the real bank account and switch the gateway to Production.
2. Replace `SEPAY_MERCHANT_ID` and `SEPAY_SECRET_KEY` with the production pair; set
   `SEPAY_ENV=production`.
3. Set the production IPN URL and auth type `SECRET_KEY`; verify the key matches the deployment.
4. Run the SQL in section 1 against production.
5. Buy the cheapest book with a real transfer. Confirm it completes, then refund yourself in the
   bank.

## 5. When a payment does not settle

Find the notification in the server logs by the invoice number or by "SePay IPN". Every line has a
request ID.

| Log | Meaning | Do |
| --- | --- | --- |
| No line at all | SePay never reached the app | Check the IPN URL in SePay and SePay's own IPN log |
| `rejected: bad secret` (401) | IPN auth is not `SECRET_KEY`, or the key does not match | Check auth type, key and environment; verify a delivery. If redelivery is unavailable, reconcile and grant by hand |
| `does not match its order` (422) | The amount paid is not the order's total. Usually a coupon was applied after the QR was shown | Compare `amountMinor` with the order. Grant access and settle the difference, or refund |
| `paid a cancelled order` (422, `manual_resolution_required`) | Money arrived after local cancellation | Use the logged invoice, event ID, SePay order ID, amount and currency to reconcile; grant access or refund. Retrying does not reopen the order |
| `names no order` (422) | No order has that reference | Refund in the bank |
| `acknowledged without action` | Not a completed bank-transfer payment | Nothing |
| `failed` (500) | The app or the database failed | Fix the cause. SePay should retry; if it does not, grant by hand |

Operators must monitor the SePay IPN error logs, including `manual_resolution_required`; a 422
is not a refund and SePay retries are not a recovery procedure. Retain these logs because late
payments on cancelled orders do not update the payment row with their external ID or amount.

To grant by hand, use `/admin/users` → the reader → grant access. If the order is still pending, cancel
it from `/admin/orders`; an already cancelled order stays cancelled. Refunds happen in the bank, not here.

There is no reconciliation job. An order paid on SePay whose notification never arrived stays
pending until someone handles it as above.

## 6. Turn it off or switch back to manual

Set `PAYMENT_PROVIDER=manual` and `commerce_settings.payment_provider = 'manual'`. Leave the three
`SEPAY_*` variables in place for a day: the notification endpoint keeps answering while they are
set. An existing SePay order settles while still pending. The next **Buy** cancels and replaces
it as stale; if its QR is paid afterwards, the handler logs `manual_resolution_required` and
returns 422 without reopening the order. Follow section 5 to grant access or refund.

## 7. Rotate the secret

Generate the new secret in SePay, set `SEPAY_SECRET_KEY`, and redeploy at once. Between the two
steps every notification is refused with 401; handle any payment in that window with section 5.
````

- [ ] **Step 2: Update the shared docs**

In `docs/runbooks/checkout.md`:
- In the opening list of providers, add: `` `sepay` - SePay's hosted payment page with a VietQR code, completed by SePay's notification. Its setup, go-live, and failure handling are in [SePay payment gateway](sepay-payment.md). ``
- Change "There are two payment providers" to "There are three payment providers".
- In the Flows table, add a row after Transfer: `` | SePay | `/{locale}/checkout/<orderId>/sepay` | Posts the order to SePay's payment page. SePay provider only - see [SePay payment gateway](sepay-payment.md). | ``
- In "The payment settings", item 1, add `sepay` to the list of real providers and note that it requires the three `SEPAY_*` variables.

In `docs/runbooks/testing-environments.md`, where the second (manual) Playwright web server and port 3100 are described, add the third: project `chromium-sepay`, port 3200, `PAYMENT_PROVIDER=sepay`, never contacts SePay.

In `.env.example`, replace the `PAYMENT_PROVIDER` comment and add the variables after the `BANK_TRANSFER_*` block:

```bash
# disabled | simulator | manual | sepay. production refuses simulator.
```

```bash
# Required together when PAYMENT_PROVIDER=sepay. From my.sepay.vn > Payment gateway. The secret
# is server-only. SEPAY_ENV is sandbox or production and must match the credentials; production
# requires production, and local/test refuse it.
SEPAY_MERCHANT_ID=
SEPAY_SECRET_KEY=
SEPAY_ENV=
```

In `AGENTS.md`, "Current scope": change the two payment lines to say that a customer gets access through a free offer, a grant, a manual bank transfer, SePay, or the payment simulator, and that production rejects the simulator.

- [ ] **Step 3: Run the final gate**

```bash
npm run check
npm run db:reset && npm run db:test
npm run check:full
```

Expected: all three PASS.

- [ ] **Step 4: Confirm Task 1 is closed**

Spec section 11 holds answers, not questions. If Task 1 took a fallback, the unit tests in Task 3 and the spec reflect it. Then do runbook section 3 once against the sandbox on a staging deployment and note the date in the runbook.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks .env.example AGENTS.md
git commit -m "docs(s18): sepay payment runbook"
```
