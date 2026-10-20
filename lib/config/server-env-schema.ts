import { z } from "zod";

import { isSecureOrLoopbackUrl } from "@/lib/config/url";

const serviceUrl = z
  .url()
  .refine(isSecureOrLoopbackUrl, { error: "Use HTTPS or a loopback HTTP URL" });

// EMAIL_FROM may be a bare address or "Name <addr@domain>". Only the address part needs to be a
// valid email; the display name is free text. Exported so lib/email can build the same address
// for logging without re-parsing.
export function extractSenderAddress(value: string): string | null {
  const angleMatch = value.match(/<([^<>]+)>\s*$/);
  const address = (angleMatch ? angleMatch[1] : value).trim();
  return z.email().safeParse(address).success ? address : null;
}

const emailFrom = z
  .string()
  .min(1)
  .refine((value) => extractSenderAddress(value) !== null, {
    error: 'EMAIL_FROM must be a valid sender address, optionally formatted as "Name <addr@domain>"',
  })
  .optional();

const schema = z.object({
  APP_ENV: z.enum(["local", "preview", "staging", "production", "test"]),
  NEXT_PUBLIC_SUPABASE_URL: serviceUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PAYMENT_PROVIDER: z.enum(["disabled", "simulator", "manual", "sepay"]),
  SEPAY_MERCHANT_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  SEPAY_SECRET_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  SEPAY_ENV: z.preprocess((value) => value === "" ? undefined : value, z.enum(["sandbox", "production"]).optional()),
  PAYMENT_SIMULATOR_SECRET: z.string().min(32).optional(),
  BANK_TRANSFER_BANK_CODE: z.string().regex(/^\d{6}$/).optional(),
  BANK_TRANSFER_BANK_NAME: z.string().min(1).optional(),
  BANK_TRANSFER_ACCOUNT_NUMBER: z.string().regex(/^\d{6,20}$/).optional(),
  BANK_TRANSFER_ACCOUNT_HOLDER: z.string().min(1).optional(),
  READER_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600),
  SITE_URL: serviceUrl,
  EMAIL_PROVIDER: z.enum(["resend", "test"]).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: emailFrom,
  OPS_ALERT_EMAIL: z.email().optional(),
  OPS_WORKER_SECRET: z.string().min(32).optional(),
});

export type ServerEnv = ReturnType<typeof parseServerEnv>;

export function parseServerEnv(values: Record<string, string | undefined>) {
  const parsed = schema.parse(values);
  if (
    parsed.APP_ENV === "production" &&
    parsed.PAYMENT_PROVIDER === "simulator"
  ) {
    throw new Error("Payment simulator cannot run in production");
  }
  if (parsed.PAYMENT_PROVIDER === "simulator" && !parsed.PAYMENT_SIMULATOR_SECRET) {
    throw new Error("PAYMENT_SIMULATOR_SECRET is required when PAYMENT_PROVIDER=simulator");
  }
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
  // EMAIL_PROVIDER=test skips Resend entirely, so it must never reach a real customer inbox.
  if (
    parsed.EMAIL_PROVIDER === "test" &&
    parsed.APP_ENV !== "local" &&
    parsed.APP_ENV !== "test"
  ) {
    throw new Error("EMAIL_PROVIDER=test is only allowed when APP_ENV is local or test");
  }
  // Independent of APP_ENV: once an operator opts into Resend, it must be usable.
  if (parsed.EMAIL_PROVIDER === "resend") {
    if (!parsed.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
    }
    if (!parsed.EMAIL_FROM) {
      throw new Error("EMAIL_FROM is required when EMAIL_PROVIDER=resend");
    }
  }
  if (parsed.APP_ENV === "production") {
    if (parsed.EMAIL_PROVIDER !== "resend") {
      throw new Error("EMAIL_PROVIDER must be resend in production");
    }
    if (!parsed.OPS_ALERT_EMAIL) {
      throw new Error("OPS_ALERT_EMAIL is required in production");
    }
    if (!parsed.OPS_WORKER_SECRET) {
      throw new Error("OPS_WORKER_SECRET is required in production");
    }
  }
  return {
    appEnv: parsed.APP_ENV,
    supabaseUrl: parsed.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: parsed.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    serviceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
    paymentProvider: parsed.PAYMENT_PROVIDER,
    simulatorSecret: parsed.PAYMENT_SIMULATOR_SECRET ?? null,
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
    sepay:
      parsed.SEPAY_MERCHANT_ID && parsed.SEPAY_SECRET_KEY && parsed.SEPAY_ENV
        ? { merchantId: parsed.SEPAY_MERCHANT_ID, secretKey: parsed.SEPAY_SECRET_KEY, env: parsed.SEPAY_ENV }
        : null,
    readerSessionTtlSeconds: parsed.READER_SESSION_TTL_SECONDS,
    siteUrl: new URL(parsed.SITE_URL).origin,
    emailProvider: parsed.EMAIL_PROVIDER ?? null,
    resendApiKey: parsed.RESEND_API_KEY ?? null,
    emailFrom: parsed.EMAIL_FROM ?? null,
    opsAlertEmail: parsed.OPS_ALERT_EMAIL ?? null,
    opsWorkerSecret: parsed.OPS_WORKER_SECRET ?? null,
  } as const;
}
