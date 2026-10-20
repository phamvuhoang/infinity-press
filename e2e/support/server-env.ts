// Operational configuration the app needs to boot under Playwright but that no fixture depends on,
// so a default is honest rather than a placeholder. playwright.config.ts passes each value to the web
// server as `process.env[name] ?? default`; a spec that must present the same value the server holds
// (the worker secret) reads it through serverEnvironmentValue(), so the two can never disagree - the
// shell, or CI's $GITHUB_ENV, wins for both.
//
// The Supabase credentials are deliberately NOT defaulted. They used to fall back to
// "sb_publishable_e2e" / "e2e-service-role", which let the spawned server start and answer requests
// while being connected to nothing a fixture could see - the exact shape that made a broken run
// look healthy.
//
// S7 adds a SECOND web server. PAYMENT_PROVIDER is read per request from the server's own
// environment, so one process cannot be both the simulator and the manual bank-transfer provider;
// the manual journey therefore needs its own origin. Both are pinned here so the config and the
// specs read the same two URLs.
export const simulatorServerUrl = "http://127.0.0.1:3000";
export const manualServerUrl = "http://127.0.0.1:3100";
export const manualServerPort = new URL(manualServerUrl).port;
// S18: a third origin, for the same reason as the second. PAYMENT_PROVIDER=sepay.
// Overridable because 3200 is a common dev-server port; the config never reuses a server it did not
// start, so a squatter there is a loud failure rather than a quiet substitution.
export const sepayServerUrl = process.env.E2E_SEPAY_SERVER_URL ?? "http://127.0.0.1:3200";
export const sepayServerPort = new URL(sepayServerUrl).port;

export const serverEnvironmentDefaults = {
  APP_ENV: "test",
  PAYMENT_PROVIDER: "simulator",
  PAYMENT_SIMULATOR_SECRET: "e2e-simulator-secret-not-for-real-use-0000",
  READER_SESSION_TTL_SECONDS: "900",
  SITE_URL: simulatorServerUrl,
  // S5: the no-network mail adapter (never Resend in Playwright), a sender so the worker delivers
  // the outbox, and a fake worker secret the operations spec authenticates with.
  EMAIL_PROVIDER: "test",
  EMAIL_FROM: "Infinity Books <books@example.test>",
  OPS_WORKER_SECRET: "e2e-worker-secret-not-for-real-use-00000000000",
} as const;

export type ServerEnvironmentName = keyof typeof serverEnvironmentDefaults;

// The value the spawned web server receives for `name`.
export function serverEnvironmentValue(name: ServerEnvironmentName): string {
  return process.env[name] ?? serverEnvironmentDefaults[name];
}

// S7: the payee details the manual server prints on the transfer page. These reach only the manual
// web server. The account number must satisfy the schema's ^\d{6,20}$ and the bank code its
// ^\d{6}$, so they look like real Vietnamese bank fields without being any real account.
//
// manual-payment.spec.ts asserts the transfer page against these same values, which is what makes
// the spec impossible to pass against a server running any other provider: a simulator server has
// no transfer page at all, let alone these details on it.
export const bankTransferDefaults = {
  BANK_TRANSFER_BANK_CODE: "970436",
  BANK_TRANSFER_BANK_NAME: "E2E Test Bank",
  BANK_TRANSFER_ACCOUNT_NUMBER: "19020250000001",
  BANK_TRANSFER_ACCOUNT_HOLDER: "INFINITY BOOKS E2E",
} as const;

export type BankTransferName = keyof typeof bankTransferDefaults;

export function bankTransferValue(name: BankTransferName): string {
  return process.env[name] ?? bankTransferDefaults[name];
}

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
