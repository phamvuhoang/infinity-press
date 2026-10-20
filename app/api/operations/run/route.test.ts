// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { maxDuration, POST } from "./route";
import { getServerEnv } from "@/lib/config/server-env";
import { loadOperationsSnapshot, OperationsQueryError } from "@/lib/data/operations";
import { deliverNotificationBatch } from "@/lib/email/outbox";
import { getMailProvider, MailProviderError } from "@/lib/email/provider";
import { evaluateOperations } from "@/lib/ops/checks";
import { reconcileOperationsAlerts } from "@/lib/ops/alerts";
import type { OperationsReport } from "@/lib/ops/types";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/data/operations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/operations")>();
  return { ...actual, loadOperationsSnapshot: vi.fn() };
});
vi.mock("@/lib/email/outbox", () => ({ deliverNotificationBatch: vi.fn() }));
vi.mock("@/lib/email/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/provider")>();
  return { ...actual, getMailProvider: vi.fn() };
});
vi.mock("@/lib/ops/checks", () => ({ evaluateOperations: vi.fn() }));
vi.mock("@/lib/ops/alerts", () => ({ reconcileOperationsAlerts: vi.fn() }));

const SITE = "https://books.example.com";
const SECRET = "s".repeat(40);
const REQUEST_ID = "test-request-id-1234";
const CLIENT = { marker: "admin-client" };
const PROVIDER = { send: vi.fn() };

const EMPTY_REPORT: OperationsReport = {
  evaluatedAt: "2026-09-18T00:00:00.000Z",
  findings: {
    stale_epub_job: [],
    missing_order_entitlement: [],
    unprocessed_payment_event: [],
    stuck_notification: [],
    unreviewed_manual_transfer_claim: [],
    stale_reader_question: [],
  },
};

function env(overrides: Record<string, unknown> = {}) {
  return {
    appEnv: "production",
    siteUrl: SITE,
    emailProvider: "resend",
    emailFrom: "Infinity Books <ops@example.com>",
    opsAlertEmail: "ops@example.com",
    opsWorkerSecret: SECRET,
    ...overrides,
  } as unknown as ReturnType<typeof getServerEnv>;
}

function request(headers: Record<string, string> = {}) {
  return new NextRequest(`${SITE}/api/operations/run`, { method: "POST", headers });
}

function authedRequest(headers: Record<string, string> = {}) {
  return request({ authorization: `Bearer ${SECRET}`, "x-request-id": REQUEST_ID, ...headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getServerEnv).mockReturnValue(env());
  vi.mocked(createAdminClient).mockReturnValue(CLIENT as never);
  vi.mocked(getMailProvider).mockReturnValue(PROVIDER as never);
  vi.mocked(deliverNotificationBatch).mockResolvedValue({ claimed: 0, sent: 0, failed: 0, leaseLost: 0 });
  vi.mocked(loadOperationsSnapshot).mockResolvedValue({
    epubJobs: [],
    completedOrders: [],
    paymentEvents: [],
    outbox: [],
    manualTransferClaims: [],
    readerQuestions: [],
  });
  vi.mocked(evaluateOperations).mockReturnValue(EMPTY_REPORT);
  vi.mocked(reconcileOperationsAlerts).mockResolvedValue({ alertsSent: 0, states: [] });
});

describe("route segment config", () => {
  it("allows a worst-case run - 25 book-ready sends plus one alert, each at the 10 s Resend timeout - within the Vercel Hobby limit", () => {
    const worstCaseSeconds = 25 * 10 + 10;
    expect(maxDuration).toBeGreaterThanOrEqual(worstCaseSeconds);
    // Vercel Hobby with Fluid compute caps a function at 300 s; a larger value fails deployment.
    expect(maxDuration).toBeLessThanOrEqual(300);
  });
});

describe("POST /api/operations/run", () => {
  describe("authentication", () => {
    it("rejects every request when the worker secret is not configured, with no admin client", async () => {
      vi.mocked(getServerEnv).mockReturnValue(env({ opsWorkerSecret: null }));

      const response = await POST(authedRequest());

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "worker_not_configured", requestId: REQUEST_ID });
      expect(createAdminClient).not.toHaveBeenCalled();
    });

    it("rejects a missing authorization header, with no admin client", async () => {
      const response = await POST(request({ "x-request-id": REQUEST_ID }));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized", requestId: REQUEST_ID });
      expect(createAdminClient).not.toHaveBeenCalled();
    });

    it("rejects a Basic authorization scheme", async () => {
      const response = await POST(request({ authorization: "Basic dXNlcjpwYXNz", "x-request-id": REQUEST_ID }));

      expect(response.status).toBe(401);
      expect(createAdminClient).not.toHaveBeenCalled();
    });

    it("rejects the wrong bearer secret", async () => {
      const response = await POST(request({ authorization: `Bearer ${"w".repeat(40)}`, "x-request-id": REQUEST_ID }));

      expect(response.status).toBe(401);
      expect(createAdminClient).not.toHaveBeenCalled();
    });

    it("accepts the exact configured secret", async () => {
      const response = await POST(authedRequest());
      expect(response.status).toBe(200);
      expect(createAdminClient).toHaveBeenCalledOnce();
    });
  });

  // The outbox carries two templates since S9. The run reports one set of counts across the whole
  // batch and says nothing about which template any row was, which is what keeps this response from
  // becoming a signal about individual gift recipients.
  it("reports a mixed batch as one set of counts, with no per-template detail", async () => {
    vi.mocked(deliverNotificationBatch).mockResolvedValue({ claimed: 4, sent: 3, failed: 1, leaseLost: 0 });

    const body = await (await POST(authedRequest())).json();

    expect(body.outbox).toEqual({ claimed: 4, sent: 3, failed: 1 });
    expect(JSON.stringify(body)).not.toContain("gift");
    expect(JSON.stringify(body)).not.toContain("book_ready");
  });

  it("returns only counts and the request ID, with Cache-Control: no-store", async () => {
    vi.mocked(deliverNotificationBatch).mockResolvedValue({ claimed: 5, sent: 4, failed: 1, leaseLost: 0 });
    vi.mocked(evaluateOperations).mockReturnValue({
      ...EMPTY_REPORT,
      findings: { ...EMPTY_REPORT.findings, stale_epub_job: [{ id: "j1", rule: "stale_epub_job", occurredAt: EMPTY_REPORT.evaluatedAt, summary: "s", repairPath: "/admin/books/b1#epub" }] },
    });
    vi.mocked(reconcileOperationsAlerts).mockResolvedValue({ alertsSent: 1, states: [] });

    const response = await POST(authedRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      requestId: REQUEST_ID,
      outbox: { claimed: 5, sent: 4, failed: 1 },
      findings: {
        stale_epub_job: 1,
        missing_order_entitlement: 0,
        unprocessed_payment_event: 0,
        stuck_notification: 0,
        unreviewed_manual_transfer_claim: 0,
        stale_reader_question: 0,
      },
      alertsSent: 1,
    });
    expect(Object.keys(body).sort()).toEqual(["alertsSent", "findings", "outbox", "requestId"]);
  });

  it("drains the outbox before evaluating rules, evaluates with one now, then reconciles", async () => {
    const order: string[] = [];
    vi.mocked(deliverNotificationBatch).mockImplementation(async () => {
      order.push("outbox");
      return { claimed: 0, sent: 0, failed: 0, leaseLost: 0 };
    });
    vi.mocked(loadOperationsSnapshot).mockImplementation(async () => {
      order.push("snapshot");
      return { epubJobs: [], completedOrders: [], paymentEvents: [], outbox: [], manualTransferClaims: [], readerQuestions: [] };
    });
    vi.mocked(evaluateOperations).mockImplementation((_snapshot, now) => {
      order.push("evaluate");
      return { ...EMPTY_REPORT, evaluatedAt: now.toISOString() };
    });
    vi.mocked(reconcileOperationsAlerts).mockImplementation(async () => {
      order.push("reconcile");
      return { alertsSent: 0, states: [] };
    });

    await POST(authedRequest());

    expect(order).toEqual(["outbox", "snapshot", "evaluate", "reconcile"]);
    const [snapshotClient, snapshotNow] = vi.mocked(loadOperationsSnapshot).mock.calls[0];
    const [, evaluateNow] = vi.mocked(evaluateOperations).mock.calls[0];
    expect(snapshotClient).toBe(CLIENT);
    expect(evaluateNow).toBe(snapshotNow);
    expect(vi.mocked(reconcileOperationsAlerts).mock.calls[0][0].report.evaluatedAt).toBe(snapshotNow.toISOString());
  });

  it("passes the request ID and admin client into outbox delivery", async () => {
    await POST(authedRequest());

    expect(deliverNotificationBatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ client: CLIENT, provider: PROVIDER, requestId: REQUEST_ID, siteUrl: SITE, from: "Infinity Books <ops@example.com>" }),
    );
  });

  it("does not fail the run when a mail row fails", async () => {
    vi.mocked(deliverNotificationBatch).mockResolvedValue({ claimed: 2, sent: 0, failed: 2, leaseLost: 0 });

    const response = await POST(authedRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outbox).toEqual({ claimed: 2, sent: 0, failed: 2 });
  });

  it("does not fail the run when the outbox claim itself fails", async () => {
    vi.mocked(deliverNotificationBatch).mockRejectedValue(new Error("claim failed"));

    const response = await POST(authedRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outbox).toEqual({ claimed: 0, sent: 0, failed: 0 });
  });

  it("skips outbox delivery and alert mail when mail is not configured, but still evaluates rules", async () => {
    vi.mocked(getMailProvider).mockImplementation(() => {
      throw new MailProviderError("mail_not_configured", "Email is not configured for this environment");
    });

    const response = await POST(authedRequest());

    expect(response.status).toBe(200);
    expect(deliverNotificationBatch).not.toHaveBeenCalled();
    expect(loadOperationsSnapshot).toHaveBeenCalledOnce();
    expect(vi.mocked(reconcileOperationsAlerts).mock.calls[0][0].mail).toBeNull();
    const body = await response.json();
    expect(body.outbox).toEqual({ claimed: 0, sent: 0, failed: 0 });
  });

  it("returns 500 with a safe error when the operations query fails", async () => {
    vi.mocked(loadOperationsSnapshot).mockRejectedValue(new OperationsQueryError("processing_jobs", "XX000"));

    const response = await POST(authedRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "operations_run_failed", requestId: REQUEST_ID });
    expect(evaluateOperations).not.toHaveBeenCalled();
    expect(reconcileOperationsAlerts).not.toHaveBeenCalled();
  });

  it("returns 500 with a safe error when alert reconciliation fails", async () => {
    vi.mocked(reconcileOperationsAlerts).mockRejectedValue(new Error("Operations alert state could not be saved."));

    const response = await POST(authedRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "operations_run_failed", requestId: REQUEST_ID });
  });
});
