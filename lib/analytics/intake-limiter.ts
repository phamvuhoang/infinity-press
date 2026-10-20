import "server-only";
import { createHmac, randomBytes } from "node:crypto";

// Per-instance limiter in front of the durable analytics quota (POST /api/analytics/events). The
// durable quota has one shared bucket for every anonymous caller; without this layer, one client
// could spend that whole bucket and silence every other anonymous visitor's events.
//
// The client address never leaves this module and is never kept: each key is an HMAC-SHA256 of the
// address under a random salt that lives only in this process's memory, so the map holds nothing
// that could be reversed, matched against another instance, or survive a restart. It is never logged.

// A person browsing sends a few events a minute; a burst of reader-setting changes might send a
// dozen. Sixty per minute per address per instance leaves room for that and for several people
// behind one NAT, while staying well under the shared anonymous quota.
export const CLIENT_INTAKE_LIMIT = 60;
export const CLIENT_INTAKE_WINDOW_MS = 60_000;
// Bounds memory at a few hundred kilobytes whatever the traffic.
export const CLIENT_INTAKE_MAX_ENTRIES = 5_000;

// Longer than any real address (IPv6 with a zone is under 64); anything longer is not an address.
const MAX_ADDRESS_LENGTH = 100;

type LimiterOptions = {
  limit: number;
  windowMs: number;
  maxEntries: number;
  now?: () => number;
};

type Window = { start: number; count: number };

export function createIntakeLimiter({ limit, windowMs, maxEntries, now = Date.now }: LimiterOptions) {
  const salt = randomBytes(32);
  // Map iteration order is insertion order, and every touch re-inserts, so the first key is always
  // the least recently seen client: the one to evict when the map is full.
  const windows = new Map<string, Window>();

  function keyFor(address: string): string {
    return createHmac("sha256", salt).update(address).digest("hex");
  }

  return {
    // Whether one more event from this address fits in its current window.
    allow(address: string): boolean {
      const key = keyFor(address);
      const time = now();
      const existing = windows.get(key);
      const current: Window =
        existing && time - existing.start < windowMs ? existing : { start: time, count: 0 };

      // Re-insert at the end: this client is now the most recently seen.
      windows.delete(key);
      if (windows.size >= maxEntries) {
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) windows.delete(oldest);
      }
      windows.set(key, current);

      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    },
    size: () => windows.size,
    keysForTesting: () => [...windows.keys()],
  };
}

// The platform's view of the client address. On Vercel, x-real-ip is set by the edge from the
// connection itself; elsewhere the first x-forwarded-for entry is the best available. A client can
// forge either off-platform, which only lets it pick a different limiter key - the durable quota
// still bounds it. Returns undefined when there is no usable address, and the caller then skips this
// layer rather than lumping every such request under one key.
export function clientIpFrom(headers: Headers): string | undefined {
  const candidate = headers.get("x-real-ip")?.trim() || headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!candidate || candidate.length > MAX_ADDRESS_LENGTH) return undefined;
  return candidate;
}

// One limiter per server instance, with its salt drawn at module load.
export const analyticsIntakeLimiter = createIntakeLimiter({
  limit: CLIENT_INTAKE_LIMIT,
  windowMs: CLIENT_INTAKE_WINDOW_MS,
  maxEntries: CLIENT_INTAKE_MAX_ENTRIES,
});
