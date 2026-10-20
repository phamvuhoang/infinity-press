// @vitest-environment node
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { MailProviderError, type MailMessage, type MailProvider } from "@/lib/email/provider";
import {
  ALERT_REMINDER_MS,
  fingerprintFindings,
  planAlertTransitions,
  reconcileOperationsAlerts,
} from "@/lib/ops/alerts";
import type { OperationsAlertState, OperationsReport, OpsFinding, OpsRuleName } from "@/lib/ops/types";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const EARLIER = "2026-09-16T11:00:00.000Z";
const SITE = "https://books.example.com";
const MAIL = { from: "Infinity Books Press <ops@example.com>", to: "operator@example.com" };
const REQUEST_ID = "req_ops_alerts_1234";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function f(rule: OpsRuleName, id: string): OpsFinding {
  return { id, rule, occurredAt: EARLIER, summary: "Safe summary.", repairPath: `/admin/orders/${id}` };
}

function report(findings: Partial<Record<OpsRuleName, OpsFinding[]>>, now: Date = NOW): OperationsReport {
  return {
    evaluatedAt: now.toISOString(),
    findings: {
      stale_epub_job: [],
      missing_order_entitlement: [],
      unprocessed_payment_event: [],
      stuck_notification: [],
      unreviewed_manual_transfer_claim: [],
      stale_reader_question: [],
      ...findings,
    },
  };
}

function inactive(rule: OpsRuleName, overrides: Partial<OperationsAlertState> = {}): OperationsAlertState {
  return {
    ruleName: rule,
    active: false,
    fingerprint: null,
    firstDetectedAt: null,
    lastEvaluatedAt: EARLIER,
    lastAlertedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

function allInactive(overrides: Partial<Record<OpsRuleName, Partial<OperationsAlertState>>> = {}): OperationsAlertState[] {
  return (["stale_epub_job", "missing_order_entitlement", "unprocessed_payment_event", "stuck_notification"] as const).map(
    (rule) => inactive(rule, overrides[rule]),
  );
}

describe("fingerprintFindings", () => {
  it("is the SHA-256 of the sorted finding IDs joined with a newline", () => {
    const findings = [f("stale_epub_job", "b"), f("stale_epub_job", "c"), f("stale_epub_job", "a")];
    expect(fingerprintFindings(findings)).toBe(sha256("a\nb\nc"));
    expect(fingerprintFindings([...findings].reverse())).toBe(sha256("a\nb\nc"));
  });
});

describe("planAlertTransitions", () => {
  const fp = fingerprintFindings([f("missing_order_entitlement", "o1")]);

  function planFor(state: OperationsAlertState, findings: OpsFinding[], now: Date = NOW) {
    const states = allInactive();
    const index = states.findIndex((s) => s.ruleName === state.ruleName);
    states[index] = state;
    const plans = planAlertTransitions(states, report({ [state.ruleName]: findings }, now));
    return plans.find((plan) => plan.rule === state.ruleName)!;
  }

  it("inactive: a clear rule stays inactive, only last_evaluated_at moves", () => {
    const previous = inactive("missing_order_entitlement", { resolvedAt: EARLIER, firstDetectedAt: EARLIER });
    const plan = planFor(previous, []);
    expect(plan.reason).toBeNull();
    expect(plan.next).toEqual({ ...previous, lastEvaluatedAt: NOW.toISOString() });
  });

  it("first run: a never-evaluated seeded row records this evaluation", () => {
    const seeded = inactive("stale_epub_job", { lastEvaluatedAt: null });
    expect(planFor(seeded, []).next).toEqual({ ...seeded, lastEvaluatedAt: NOW.toISOString() });

    const plan = planFor(seeded, [f("stale_epub_job", "j1")]);
    expect(plan.reason).toBe("new");
    expect(plan.next.lastEvaluatedAt).toBe(NOW.toISOString());
  });

  it("new: a rule that becomes active needs an alert and records first detection", () => {
    const plan = planFor(inactive("missing_order_entitlement", { resolvedAt: EARLIER, lastAlertedAt: EARLIER }), [
      f("missing_order_entitlement", "o1"),
    ]);
    expect(plan.reason).toBe("new");
    expect(plan.next).toEqual({
      ruleName: "missing_order_entitlement",
      active: true,
      fingerprint: fp,
      firstDetectedAt: NOW.toISOString(),
      lastEvaluatedAt: NOW.toISOString(),
      lastAlertedAt: EARLIER,
      resolvedAt: null,
    });
  });

  it("unchanged: the same finding set alerted within 24 hours sends nothing", () => {
    const lastAlertedAt = new Date(NOW.getTime() - ALERT_REMINDER_MS + 1).toISOString();
    const previous = inactive("missing_order_entitlement", {
      active: true,
      fingerprint: fp,
      firstDetectedAt: EARLIER,
      lastAlertedAt,
    });
    const plan = planFor(previous, [f("missing_order_entitlement", "o1")]);
    expect(plan.reason).toBeNull();
    expect(plan.next).toEqual({ ...previous, lastEvaluatedAt: NOW.toISOString() });
  });

  it("changed: a different finding set needs an alert and keeps the first detection time", () => {
    const previous = inactive("missing_order_entitlement", {
      active: true,
      fingerprint: fp,
      firstDetectedAt: EARLIER,
      lastAlertedAt: EARLIER,
    });
    const findings = [f("missing_order_entitlement", "o1"), f("missing_order_entitlement", "o2")];
    const plan = planFor(previous, findings);
    expect(plan.reason).toBe("changed");
    expect(plan.next).toEqual({
      ...previous,
      fingerprint: fingerprintFindings(findings),
      lastEvaluatedAt: NOW.toISOString(),
    });
  });

  it("overdue: an unchanged active rule is re-alerted once 24 hours pass without a successful alert", () => {
    const lastAlertedAt = new Date(NOW.getTime() - ALERT_REMINDER_MS).toISOString();
    const previous = inactive("missing_order_entitlement", {
      active: true,
      fingerprint: fp,
      firstDetectedAt: EARLIER,
      lastAlertedAt,
    });
    expect(planFor(previous, [f("missing_order_entitlement", "o1")]).reason).toBe("overdue");
    expect(
      planFor({ ...previous, lastAlertedAt: null }, [f("missing_order_entitlement", "o1")]).reason,
    ).toBe("overdue");
  });

  it("resolved: a cleared rule becomes inactive without an alert", () => {
    const previous = inactive("missing_order_entitlement", {
      active: true,
      fingerprint: fp,
      firstDetectedAt: EARLIER,
      lastAlertedAt: EARLIER,
    });
    const plan = planFor(previous, []);
    expect(plan.reason).toBeNull();
    expect(plan.next).toEqual({
      ...previous,
      active: false,
      fingerprint: null,
      lastEvaluatedAt: NOW.toISOString(),
      resolvedAt: NOW.toISOString(),
    });
  });

  it("treats a missing state row as inactive", () => {
    const plans = planAlertTransitions([], report({ stuck_notification: [f("stuck_notification", "n1")] }));
    expect(plans.map((plan) => plan.rule)).toEqual([
      "stale_epub_job",
      "missing_order_entitlement",
      "unprocessed_payment_event",
      "stuck_notification",
      "unreviewed_manual_transfer_claim",
      "stale_reader_question",
    ]);
    expect(plans.find((plan) => plan.rule === "stuck_notification")!.reason).toBe("new");
  });
});

type Row = {
  rule_name: string;
  active: boolean;
  fingerprint: string | null;
  first_detected_at: string | null;
  last_evaluated_at: string | null;
  last_alerted_at: string | null;
  resolved_at: string | null;
};

function toRow(state: OperationsAlertState): Row {
  return {
    rule_name: state.ruleName,
    active: state.active,
    fingerprint: state.fingerprint,
    first_detected_at: state.firstDetectedAt,
    last_evaluated_at: state.lastEvaluatedAt,
    last_alerted_at: state.lastAlertedAt,
    resolved_at: state.resolvedAt,
  };
}

function fakeClient(options: { rows: Row[]; selectError?: unknown; upsertError?: unknown }) {
  const upserts: { rows: Row[]; options: unknown }[] = [];
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      return {
        select() {
          return Promise.resolve(
            options.selectError ? { data: null, error: options.selectError } : { data: options.rows, error: null },
          );
        },
        upsert(rows: Row[], upsertOptions: unknown) {
          upserts.push({ rows, options: upsertOptions });
          return Promise.resolve({ data: null, error: options.upsertError ?? null });
        },
      };
    },
  };
  return { client: client as never, upserts, tables };
}

function recordingProvider(result: "ok" | Error = "ok") {
  const sent: MailMessage[] = [];
  const provider: MailProvider = {
    async send(message) {
      sent.push(message);
      if (result instanceof Error) throw result;
      return { messageId: "msg_1" };
    },
  };
  return { provider, sent };
}

describe("reconcileOperationsAlerts", () => {
  let warn: MockInstance;
  let info: MockInstance;
  let error: MockInstance;

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const twoRules = report({
    stale_epub_job: [
      { id: "job-1", rule: "stale_epub_job", occurredAt: EARLIER, summary: "s", repairPath: "/admin/books/book-1#epub" },
    ],
    stuck_notification: [
      { id: "n-1", rule: "stuck_notification", occurredAt: EARLIER, summary: "s", repairPath: "/admin/users/p-1" },
      { id: "n-2", rule: "stuck_notification", occurredAt: EARLIER, summary: "s", repairPath: "/admin/users/p-2" },
    ],
  });

  it("sends one concise email for every rule needing an alert, then records the alert time", async () => {
    const { client, upserts, tables } = fakeClient({ rows: allInactive().map(toRow) });
    const { provider, sent } = recordingProvider();

    const result = await reconcileOperationsAlerts({
      client,
      report: twoRules,
      mail: { provider, ...MAIL },
      siteUrl: SITE,
      requestId: REQUEST_ID,
    });

    expect(result.alertsSent).toBe(2);
    expect(tables.every((table) => table === "operations_alert_state")).toBe(true);
    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message.from).toBe(MAIL.from);
    expect(message.to).toBe(MAIL.to);
    expect(message.subject).toBe("Infinity Books Press operations: 2 rules need attention");
    expect(message.idempotencyKey).toMatch(/^ops-alert\/[0-9a-f]{64}$/);
    for (const body of [message.text, message.html]) {
      expect(body).toContain("Stale EPUB jobs: 1");
      expect(body).toContain("Stuck book-ready emails: 2");
      expect(body).toContain(`${SITE}/admin/books/book-1#epub`);
      expect(body).toContain(`${SITE}/admin/users/p-1`);
      expect(body).toContain(`${SITE}/admin/users/p-2`);
      expect(body).toContain(`${SITE}/admin/operations`);
      expect(body).not.toContain("Completed orders");
      expect(body).not.toContain("@");
    }

    expect(upserts).toHaveLength(1);
    expect(upserts[0].options).toEqual({ onConflict: "rule_name" });
    const byRule = new Map(upserts[0].rows.map((row) => [row.rule_name, row]));
    expect(byRule.size).toBe(6);
    expect(byRule.get("stale_epub_job")).toMatchObject({
      active: true,
      fingerprint: sha256("job-1"),
      first_detected_at: NOW.toISOString(),
      last_evaluated_at: NOW.toISOString(),
      last_alerted_at: NOW.toISOString(),
    });
    expect(byRule.get("stuck_notification")).toMatchObject({
      active: true,
      fingerprint: sha256("n-1\nn-2"),
      last_alerted_at: NOW.toISOString(),
    });
    expect(byRule.get("missing_order_entitlement")).toMatchObject({
      active: false,
      last_evaluated_at: NOW.toISOString(),
      last_alerted_at: null,
    });
    expect(info).toHaveBeenCalledWith("Operations alert sent.", { requestId: REQUEST_ID, rules: ["stale_epub_job", "stuck_notification"] });
  });

  it("alerts the operator once for a stale reader question, linking the questions inbox", async () => {
    const { client, upserts } = fakeClient({ rows: allInactive().map(toRow) });
    const { provider, sent } = recordingProvider();

    const result = await reconcileOperationsAlerts({
      client,
      report: report({
        stale_reader_question: [
          { id: "q-1", rule: "stale_reader_question", occurredAt: EARLIER, summary: "s", repairPath: "/admin/questions" },
        ],
      }),
      mail: { provider, ...MAIL },
      siteUrl: SITE,
      requestId: REQUEST_ID,
    });

    expect(result.alertsSent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Infinity Books Press operations: 1 rule needs attention");
    for (const body of [sent[0].text, sent[0].html]) {
      expect(body).toContain("Unanswered reader questions: 1");
      expect(body).toContain(`${SITE}/admin/questions`);
    }
    const row = upserts[0].rows.find((r) => r.rule_name === "stale_reader_question");
    expect(row).toMatchObject({ active: true, fingerprint: sha256("q-1"), last_alerted_at: NOW.toISOString() });
  });

  it("derives the same idempotency key for the same finding sets within the hour", async () => {
    const first = recordingProvider();
    const second = recordingProvider();
    await reconcileOperationsAlerts({
      client: fakeClient({ rows: allInactive().map(toRow) }).client,
      report: twoRules,
      mail: { provider: first.provider, ...MAIL },
      siteUrl: SITE,
    });
    await reconcileOperationsAlerts({
      client: fakeClient({ rows: allInactive().map(toRow) }).client,
      report: { ...twoRules, evaluatedAt: "2026-09-16T12:05:00.000Z" },
      mail: { provider: second.provider, ...MAIL },
      siteUrl: SITE,
    });
    expect(second.sent[0].idempotencyKey).toBe(first.sent[0].idempotencyKey);
  });

  it("sends nothing when no rule needs an alert", async () => {
    const fp = sha256("job-1");
    const { client, upserts } = fakeClient({
      rows: allInactive({
        stale_epub_job: { active: true, fingerprint: fp, firstDetectedAt: EARLIER, lastAlertedAt: EARLIER },
      }).map(toRow),
    });
    const { provider, sent } = recordingProvider();
    const result = await reconcileOperationsAlerts({
      client,
      report: report({ stale_epub_job: [f("stale_epub_job", "job-1")] }),
      mail: { provider, ...MAIL },
      siteUrl: SITE,
    });
    expect(result.alertsSent).toBe(0);
    expect(sent).toHaveLength(0);
    expect(upserts[0].rows.find((row) => row.rule_name === "stale_epub_job")).toMatchObject({
      active: true,
      fingerprint: fp,
      last_alerted_at: EARLIER,
      last_evaluated_at: NOW.toISOString(),
    });
  });

  it("does not move last_alerted_at when sending fails, and the next run retries", async () => {
    const { client, upserts } = fakeClient({ rows: allInactive().map(toRow) });
    const { provider } = recordingProvider(new MailProviderError("provider_unavailable", "down"));
    const result = await reconcileOperationsAlerts({
      client,
      report: twoRules,
      mail: { provider, ...MAIL },
      siteUrl: SITE,
      requestId: REQUEST_ID,
    });

    expect(result.alertsSent).toBe(0);
    expect(warn).toHaveBeenCalledWith("Operations alert failed.", {
      requestId: REQUEST_ID,
      code: "provider_unavailable",
      rules: ["stale_epub_job", "stuck_notification"],
    });
    const stale = upserts[0].rows.find((row) => row.rule_name === "stale_epub_job")!;
    expect(stale).toMatchObject({
      active: true,
      first_detected_at: NOW.toISOString(),
      last_evaluated_at: NOW.toISOString(),
      last_alerted_at: null,
      // The alert is still owed, so the stored fingerprint stays the last alerted one.
      fingerprint: null,
    });

    // The next run with the stored state still owes the alert and sends it.
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const retry = recordingProvider();
    const next = await reconcileOperationsAlerts({
      client: fakeClient({ rows: upserts[0].rows }).client,
      report: { ...twoRules, evaluatedAt: later.toISOString() },
      mail: { provider: retry.provider, ...MAIL },
      siteUrl: SITE,
    });
    expect(next.alertsSent).toBe(2);
    expect(retry.sent).toHaveLength(1);
  });

  it("keeps the previously alerted fingerprint when a changed-set alert fails", async () => {
    const oldFp = sha256("job-0");
    const { client, upserts } = fakeClient({
      rows: allInactive({
        stale_epub_job: { active: true, fingerprint: oldFp, firstDetectedAt: EARLIER, lastAlertedAt: EARLIER },
      }).map(toRow),
    });
    const { provider } = recordingProvider(new Error("boom"));
    await reconcileOperationsAlerts({
      client,
      report: report({ stale_epub_job: [f("stale_epub_job", "job-1")] }),
      mail: { provider, ...MAIL },
      siteUrl: SITE,
    });
    expect(warn).toHaveBeenCalledWith("Operations alert failed.", expect.objectContaining({ code: "provider_error" }));
    expect(upserts[0].rows.find((row) => row.rule_name === "stale_epub_job")).toMatchObject({
      fingerprint: oldFp,
      last_alerted_at: EARLIER,
      first_detected_at: EARLIER,
      last_evaluated_at: NOW.toISOString(),
    });
  });

  it("records state without sending when alert mail is not configured", async () => {
    const { client, upserts } = fakeClient({ rows: allInactive().map(toRow) });
    const result = await reconcileOperationsAlerts({ client, report: twoRules, mail: null, siteUrl: SITE, requestId: REQUEST_ID });
    expect(result.alertsSent).toBe(0);
    expect(warn).toHaveBeenCalledWith("Operations alert not configured.", {
      requestId: REQUEST_ID,
      rules: ["stale_epub_job", "stuck_notification"],
    });
    expect(upserts[0].rows.find((row) => row.rule_name === "stale_epub_job")).toMatchObject({
      active: true,
      last_alerted_at: null,
      last_evaluated_at: NOW.toISOString(),
    });
  });

  it("marks a cleared rule resolved without sending", async () => {
    const { client, upserts } = fakeClient({
      rows: allInactive({
        stale_epub_job: { active: true, fingerprint: sha256("job-1"), firstDetectedAt: EARLIER, lastAlertedAt: EARLIER },
      }).map(toRow),
    });
    const { provider, sent } = recordingProvider();
    await reconcileOperationsAlerts({ client, report: report({}), mail: { provider, ...MAIL }, siteUrl: SITE });
    expect(sent).toHaveLength(0);
    expect(upserts[0].rows.find((row) => row.rule_name === "stale_epub_job")).toMatchObject({
      active: false,
      fingerprint: null,
      resolved_at: NOW.toISOString(),
      last_alerted_at: EARLIER,
    });
  });

  it("throws when the state cannot be read or written, before or after sending", async () => {
    await expect(
      reconcileOperationsAlerts({
        client: fakeClient({ rows: [], selectError: { code: "XX000" } }).client,
        report: twoRules,
        mail: null,
        siteUrl: SITE,
      }),
    ).rejects.toThrow("Operations query failed: operations_alert_state");

    await expect(
      reconcileOperationsAlerts({
        client: fakeClient({ rows: allInactive().map(toRow), upsertError: { code: "42501" } }).client,
        report: twoRules,
        mail: null,
        siteUrl: SITE,
      }),
    ).rejects.toThrow("Operations alert state could not be saved.");
    expect(error).toHaveBeenCalledWith("Operations alert state could not be saved.", {
      requestId: expect.any(String),
      code: "42501",
    });
  });
});
