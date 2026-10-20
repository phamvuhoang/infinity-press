import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { analyticsDeviceClasses, retailers } from "@/lib/analytics/browser";
import { trackEventBestEffort, type TrackEventInput } from "@/lib/analytics/events";
import { analyticsIntakeLimiter, clientIpFrom } from "@/lib/analytics/intake-limiter";
import { consumeAnalyticsQuota } from "@/lib/analytics/intake-quota";
import { getServerEnv } from "@/lib/config/server-env";
import { getCurrentProfile } from "@/lib/data/profiles";
import { readBoundedText } from "@/lib/http/bounded-body";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";

// Browser analytics intake (S5 spec 8.2). The largest valid body is well under 300 bytes; the limit
// leaves room for that and nothing else.
const MAX_BODY_BYTES = 1024;

// Only a signed-in person can reach the library or the full reader, so these events never come from
// an anonymous browser. Requiring a session for them keeps the only anonymous events to view_book,
// open_sample, click_external_store and view_quote, which the shared anonymous quota bounds.
const sessionBoundEvents = new Set(["view_library", "open_reader", "change_reader_setting"]);

// Database ids are checked for shape only (any 8-4-4-4-12 hex), because seeded and imported rows are
// not always RFC 4122 v4. The event ID is minted by crypto.randomUUID(), so it must be a real UUID.
const id = z.guid();
const locale = z.enum(["vi", "en"]);
const common = {
  eventId: z.uuid(),
  locale,
  deviceClass: z.enum(analyticsDeviceClasses).optional(),
};

// Strict objects throughout: an unknown key - a profile ID, a title, a locator - is a 400, not a
// silently dropped field. Server-owned events (checkout, payment, progress, publish, EPUB) are not
// members of this union, so a browser cannot forge them.
const browserEventSchema = z.discriminatedUnion("eventName", [
  z.strictObject({ eventName: z.enum(["view_book", "open_sample"]), bookId: id, ...common }),
  z.strictObject({ eventName: z.literal("click_external_store"), bookId: id, retailer: z.enum(retailers), ...common }),
  z.strictObject({ eventName: z.literal("view_quote"), sharedQuoteId: id, bookId: id, ...common }),
  z.strictObject({ eventName: z.literal("open_reader"), bookId: id, publicationId: id, ...common }),
  z.strictObject({ eventName: z.literal("change_reader_setting"), bookId: id, publicationId: id.optional(), ...common }),
  z.strictObject({ eventName: z.literal("view_library"), ...common }),
]);

function respond(status: number, body: Record<string, unknown>, requestId: string) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", [REQUEST_ID_HEADER]: requestId },
  });
}

// SITE_URL is the only origin that may post here. A missing Origin header is tolerated only in
// local and test, where scripted clients legitimately omit it; browsers always send it on a POST.
function isAllowedOrigin(origin: string | null): boolean {
  const env = getServerEnv();
  if (origin === null) return env.appEnv === "local" || env.appEnv === "test";
  return origin === env.siteUrl;
}

async function readProfileId(): Promise<string | undefined> {
  try {
    return (await getCurrentProfile())?.id;
  } catch {
    // A session outage must not become a 500. An anonymous event is still recorded, unattributed;
    // a session-bound one is refused as unauthorized.
    return undefined;
  }
}

// Identity comes from the session and nothing else. The User-Agent header is never read: the device
// class is the browser's own coarse viewport class, validated above, so no user-agent string can
// reach a log or a row by way of this handler.
export async function POST(request: NextRequest) {
  const requestId = getRequestId(request.headers);
  const fail = (status: number, error: string) => respond(status, { error, requestId }, requestId);

  if (!isAllowedOrigin(request.headers.get("origin"))) return fail(403, "forbidden");

  // The declared length is a cheap early refusal only; the bounded read is the real limit, because
  // a chunked body declares no length at all.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return fail(413, "too_large");
  const body = await readBoundedText(request.body, MAX_BODY_BYTES);
  // Invalid UTF-8 and a body the client abandoned mid-read are both just malformed requests.
  if (!body.ok) return body.reason === "too_large" ? fail(413, "too_large") : fail(400, "invalid_request");

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return fail(400, "invalid_request");
  }

  const parsed = browserEventSchema.safeParse(json);
  if (!parsed.success) return fail(400, "invalid_request");

  const { eventId, ...event } = parsed.data;
  const profileId = await readProfileId();
  if (!profileId && sessionBoundEvents.has(event.eventName)) return fail(401, "unauthorized");

  // Abuse controls, cheapest first, both before any privileged client exists. The per-instance
  // limiter stops one address from spending the shared anonymous bucket; the durable quota bounds
  // what reaches analytics_events across every instance.
  const clientIp = clientIpFrom(request.headers);
  if (clientIp !== undefined && !analyticsIntakeLimiter.allow(clientIp)) return fail(429, "rate_limited");

  const quota = await consumeAnalyticsQuota(profileId);
  if (quota === "limited") return fail(429, "rate_limited");
  if (quota !== "allowed") {
    // Fail closed: an event that cannot be counted is not written. 503 rather than a 202 that would
    // claim the event was accepted; the browser ignores the response either way, so no page breaks.
    console.error("Analytics intake quota check failed.", { requestId, code: quota.error });
    return fail(503, "unavailable");
  }

  const input: TrackEventInput = {
    ...event,
    // One row per client event: a beacon retried by the browser resolves to the same key.
    dedupeKey: `client/${eventId}`,
    ...(profileId ? { profileId } : {}),
  };
  if (input.deviceClass === undefined) delete input.deviceClass;

  await trackEventBestEffort(input, { requestId });
  return respond(202, { accepted: true }, requestId);
}
