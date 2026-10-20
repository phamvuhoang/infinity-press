import { locales } from "@/lib/i18n/config";
import { createPublicClient } from "@/lib/supabase/public";

// Stored public redirects (S5 spec 4.6, 7.6, 12). Proxy calls findPublicRedirect before session
// refresh. The database function returns one relative destination for an exact source path; this
// module decides which requests may be redirected and which destinations are safe to send.

export const REDIRECT_CACHE_TTL_MS = 60_000;
export const REDIRECT_CACHE_LIMIT = 500;

// Surfaces a stored redirect may never lead to: application, sign-in, and customer-only routes.
// Matched by whole path segments, so /vi/read-sample is not /vi/read. Only the private roots are
// also barred as a redirect start (isRedirectEligible); a private localized page such as
// /vi/account is still looked up, so an exact stored source path there would redirect.
const privateRoots = new Set(["admin", "api", "auth", "internal", "_next", "_vercel"]);
const privateLocalizedPages = new Set([
  "account",
  "ask",
  "checkout",
  "library",
  "read",
  "search",
  "sign-in",
  "sign-up",
  "password-reset",
  "password-update",
]);

// Metadata routes and static files the Proxy matcher does not already exclude. A legacy page path
// such as /old-page.html stays eligible, because redirecting it is what stored redirects are for.
const metadataRoutes = new Set(["opengraph-image", "twitter-image", "icon", "apple-icon"]);
const staticAssetPattern =
  /\.(?:css|js|mjs|map|json|xml|txt|ico|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|webmanifest)$/i;

// One leading slash, then non-space characters with no backslash or fragment. This also
// rules out a scheme and a protocol-relative `//host`.
const destinationPattern = /^\/(?!\/)[^\s\\#]*$/;
const origin = "https://infinity-books.invalid";

function isLocaleSegment(segment: string | undefined): boolean {
  return locales.some((locale) => locale === segment);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

export function isSafeRedirectDestination(path: string): boolean {
  if (!destinationPattern.test(path) || hasControlCharacter(path)) return false;

  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;

  const [, first, second] = url.pathname.split("/");
  if (privateRoots.has(first)) return false;
  return !(isLocaleSegment(first) && privateLocalizedPages.has(second));
}

export function isRedirectEligible(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;

  const segments = pathname.split("/");
  if (privateRoots.has(segments[1])) return false;

  return !metadataRoutes.has(segments[segments.length - 1]) && !staticAssetPattern.test(pathname);
}

type CacheEntry = { value: string | null; expiresAt: number };

// A best-effort, process-local cache of hits and misses. Correctness never depends on it: an
// expired or evicted entry reads the database again, and a failed read is not cached.
export function createRedirectResolver({
  lookup,
  now = Date.now,
}: {
  lookup: (sourcePath: string) => Promise<string | null>;
  now?: () => number;
}) {
  const cache = new Map<string, CacheEntry>();

  async function cachedLookup(sourcePath: string): Promise<string | null> {
    const cached = cache.get(sourcePath);
    if (cached && cached.expiresAt > now()) return cached.value;

    const value = await lookup(sourcePath);
    cache.delete(sourcePath);
    if (cache.size >= REDIRECT_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(sourcePath, { value, expiresAt: now() + REDIRECT_CACHE_TTL_MS });
    return value;
  }

  return async function resolve(sourcePath: string): Promise<string | null> {
    const destination = await cachedLookup(sourcePath);
    if (destination === null || destination === sourcePath) return null;
    return isSafeRedirectDestination(destination) ? destination : null;
  };
}

// Runs as anon through the cookie-less public client. Never the service role.
export const resolvePublicRedirect = createRedirectResolver({
  lookup: async (sourcePath) => {
    const { data, error } = await createPublicClient().rpc("resolve_public_redirect", {
      p_source_path: sourcePath,
    });
    if (error) throw error;
    return typeof data === "string" ? data : null;
  },
});

// The redirect target for this request, or null. The destination is built against the request
// URL, so it keeps the request origin, and the original query string is not carried over. A lookup
// failure is logged and the request continues: redirects must never take the storefront down.
export async function findPublicRedirect(
  request: { method: string; url: string },
  requestId: string,
  resolve: (sourcePath: string) => Promise<string | null> = resolvePublicRedirect,
): Promise<URL | null> {
  const { pathname } = new URL(request.url);
  if (!isRedirectEligible(request.method, pathname)) return null;

  let destination: string | null;
  try {
    destination = await resolve(pathname);
  } catch (cause) {
    console.error("Public redirect lookup failed.", {
      code: (cause as { code?: string } | null)?.code ?? null,
      message: (cause as { message?: string } | null)?.message ?? String(cause),
      requestId,
    });
    return null;
  }

  return destination ? new URL(destination, request.url) : null;
}
