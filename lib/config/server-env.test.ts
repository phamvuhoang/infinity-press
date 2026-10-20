import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/config/server-env-schema";

const base = {
  APP_ENV: "staging",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  PAYMENT_PROVIDER: "simulator",
  PAYMENT_SIMULATOR_SECRET: "test-simulator-secret-0123456789abcdef",
  READER_SESSION_TTL_SECONDS: "900",
  SITE_URL: "https://books.test/",
};

describe("parseServerEnv", () => {
  it("accepts the simulator outside production", () => {
    expect(parseServerEnv(base).paymentProvider).toBe("simulator");
  });

  it("rejects the simulator in production", () => {
    expect(() => parseServerEnv({ ...base, APP_ENV: "production" })).toThrow(
      "Payment simulator cannot run in production",
    );
  });

  it("normalizes the site URL used for authentication links", () => {
    expect(parseServerEnv(base).siteUrl).toBe("https://books.test");
  });

  it("accepts loopback URLs for a local stack", () => {
    const env = parseServerEnv({
      ...base,
      APP_ENV: "local",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      SITE_URL: "http://localhost:3000",
    });

    expect([env.supabaseUrl, env.siteUrl]).toEqual([
      "http://127.0.0.1:54321",
      "http://localhost:3000",
    ]);
  });

  it.each([
    ["NEXT_PUBLIC_SUPABASE_URL", "http://example.supabase.co"],
    ["SITE_URL", "http://books.test"],
    ["SITE_URL", undefined],
  ])("rejects %s=%j", (name, value) => {
    expect(() => parseServerEnv({ ...base, [name]: value })).toThrow();
  });

  it("requires a simulator secret with the simulator", () => {
    expect(() => parseServerEnv({ ...base, PAYMENT_SIMULATOR_SECRET: undefined })).toThrow(
      "PAYMENT_SIMULATOR_SECRET is required when PAYMENT_PROVIDER=simulator",
    );
  });

  it("rejects a short simulator secret", () => {
    expect(() => parseServerEnv({ ...base, PAYMENT_SIMULATOR_SECRET: "short" })).toThrow();
  });

  it("refuses PAYMENT_PROVIDER=manual without complete bank details", () => {
    expect(() => parseServerEnv({ ...base, PAYMENT_PROVIDER: "manual", BANK_TRANSFER_BANK_CODE: undefined })).toThrow(
      /BANK_TRANSFER_BANK_CODE/,
    );
  });

  it("maps each BANK_TRANSFER_* field to its own bankTransfer property", () => {
    const env = parseServerEnv({
      ...base,
      PAYMENT_PROVIDER: "manual",
      BANK_TRANSFER_BANK_CODE: "970436",
      BANK_TRANSFER_BANK_NAME: "Vietcombank",
      BANK_TRANSFER_ACCOUNT_NUMBER: "0123456789",
      BANK_TRANSFER_ACCOUNT_HOLDER: "CONG TY INFINITY BOOKS",
    });
    expect(env.bankTransfer).toEqual({
      bankCode: "970436",
      bankName: "Vietcombank",
      accountNumber: "0123456789",
      accountHolder: "CONG TY INFINITY BOOKS",
    });
  });

  it("accepts PAYMENT_PROVIDER=manual in production with a complete bank configuration", () => {
    const env = parseServerEnv({
      ...base,
      APP_ENV: "production",
      PAYMENT_PROVIDER: "manual",
      PAYMENT_SIMULATOR_SECRET: undefined,
      BANK_TRANSFER_BANK_CODE: "970436",
      BANK_TRANSFER_BANK_NAME: "Vietcombank",
      BANK_TRANSFER_ACCOUNT_NUMBER: "0123456789",
      BANK_TRANSFER_ACCOUNT_HOLDER: "CONG TY INFINITY BOOKS",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_0123456789",
      EMAIL_FROM: "Infinity Books <books@example.com>",
      OPS_ALERT_EMAIL: "operator@example.com",
      OPS_WORKER_SECRET: "worker-secret-at-least-32-characters-long",
    });
    expect(env.paymentProvider).toBe("manual");
    expect(env.bankTransfer).toEqual({
      bankCode: "970436",
      bankName: "Vietcombank",
      accountNumber: "0123456789",
      accountHolder: "CONG TY INFINITY BOOKS",
    });
  });

  it("needs no secret when payments are disabled", () => {
    const env = parseServerEnv({
      ...base,
      APP_ENV: "production",
      PAYMENT_PROVIDER: "disabled",
      PAYMENT_SIMULATOR_SECRET: undefined,
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_0123456789",
      EMAIL_FROM: "Infinity Books <books@example.com>",
      OPS_ALERT_EMAIL: "operator@example.com",
      OPS_WORKER_SECRET: "worker-secret-at-least-32-characters-long",
    });
    expect(env.simulatorSecret).toBeNull();
  });

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
      BANK_TRANSFER_BANK_CODE: "970436", BANK_TRANSFER_BANK_NAME: "Vietcombank",
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

  describe("email and operations variables", () => {
    const productionEmail = {
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_0123456789",
      EMAIL_FROM: "Infinity Books <books@example.com>",
      OPS_ALERT_EMAIL: "operator@example.com",
      OPS_WORKER_SECRET: "worker-secret-at-least-32-characters-long",
    };

    it("leaves the fields null when they are absent outside production", () => {
      const env = parseServerEnv(base);
      expect(env.emailProvider).toBeNull();
      expect(env.resendApiKey).toBeNull();
      expect(env.emailFrom).toBeNull();
      expect(env.opsAlertEmail).toBeNull();
      expect(env.opsWorkerSecret).toBeNull();
    });

    it("accepts the no-network provider in local", () => {
      const env = parseServerEnv({ ...base, APP_ENV: "local", EMAIL_PROVIDER: "test" });
      expect(env.emailProvider).toBe("test");
    });

    it("accepts the no-network provider in test", () => {
      const env = parseServerEnv({ ...base, APP_ENV: "test", EMAIL_PROVIDER: "test" });
      expect(env.emailProvider).toBe("test");
    });

    it("rejects the no-network provider outside local and test", () => {
      expect(() =>
        parseServerEnv({ ...base, APP_ENV: "staging", EMAIL_PROVIDER: "test" }),
      ).toThrow("EMAIL_PROVIDER=test is only allowed when APP_ENV is local or test");
    });

    it("requires a Resend key when EMAIL_PROVIDER=resend", () => {
      expect(() =>
        parseServerEnv({ ...base, EMAIL_PROVIDER: "resend", RESEND_API_KEY: undefined, EMAIL_FROM: "a@example.com" }),
      ).toThrow("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
    });

    it("requires a sender when EMAIL_PROVIDER=resend", () => {
      expect(() =>
        parseServerEnv({ ...base, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_key", EMAIL_FROM: undefined }),
      ).toThrow("EMAIL_FROM is required when EMAIL_PROVIDER=resend");
    });

    it("accepts a sender formatted as Name <addr@domain>", () => {
      const env = parseServerEnv({
        ...base,
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_test_key",
        EMAIL_FROM: "Infinity Books <books@example.com>",
      });
      expect(env.emailFrom).toBe("Infinity Books <books@example.com>");
    });

    it("rejects a sender without a valid address", () => {
      expect(() =>
        parseServerEnv({ ...base, EMAIL_FROM: "not-an-email" }),
      ).toThrow();
    });

    it("rejects an invalid operator alert email", () => {
      expect(() =>
        parseServerEnv({ ...base, OPS_ALERT_EMAIL: "not-an-email" }),
      ).toThrow();
    });

    it("rejects a worker secret shorter than 32 characters", () => {
      expect(() =>
        parseServerEnv({ ...base, OPS_WORKER_SECRET: "too-short" }),
      ).toThrow();
    });

    it("accepts a complete production configuration", () => {
      const env = parseServerEnv({ ...base, APP_ENV: "production", PAYMENT_PROVIDER: "disabled", PAYMENT_SIMULATOR_SECRET: undefined, ...productionEmail });
      expect(env.emailProvider).toBe("resend");
      expect(env.resendApiKey).toBe(productionEmail.RESEND_API_KEY);
      expect(env.emailFrom).toBe(productionEmail.EMAIL_FROM);
      expect(env.opsAlertEmail).toBe(productionEmail.OPS_ALERT_EMAIL);
      expect(env.opsWorkerSecret).toBe(productionEmail.OPS_WORKER_SECRET);
    });

    it("rejects production without EMAIL_PROVIDER=resend", () => {
      expect(() =>
        parseServerEnv({ ...base, APP_ENV: "production", PAYMENT_PROVIDER: "disabled", PAYMENT_SIMULATOR_SECRET: undefined, ...productionEmail, EMAIL_PROVIDER: undefined }),
      ).toThrow("EMAIL_PROVIDER must be resend in production");
    });

    it("rejects production with the no-network provider", () => {
      expect(() =>
        parseServerEnv({
          ...base,
          APP_ENV: "production",
          PAYMENT_PROVIDER: "disabled",
          PAYMENT_SIMULATOR_SECRET: undefined,
          ...productionEmail,
          EMAIL_PROVIDER: "test",
        }),
      ).toThrow("EMAIL_PROVIDER=test is only allowed when APP_ENV is local or test");
    });

    it("rejects production without an operator alert email", () => {
      expect(() =>
        parseServerEnv({ ...base, APP_ENV: "production", PAYMENT_PROVIDER: "disabled", PAYMENT_SIMULATOR_SECRET: undefined, ...productionEmail, OPS_ALERT_EMAIL: undefined }),
      ).toThrow("OPS_ALERT_EMAIL is required in production");
    });

    it("rejects production without a worker secret", () => {
      expect(() =>
        parseServerEnv({ ...base, APP_ENV: "production", PAYMENT_PROVIDER: "disabled", PAYMENT_SIMULATOR_SECRET: undefined, ...productionEmail, OPS_WORKER_SECRET: undefined }),
      ).toThrow("OPS_WORKER_SECRET is required in production");
    });

    it("rejects production without a Resend key", () => {
      expect(() =>
        parseServerEnv({ ...base, APP_ENV: "production", PAYMENT_PROVIDER: "disabled", PAYMENT_SIMULATOR_SECRET: undefined, ...productionEmail, RESEND_API_KEY: undefined }),
      ).toThrow("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
    });
  });
});
