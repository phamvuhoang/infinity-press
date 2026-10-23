const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requirePublicationId(publicationId: string): void {
  if (!UUID_PATTERN.test(publicationId)) throw new Error("Invalid publication ID");
}

function normalizeHref(href: string): string {
  if (href.includes("?") || href.includes("#")) throw new Error("Invalid publication resource href");
  if (
    /[%\\\x00-\x20]/.test(href) ||
    href.startsWith("/") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)
  ) {
    throw new Error("Invalid publication resource href");
  }
  const parts = href.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Invalid publication resource href");
  }
  return parts.join("/");
}

function encodeHref(href: string): string {
  return normalizeHref(href).split("/").map(encodeURIComponent).join("/");
}

export function toReaderResourceHref(publicationId: string, href: string): string {
  requirePublicationId(publicationId);
  return `/api/reader/publications/${publicationId}/resources/${encodeHref(href)}`;
}

// The href a sample manifest (lib/reader/session.ts) lists for a resource.
export function toSampleResourceHref(publicationId: string, href: string): string {
  requirePublicationId(publicationId);
  return `/api/samples/${publicationId}/resources/${encodeHref(href)}`;
}

export function toPublicationResourceHref(publicationId: string, href: string): string {
  requirePublicationId(publicationId);
  if (href.includes("?") || href.includes("#")) throw new Error("Invalid reader resource href");

  const prefix = `/api/reader/publications/${publicationId}/resources/`;
  if (!href.startsWith(prefix)) throw new Error("Invalid reader resource href");

  const encoded = href.slice(prefix.length);
  let decoded: string;
  try {
    decoded = encoded.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new Error("Invalid reader resource href");
  }
  return normalizeHref(decoded);
}
