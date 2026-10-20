import { type NextRequest, NextResponse } from "next/server";

import { getServerEnv } from "@/lib/config/server-env";
import { loadOperationsSnapshot, OperationsQueryError } from "@/lib/data/operations";
import { deliverNotificationBatch, type DeliveryResult } from "@/lib/email/outbox";
import { getMailProvider, MailProviderError, type MailProvider } from "@/lib/email/provider";
import { evaluateOperations } from "@/lib/ops/checks";
import { reconcileOperationsAlerts } from "@/lib/ops/alerts";
import { OPS_RULE_NAMES, type OperationsReport, type OpsRuleName } from "@/lib/ops/types";
import { isAuthorizedWorkerSecret } from "@/lib/ops/worker-auth";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { createAdminClient } from "@/lib/supabase/admin";

// Secret scheduled worker (spec S5 5.2, 10, 12). Supabase pg_cron POSTs here every five minutes
// with the OPS_WORKER_SECRET bearer token: no session, no requireAdmin(), no browser caller. The
// route drains the notification outbox - book-ready messages and, since S9, gift claim links -
// evaluates the operational rules against one `now`, and reconciles operator alerts. It never
// returns customer data, and its counts are deliberately per-batch rather than per-template: a
// template breakdown in this response would be a per-recipient signal in an unauthenticated shape.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A worst-case run - 25 book-ready sends plus one operator alert, each hitting the 10 s Resend
// timeout - takes about 260 s, beyond the platform default. 300 s is the Vercel Hobby maximum
// with Fluid compute, and it stays within the outbox's five-minute claim lease. pg_net gives up
// waiting after 30 s, but the run continues server-side (docs/runbooks/seo-and-operations.md 4).
export const maxDuration = 300;

type OperationsRunResponse = {
  requestId: string;
  outbox: { claimed: number; sent: number; failed: number };
  findings: Record<OpsRuleName, number>;
  // Number of rules covered by the accepted alert email (spec S5 controller ruling R14): what
  // reconcileOperationsAlerts reports as `alertsSent`, i.e. 0 unless an alert email was actually
  // accepted by the provider this run.
  alertsSent: number;
};

function respond(status: number, body: Record<string, unknown>, requestId: string): NextResponse {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "Cache-Control": "no-store", [REQUEST_ID_HEADER]: requestId } },
  );
}

function safeErrorCode(error: unknown): string {
  return error instanceof MailProviderError ? error.code : "provider_error";
}

// Mail is optional outside production (spec S5 11): when it is not configured, outbox delivery and
// operator alerts are both skipped for this run rather than failing it.
function resolveMailProvider(requestId: string): MailProvider | null {
  try {
    return getMailProvider(getServerEnv());
  } catch (error) {
    console.warn("Operations worker mail is not configured; skipping outbox delivery and alerts.", {
      requestId,
      code: safeErrorCode(error),
    });
    return null;
  }
}

function countFindings(report: OperationsReport): Record<OpsRuleName, number> {
  return Object.fromEntries(OPS_RULE_NAMES.map((rule) => [rule, report.findings[rule].length])) as Record<
    OpsRuleName,
    number
  >;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = getRequestId(request.headers);
  const env = getServerEnv();

  if (!env.opsWorkerSecret) {
    console.error("Operations worker secret is not configured.", { requestId });
    return respond(503, { error: "worker_not_configured" }, requestId);
  }

  if (!isAuthorizedWorkerSecret(request.headers.get("authorization"), env.opsWorkerSecret)) {
    console.warn("Operations worker request was not authorized.", { requestId });
    return respond(401, { error: "unauthorized" }, requestId);
  }

  const client = createAdminClient();

  const provider = resolveMailProvider(requestId);
  let outbox: DeliveryResult = { claimed: 0, sent: 0, failed: 0, leaseLost: 0 };
  if (provider && env.emailFrom) {
    try {
      outbox = await deliverNotificationBatch({
        client,
        provider,
        siteUrl: env.siteUrl,
        from: env.emailFrom,
        leaseToken: crypto.randomUUID(),
        requestId,
      });
    } catch {
      // The claim RPC itself failed (a per-row failure is already counted, not thrown). The outbox
      // step never fails the run (spec S5 5.2): counts simply stay at zero for this pass.
      console.error("Operations worker outbox delivery failed; continuing without it.", { requestId });
    }
  }

  const now = new Date();

  try {
    const snapshot = await loadOperationsSnapshot(client, now);
    const report = evaluateOperations(snapshot, now);
    const reconciled = await reconcileOperationsAlerts({
      client,
      report,
      mail: provider && env.emailFrom && env.opsAlertEmail ? { provider, from: env.emailFrom, to: env.opsAlertEmail } : null,
      siteUrl: env.siteUrl,
      requestId,
    });

    const body: OperationsRunResponse = {
      requestId,
      outbox: { claimed: outbox.claimed, sent: outbox.sent, failed: outbox.failed },
      findings: countFindings(report),
      alertsSent: reconciled.alertsSent,
    };
    console.info("Operations worker run completed.", {
      requestId,
      outbox: body.outbox,
      findings: body.findings,
      alertsSent: body.alertsSent,
    });
    return respond(200, body, requestId);
  } catch (error) {
    // Safe fields only: a query error's source is a fixed table name, never row data.
    const detail =
      error instanceof OperationsQueryError ? { source: error.source, code: error.code } : { code: "unexpected" };
    console.error("Operations run failed.", { requestId, ...detail });
    return respond(500, { error: "operations_run_failed" }, requestId);
  }
}
