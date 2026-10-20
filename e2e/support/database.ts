import { execFileSync } from "node:child_process";

// Direct SQL against the LOCAL Postgres, for the one fixture no API role can write.
//
// notification_outbox has no insert/update grant for any role, service_role included: the entitlement
// trigger and the three outbox RPCs are its only writers, and fail_notification_outbox pushes each
// retry at least a minute out. A row that has failed four times - the state the stuck-notification
// rule reports - is therefore reachable only by waiting hours or by writing the columns as the table
// owner. This does the latter, through `psql`, and only ever against a loopback database.
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireLoopbackDatabaseUrl(): string {
  const value = process.env.E2E_DATABASE_URL;
  if (!value) throw new Error("E2E_DATABASE_URL must point to the local Supabase Postgres");

  let hostname: string;
  try {
    ({ hostname } = new URL(value));
  } catch {
    throw new Error("E2E_DATABASE_URL is not a valid URL");
  }
  if (!loopbackHosts.has(hostname)) {
    throw new Error(`Refusing to run fixture SQL against "${hostname}". E2E_DATABASE_URL must be a loopback database.`);
  }
  return value;
}

function runSql(sql: string): string {
  return execFileSync("psql", [requireLoopbackDatabaseUrl(), "-v", "ON_ERROR_STOP=1", "-Atc", sql], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

// The state fail_notification_outbox leaves after a row's fourth failed send: four attempts, a safe
// error code, no lease, and the next retry two hours away (so no worker run in the suite picks it
// up and clears the finding by delivering it).
export function markOutboxFailedFourTimes(outboxId: string): void {
  if (!uuidPattern.test(outboxId)) throw new Error(`Not an outbox id: ${outboxId}`);
  runSql(
    `update public.notification_outbox
       set attempt_count = 4,
           last_error_code = 'resend_http_503',
           lease_token = null,
           lease_expires_at = null,
           available_at = now() + interval '2 hours'
     where id = '${outboxId}' and sent_at is null`,
  );
}

// The one gift delivery row for an order, read directly for the same reason the helper above
// writes directly: no API role can reach it. `gifts` is revoked from service_role as well as from
// every browser role (20260924150000), so there is no Data API path from an order to its gift, and
// the claim path lives in `notification_outbox.payload`, which is admin-readable only.
//
// The returned claimPath is a live credential. It is handed to the caller and goes nowhere else:
// nothing here logs it, and a spec must not put it in a title, an annotation, or a trace.
export type GiftDelivery = {
  outboxId: string;
  giftStatus: string;
  // Null once claim_gift has cleared the payload, which is what a claimed gift looks like.
  claimPath: string | null;
  sentAt: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  providerMessageId: string | null;
};

export function readGiftDelivery(orderId: string): GiftDelivery | null {
  if (!uuidPattern.test(orderId)) throw new Error(`Not an order id: ${orderId}`);
  const json = runSql(
    `select coalesce(json_agg(row_to_json(r))::text, '[]')
     from (
       select o.id as "outboxId",
              g.status as "giftStatus",
              o.payload ->> 'claimPath' as "claimPath",
              o.sent_at as "sentAt",
              o.attempt_count as "attemptCount",
              o.last_error_code as "lastErrorCode",
              o.provider_message_id as "providerMessageId"
       from public.gifts g
       join public.notification_outbox o on o.gift_id = g.id
       where g.order_id = '${orderId}'
     ) r`,
  );
  const rows = JSON.parse(json) as GiftDelivery[];
  if (rows.length > 1) throw new Error(`Expected at most one gift delivery row for order ${orderId}`);
  return rows[0] ?? null;
}
