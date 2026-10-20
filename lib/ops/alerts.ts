import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadOperationsAlertState } from "@/lib/data/operations";
import { MailProviderError, type MailProvider } from "@/lib/email/provider";
import { resolveRequestId } from "@/lib/observability/request-id";
import {
  OPS_RULE_NAMES,
  RULE_LABELS,
  type OperationsAlertState,
  type OperationsReport,
  type OpsFinding,
  type OpsRuleName,
} from "@/lib/ops/types";
import type { Database } from "@/lib/supabase/database.types";

// Alert reconciliation (spec S5 6.4, 10.4). The caller passes a service-role client after the
// worker's bearer-token gate: only service_role can write operations_alert_state.
//
// A rule needs an alert when it becomes active, its finding fingerprint changes, or it stays
// active without a successful alert for 24 hours. All rules needing an alert share one email.
//
// `fingerprint` is stored as the fingerprint of the last alert that did not fail: when sending
// fails (or alert mail is not configured) the row keeps its previous fingerprint and
// last_alerted_at, so the next run still sees the alert as owed and retries it. active,
// first_detected_at, resolved_at, and last_evaluated_at always reflect this evaluation.

export const ALERT_REMINDER_MS = 24 * 60 * 60_000;
// Links per rule in the alert email; the operations page lists the rest.
const MAX_LINKS_PER_RULE = 10;

export type AlertReason = "new" | "changed" | "overdue";

export type AlertPlan = {
  rule: OpsRuleName;
  findings: OpsFinding[];
  fingerprint: string | null;
  reason: AlertReason | null;
  previous: OperationsAlertState;
  // The state to store if the alert (when one is owed) is accepted.
  next: OperationsAlertState;
};

export function fingerprintFindings(findings: OpsFinding[]): string {
  const ids = findings.map((finding) => finding.id).sort();
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

function emptyState(rule: OpsRuleName, evaluatedAt: string): OperationsAlertState {
  return {
    ruleName: rule,
    active: false,
    fingerprint: null,
    firstDetectedAt: null,
    lastEvaluatedAt: evaluatedAt,
    lastAlertedAt: null,
    resolvedAt: null,
  };
}

function planRule(previous: OperationsAlertState, findings: OpsFinding[], now: Date): AlertPlan {
  const at = now.toISOString();
  const rule = previous.ruleName;

  if (findings.length === 0) {
    return {
      rule,
      findings,
      fingerprint: null,
      reason: null,
      previous,
      next: {
        ...previous,
        active: false,
        fingerprint: null,
        lastEvaluatedAt: at,
        resolvedAt: previous.active ? at : previous.resolvedAt,
      },
    };
  }

  const fingerprint = fingerprintFindings(findings);
  let reason: AlertReason | null = null;
  if (!previous.active) reason = "new";
  else if (previous.fingerprint !== fingerprint) reason = "changed";
  else if (previous.lastAlertedAt === null || now.getTime() - Date.parse(previous.lastAlertedAt) >= ALERT_REMINDER_MS) {
    reason = "overdue";
  }

  return {
    rule,
    findings,
    fingerprint,
    reason,
    previous,
    next: {
      ...previous,
      active: true,
      fingerprint,
      firstDetectedAt: previous.active ? previous.firstDetectedAt : at,
      lastEvaluatedAt: at,
      resolvedAt: null,
    },
  };
}

// Pure: one plan per rule, in OPS_RULE_NAMES order. A missing state row counts as inactive.
export function planAlertTransitions(states: OperationsAlertState[], report: OperationsReport): AlertPlan[] {
  const now = new Date(report.evaluatedAt);
  const byRule = new Map(states.map((state) => [state.ruleName, state]));
  return OPS_RULE_NAMES.map((rule) =>
    planRule(byRule.get(rule) ?? emptyState(rule, report.evaluatedAt), report.findings[rule], now),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function absolute(path: string, siteUrl: string): string {
  return new URL(path, siteUrl).toString();
}

// Counts and absolute /admin links only - never a customer email, provider payload, or book text.
// The body depends only on the alerted rules and their findings, so a retry of the same alert
// carries the same payload as its idempotency key.
export function buildOperationsAlertEmail(plans: AlertPlan[], siteUrl: string): { subject: string; text: string; html: string } {
  const count = plans.length;
  const subject = `Infinity Books Press operations: ${count} ${count === 1 ? "rule needs" : "rules need"} attention`;
  const overview = absolute("/admin/operations", siteUrl);

  const sections = plans.map((plan) => {
    const heading = `${RULE_LABELS[plan.rule]}: ${plan.findings.length}`;
    const links = plan.findings.slice(0, MAX_LINKS_PER_RULE).map((finding) => absolute(finding.repairPath, siteUrl));
    const more = plan.findings.length - links.length;
    return { heading, links, more };
  });

  const text = [
    "These operational checks need attention:",
    "",
    ...sections.flatMap((section) => [
      section.heading,
      ...section.links.map((link) => `- ${link}`),
      ...(section.more > 0 ? [`- and ${section.more} more`] : []),
      "",
    ]),
    `Review all findings: ${overview}`,
  ].join("\n");

  const html = [
    "<p>These operational checks need attention:</p>",
    ...sections.map(
      (section) =>
        `<h3>${escapeHtml(section.heading)}</h3><ul>${section.links
          .map((link) => `<li><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></li>`)
          .join("")}${section.more > 0 ? `<li>and ${section.more} more</li>` : ""}</ul>`,
    ),
    `<p><a href="${escapeHtml(overview)}">Review all findings: ${escapeHtml(overview)}</a></p>`,
  ].join("\n");

  return { subject, text, html };
}

// Deterministic per alerted finding set and UTC hour: a retry after an ambiguous provider failure
// within the hour cannot double-send, while a changed set or a 24-hour reminder gets a new key.
export function operationsAlertIdempotencyKey(plans: AlertPlan[], now: Date): string {
  const lines = plans.map((plan) => `${plan.rule}:${plan.fingerprint}`).sort();
  const window = now.toISOString().slice(0, 13);
  return `ops-alert/${createHash("sha256").update([...lines, window].join("\n")).digest("hex")}`;
}

function toRow(state: OperationsAlertState): Database["public"]["Tables"]["operations_alert_state"]["Insert"] {
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

export type OperationsAlertMail = { provider: MailProvider; from: string; to: string };

export type ReconcileDeps = {
  client: SupabaseClient<Database>;
  report: OperationsReport;
  // null when alert mail is not configured for this environment: state is still recorded.
  mail: OperationsAlertMail | null;
  siteUrl: string;
  requestId?: string;
};

export type ReconcileResult = {
  // Number of rules covered by an alert email the provider accepted (0 when none was sent).
  alertsSent: number;
  states: OperationsAlertState[];
};

export async function reconcileOperationsAlerts(deps: ReconcileDeps): Promise<ReconcileResult> {
  const requestId = resolveRequestId(deps.requestId);
  const now = new Date(deps.report.evaluatedAt);
  const plans = planAlertTransitions(await loadOperationsAlertState(deps.client), deps.report);
  const owed = plans.filter((plan) => plan.reason !== null);
  const rules = owed.map((plan) => plan.rule);

  let accepted = false;
  if (owed.length > 0) {
    if (!deps.mail) {
      console.warn("Operations alert not configured.", { requestId, rules });
    } else {
      try {
        await deps.mail.provider.send({
          from: deps.mail.from,
          to: deps.mail.to,
          ...buildOperationsAlertEmail(owed, deps.siteUrl),
          idempotencyKey: operationsAlertIdempotencyKey(owed, now),
        });
        accepted = true;
        console.info("Operations alert sent.", { requestId, rules });
      } catch (error) {
        const code = error instanceof MailProviderError ? error.code : "provider_error";
        console.warn("Operations alert failed.", { requestId, code, rules });
      }
    }
  }

  const states = plans.map((plan): OperationsAlertState => {
    if (plan.reason === null) return plan.next;
    if (accepted) return { ...plan.next, lastAlertedAt: now.toISOString() };
    return { ...plan.next, fingerprint: plan.previous.fingerprint, lastAlertedAt: plan.previous.lastAlertedAt };
  });

  const { error } = await deps.client
    .from("operations_alert_state")
    .upsert(states.map(toRow), { onConflict: "rule_name" });
  if (error) {
    console.error("Operations alert state could not be saved.", { requestId, code: error.code ?? null });
    throw new Error("Operations alert state could not be saved.");
  }

  return { alertsSent: accepted ? owed.length : 0, states };
}
