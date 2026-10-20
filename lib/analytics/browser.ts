// Browser side of the analytics beacon (S5 spec 8.2). A Server Component render is not a page view -
// Next.js renders pages for prefetch and metadata work too - so these events are sent from the
// browser once something actually happened on screen, to POST /api/analytics/events.

export const ANALYTICS_EVENTS_PATH = "/api/analytics/events";

export const analyticsDeviceClasses = ["mobile", "tablet", "desktop"] as const;
export type AnalyticsDeviceClass = (typeof analyticsDeviceClasses)[number];

type Locale = "vi" | "en";

export const retailers = ["shopee", "fahasa", "tiki", "other"] as const;
export type Retailer = (typeof retailers)[number];

// The only events a browser may send, each with only the identifiers it needs. The route enforces
// the same shape with a strict schema; this type keeps callers from building anything else. The route
// also refuses open_reader, change_reader_setting, and view_library without a signed-in session, so
// only signed-in surfaces send those.
export type BrowserEventInput =
  | { eventName: "view_book" | "open_sample"; bookId: string; locale: Locale }
  | { eventName: "click_external_store"; bookId: string; retailer: Retailer; locale: Locale }
  | { eventName: "open_reader"; bookId: string; publicationId: string; locale: Locale }
  | { eventName: "change_reader_setting"; bookId: string; publicationId?: string; locale: Locale }
  | { eventName: "view_library"; locale: Locale }
  | { eventName: "view_quote"; sharedQuoteId: string; bookId: string; locale: Locale };

// Tailwind's `sm` and `lg` breakpoints, the same ones every page layout here switches on: below 640px
// is a phone layout, 640-1023px a tablet layout, 1024px and up the desktop layout. Only this coarse
// class leaves the browser - never the width itself, and never the user-agent string.
const TABLET_MIN_WIDTH = 640;
const DESKTOP_MIN_WIDTH = 1024;

export function deviceClassForViewportWidth(width: number): AnalyticsDeviceClass | undefined {
  if (!Number.isFinite(width) || width <= 0) return undefined;
  if (width < TABLET_MIN_WIDTH) return "mobile";
  if (width < DESKTOP_MIN_WIDTH) return "tablet";
  return "desktop";
}

function trySendBeacon(blob: Blob): boolean {
  try {
    return typeof navigator.sendBeacon === "function" && navigator.sendBeacon(ANALYTICS_EVENTS_PATH, blob);
  } catch {
    return false;
  }
}

// Fire and forget. Each event carries a fresh client UUID, which the route turns into the row's
// dedupe key, so a beacon that is delivered twice still records one event. Nothing here can throw
// into the page: analytics that fails costs a data point, never a broken screen.
export function sendAnalyticsEvent(input: BrowserEventInput): void {
  try {
    const deviceClass = deviceClassForViewportWidth(window.innerWidth);
    const body = JSON.stringify({
      eventId: crypto.randomUUID(),
      ...input,
      ...(deviceClass ? { deviceClass } : {}),
    });

    // sendBeacon survives the page being closed or navigated away from, which is exactly when a
    // reader leaves; a keepalive fetch is the fallback with the same property.
    if (trySendBeacon(new Blob([body], { type: "application/json" }))) return;

    void fetch(ANALYTICS_EVENTS_PATH, {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => undefined);
  } catch {
    // Nothing to do: see above.
  }
}
