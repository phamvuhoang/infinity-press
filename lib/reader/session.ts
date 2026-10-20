import "server-only";

import type { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { EBOOK_DERIVED_BUCKET } from "@/lib/epub/constants";
import type { PublicationMetadata, ReadingOrderItem, TocEntry } from "@/lib/epub/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { parseBoundedReaderLocator } from "@/lib/reader/annotations";
import { toReaderResourceHref } from "@/lib/reader/locator-paths";
import type { ReaderLocator } from "@/lib/reader/types";

// Reader delivery: minting a short-lived session, re-authorizing it on every request, and
// resolving the two kinds of readable resource (entitled and sample) to a storage key.
//
// The two-client split, deliberate and pinned by tests (Rulings AD/AM, third instance here):
// entitlement and session checks run on the *user-session* client, because both RPCs below
// resolve the caller through auth.uid(), which is null under service_role (Ruling W's trap).
// The derived-object read then runs on the *service-role* client, because browser roles have no
// access to the private ebook-derived bucket at all. Authorization always completes first; the
// privileged client is never constructed for a request that was going to be refused.

// One opaque denial for every refusal reason. This is the whole 401/403/404 model in one type:
// "no such publication", "not readable", "superseded version", "no active entitlement",
// "session expired", "session revoked", "session belongs to another profile", "href is not a
// resource of this publication", and "href is not in the sample allowlist" are indistinguishable
// to the caller. Route handlers map this to a single 404 with one body, so a request for a real
// resource the caller lacks entitlement to looks exactly like a request for one that does not
// exist. A distinct 403 for "exists but forbidden" would be an existence oracle - that is the
// leak this single error type exists to make unrepresentable.
export class ReaderAccessDeniedError extends Error {
  constructor() {
    super("This content is not available.");
    this.name = "ReaderAccessDeniedError";
  }
}

// Ruling CF. The single-error contract above exists to make *authorization outcomes*
// indistinguishable from one another. It does not exist to make outages invisible, and until this
// round it did: a database fault, a storage fault, and a corrupt stored manifest all threw
// ReaderAccessDeniedError and reached the caller as 404 - a status operators read as normal,
// hiding a real incident behind it.
//
// This second class carries infrastructure failures to the handlers' existing generic 502 instead.
// It leaks nothing at any of its sites, and that is a property of where it is thrown rather than a
// hope: loadStoredManifest runs only after loadServablePublication has already confirmed the
// publication is servable (a fact the sample manifest route discloses anonymously anyway); the
// entitled resource query runs only after the caller's own entitlement is confirmed; and a
// database fault in loadServablePublication is resource-independent by construction, occurring
// regardless of which publication was asked for.
//
// What deliberately does NOT become this error: "no such row" and "not servable". Those are the
// existence facts the 404 model exists to hide, so they stay ReaderAccessDeniedError.
export class ReaderUnavailableError extends Error {
  constructor() {
    super("This content could not be loaded.");
    this.name = "ReaderUnavailableError";
  }
}

export type ReaderSessionGrant = {
  sessionId: string;
  publicationId: string;
  publicationVersion: number;
  expiresAt: string;
};

export type AuthorizedReaderContext = {
  profileId: string;
  publicationId: string;
  publicationVersion: number;
};

export type ResolvedResource = { storageKey: string; mediaType: string };

type ManifestLink = { href: string; type: string };

export type ReaderManifest = {
  "@context": string;
  metadata: PublicationMetadata;
  readingOrder: ManifestLink[];
  resources: ManifestLink[];
  // Present on both manifests, but built differently. The entitled manifest carries the book's
  // full table of contents with only its hrefs rewritten to Route Handler URLs; the sample
  // manifest carries one filtered to the servable set, with non-servable nodes dropped and their
  // servable descendants promoted. See rewriteTocHrefs and filterTocToServable respectively.
  toc?: TocEntry[];
  infinityBooks?: { positions: ReaderLocator[] | null };
};

type StoredManifest = {
  metadata: PublicationMetadata;
  readingOrder: ReadingOrderItem[];
  toc: TocEntry[];
};

const READIUM_CONTEXT = "https://readium.org/webpub-manifest/context.jsonld";

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  return (data as T) ?? null;
}

// Mints a session for the caller's own profile. The plan's interface line reads
// `createReaderSession(profileId, publicationId)`, but this deliberately takes only the
// publication id: it is reachable from a Route Handler, so a caller-supplied profile id would be
// a direct IDOR primitive (mint a session against someone else's profile). Ruling AO already
// settled this shape for acquire_free_ebook - the profile is derived from auth.uid() inside the
// security-definer RPC, and there is no parameter for a caller to substitute.
//
// The TTL is read from the validated server environment (READER_SESSION_TTL_SECONDS, bounded
// 60-3600 by lib/config/server-env-schema.ts) and passed in; it never comes from a request body.
// create_reader_session clamps it again in SQL, so even a direct PostgREST call by an
// authenticated user cannot mint a longer-lived session than the ceiling allows.
export async function createReaderSession(publicationId: string): Promise<ReaderSessionGrant> {
  const user = await getSessionUser();
  if (!user) throw new ReaderAccessDeniedError();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_reader_session", {
    p_publication_id: publicationId,
    p_ttl_seconds: getServerEnv().readerSessionTtlSeconds,
  });

  // Every failure collapses to the same denial, and no Postgres text is forwarded: the RPC
  // raises one code (EB008) for all of "no entitlement", "not readable", and "no such
  // publication" precisely so this layer cannot accidentally tell them apart either.
  if (error) throw new ReaderAccessDeniedError();

  const row = firstRow<{ id: string; publication_version: number; expires_at: string }>(data);
  if (!row) throw new ReaderAccessDeniedError();

  return {
    sessionId: row.id,
    publicationId,
    publicationVersion: row.publication_version,
    expiresAt: row.expires_at,
  };
}

// Re-runs the entire access decision on every manifest and resource request - expiry,
// revocation, ownership, entitlement, publication status, and version - rather than trusting
// that a session id exists. The composite FK ties a session to (publication_id,
// publication_version) but a superseded publication keeps its identity, so a session can outlive
// the publication's activity; that is exactly why this is per-request and not a creation-time
// check. Returns zero rows for every refusal, so the RPC itself cannot leak which check failed.
export async function authorizeReaderSession(
  sessionId: string,
  publicationId: string,
): Promise<AuthorizedReaderContext> {
  const user = await getSessionUser();
  if (!user) throw new ReaderAccessDeniedError();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("authorize_reader_session", {
    p_session_id: sessionId,
    p_publication_id: publicationId,
  });

  if (error) throw new ReaderAccessDeniedError();

  const row = firstRow<{ profile_id: string; publication_id: string; publication_version: number }>(data);
  if (!row) throw new ReaderAccessDeniedError();

  return {
    profileId: row.profile_id,
    publicationId: row.publication_id,
    publicationVersion: row.publication_version,
  };
}

// Where a reader session id is read from on an incoming request, in one place so all three
// entitled handlers agree.
//
// The cookie is the primary carrier and is set httpOnly by POST /api/reader/sessions: a reading
// engine fetches manifest and resource URLs as ordinary sub-resources, so putting the session in
// the URL instead would leak it into `Referer` headers, browser history, and access logs. It is
// named per publication so two books open at once do not evict each other's session.
//
// The header is the escape hatch for non-browser callers (tests, a future native client). Both
// are equally untrusted: whatever arrives here is only ever a lookup key for
// authorize_reader_session, which re-derives the profile from auth.uid() and rechecks everything
// - possessing a session id is not itself authorization.
export function readerSessionIdFrom(request: NextRequest, publicationId: string): string | null {
  const header = request.headers.get("x-reader-session");
  if (header) return header;
  return request.cookies.get(`reader-session-${publicationId}`)?.value ?? null;
}

// Task 1's review, Minor 5: `isReaderLocator` validates a locator's shape but deliberately does
// not normalize or path-check `href`, and its doc comment says so - this is where that job
// lives. Mirrors lib/epub/archive.ts's normalizeArchiveEntryPath, which is what produced these
// hrefs in the first place, so the two agree on what a legal in-publication path looks like.
//
// This only rejects malformed paths; it never grants access. A normalized href still has to
// match an ebook_resources row for the requested publication before anything is read, so the
// storage key can only ever come from the database - there is no path from a URL segment to an
// arbitrary object in the private bucket.
export function normalizeResourceHref(segments: string[]): string | null {
  if (segments.length === 0) return null;

  const decoded: string[] = [];
  for (const segment of segments) {
    try {
      // Next.js already percent-decodes catch-all params; decoding again is deliberate belt and
      // braces against a doubly-encoded traversal. It can only ever reject more, never less: a
      // filename that genuinely contains a percent sign fails closed here and would have to
      // match a resource row anyway.
      decoded.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }

  const joined = decoded.join("/");
  // Control characters and spaces, matching archive.ts's UNSAFE_REFERENCE_CHAR_PATTERN.
  if (/[\x00-\x20]/.test(joined)) return null;
  if (joined.includes("\\")) return null;
  if (joined.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(joined)) return null;

  const parts = joined.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return null;
  }

  return parts.join("/");
}

// The entitled read. Callers must have passed authorizeReaderSession first; this resolves the
// storage key from (publication_id, href) and nothing else. No access_class filter, on purpose:
// an entitled reader may read both paid and sample resources of the publication they hold.
export async function resolveEntitledResource(publicationId: string, href: string): Promise<ResolvedResource> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ebook_resources")
    .select("storage_key, media_type")
    .eq("publication_id", publicationId)
    .eq("href", href)
    .maybeSingle();

  if (error || !data) throw new ReaderAccessDeniedError();

  return { storageKey: data.storage_key, mediaType: data.media_type };
}

// Ruling AR: this takes no user gate of any kind, because anonymous visitors are the expected
// caller. The explicit server-side allowlist in book_samples.allowed_hrefs is the entire trust
// boundary, and it is what authorizes the read - sample membership is never inferred from a
// request parameter, a query string, or the resource's own path.
//
// Three things must agree, not two. Fix round 1, Critical 1: the allowlist and access_class were
// the whole check, and the publication's own state was not part of the boundary - so this route
// anonymously served sample bytes for publications that were awaiting review, explicitly
// rejected, or superseded. Those rows exist long before publication and are never removed
// (complete_processing_job writes the publication, its resources, and its allowlist in one
// transaction; the transitions only change `status`), so the exposure was permanent. The
// superseded case needed no secret to reach: that publication id was handed to every anonymous
// visitor inside its own sample manifest links while it was live.
//
// Both sources of the one truth Task 1's review flagged must also agree: the href has to be named
// in the allowlist AND its ebook_resources row has to carry access_class = 'sample'. Either alone
// is refused, so a drifting allowlist cannot promote a paid resource on its own.
export async function resolveSampleResource(publicationId: string, href: string): Promise<ResolvedResource> {
  const admin = createAdminClient();

  // Same call, same error, as resolveSampleManifest - the two sample paths now share one notion
  // of "is this publication servable at all".
  await loadServablePublication(admin, publicationId);

  const { data: sample, error: sampleError } = await admin
    .from("book_samples")
    .select("allowed_hrefs")
    .eq("publication_id", publicationId)
    .maybeSingle();

  if (sampleError || !sample) throw new ReaderAccessDeniedError();

  const allowed = Array.isArray(sample.allowed_hrefs) ? sample.allowed_hrefs : [];
  if (!allowed.includes(href)) throw new ReaderAccessDeniedError();

  const { data: resource, error: resourceError } = await admin
    .from("ebook_resources")
    .select("storage_key, media_type, access_class")
    .eq("publication_id", publicationId)
    .eq("href", href)
    .maybeSingle();

  if (resourceError || !resource || resource.access_class !== "sample") {
    throw new ReaderAccessDeniedError();
  }

  return { storageKey: resource.storage_key, mediaType: resource.media_type };
}

// Reads the stored manifest object (buildManifest()'s output, written by the worker to
// ebook_publications.manifest_key). That object deliberately carries no storage keys - it holds
// metadata, reading order, and toc keyed by href - so projecting it into application URLs here
// cannot leak an object path even by accident.
async function loadStoredManifest(
  admin: ReturnType<typeof createAdminClient>,
  manifestKey: string,
): Promise<StoredManifest> {
  // Both halves are infrastructure (Ruling CF): this is only reached once the publication is known
  // servable, so a missing or unreadable manifest object is a broken derived artefact, not an
  // access decision. Reporting it as 404 told the operator nothing was wrong.
  const { data, error } = await admin.storage.from(EBOOK_DERIVED_BUCKET).download(manifestKey);
  if (error || !data) throw new ReaderUnavailableError();

  try {
    return JSON.parse(await data.text()) as StoredManifest;
  } catch {
    // A stored manifest that is not valid JSON is a corrupt artefact, not a refusal.
    throw new ReaderUnavailableError();
  }
}

// Only a 'published' publication is servable, except for an entitled manifest, which may also be
// 'superseded': authorize_reader_session has already decided it is the caller's readable
// publication (reader_publication_for_edition rule step 2 keeps an edition's latest superseded one
// readable when no published pointer remains). Sample manifests and resources stay published-only.
async function loadServablePublication(
  admin: ReturnType<typeof createAdminClient>,
  publicationId: string,
  allowSuperseded = false,
): Promise<{ manifestKey: string; positionsJson: unknown }> {
  const { data, error } = await admin
    .from("ebook_publications")
    .select("id, manifest_key, positions_json, status")
    .eq("id", publicationId)
    .maybeSingle();

  // Ruling CF, and this is the one split that matters. A query error is an infrastructure fault
  // and is resource-independent - it happens whichever publication was asked for - so it is safe
  // to surface as 502.
  if (error) throw new ReaderUnavailableError();

  // These two stay 404, deliberately. "No such row" and "not servable" are exactly the existence
  // facts the whole non-disclosure model hides; turning either into a distinguishable status would
  // re-open the Critical this task closed, by letting a caller confirm a publication exists.
  if (!data || !(data.status === "published" || (allowSuperseded && data.status === "superseded"))) {
    throw new ReaderAccessDeniedError();
  }
  return { manifestKey: data.manifest_key, positionsJson: data.positions_json };
}

function entitledHref(publicationId: string, href: string): string {
  return toReaderResourceHref(publicationId, href);
}

function projectPositions(
  publicationId: string,
  value: unknown,
  readingOrderHrefs: ReadonlySet<string>,
): ReaderLocator[] | null {
  if (!Array.isArray(value)) return null;
  try {
    return value.map((entry) => {
      if (typeof entry !== "object" || entry === null) throw new Error("Invalid position");
      const stored = entry as Record<string, unknown>;
      if (typeof stored.href !== "string" || !readingOrderHrefs.has(stored.href)) {
        throw new Error("Position is outside the reading order");
      }
      const locator = parseBoundedReaderLocator({
        ...stored,
        href: toReaderResourceHref(publicationId, stored.href),
      });
      if (
        locator.text?.highlight !== undefined &&
        Array.from(locator.text.highlight).length > 160
      ) {
        throw new Error("Position quote is too long");
      }
      return locator;
    });
  } catch {
    return null;
  }
}

function sampleHref(publicationId: string, href: string): string {
  const encoded = href.split("/").map(encodeURIComponent).join("/");
  return `/api/samples/${publicationId}/resources/${encoded}`;
}

// TOC hrefs routinely carry a fragment (`chapter1.xhtml#sec1`) pointing at a location *within* a
// document rather than at a different resource: lib/epub/parse.ts resolves the path portion and
// deliberately re-attaches the fragment for display. Membership therefore has to be tested
// against the path alone - comparing the whole string would drop every fragment-bearing entry as
// "not a sample", which for a real EPUB nav is most of them.
function splitTocFragment(href: string): { path: string; fragment: string } {
  const hash = href.indexOf("#");
  return hash === -1
    ? { path: href, fragment: "" }
    : { path: href.slice(0, hash), fragment: href.slice(hash) };
}

// Filters the stored table of contents down to the servable set.
//
// Including a *filtered* toc discloses nothing: every href it names is already in readingOrder or
// resources, so there is nothing to subtract one from the other to obtain. The diff attack needs
// an unfiltered toc beside a filtered reading order, which this is not.
//
// The one genuine leak vector is ancestor retention. Keeping a parent node whose own target is
// not servable, purely to preserve hierarchy, would publish a paid chapter's `title` - and titles
// appear nowhere else in the sample manifest, so that would be new information rather than a
// restatement. A non-servable node is therefore dropped outright and its servable descendants are
// promoted into its place: navigation survives, paid titles do not.

// The entitled toc is deliberately NOT filtered - an entitled reader may see every chapter - but
// its hrefs still have to be rewritten, for exactly the reason readingOrder's are. A stored toc
// href is a bare in-publication path (`OEBPS/text/chapter1.xhtml`), so a reader engine resolves it
// against the manifest URL and requests `/api/reader/publications/{id}/OEBPS/text/chapter1.xhtml`,
// which no route serves. Only the hrefs change; titles, order, and nesting are untouched.
function rewriteTocHrefs(nodes: TocEntry[], publicationId: string): TocEntry[] {
  return nodes.map((node) => {
    const { path, fragment } = splitTocFragment(node.href);
    return {
      title: node.title,
      // A fragment-only entry ("#top", common in EPUB nav) names no document of its own, so it is
      // left as written rather than rewritten into a resource URL with an empty path.
      href: path === "" ? node.href : entitledHref(publicationId, path) + fragment,
      children: rewriteTocHrefs(node.children, publicationId),
    };
  });
}

function filterTocToServable(
  nodes: TocEntry[],
  servable: ReadonlySet<string>,
  publicationId: string,
): TocEntry[] {
  return nodes.flatMap((node) => {
    const children = filterTocToServable(node.children, servable, publicationId);
    const { path, fragment } = splitTocFragment(node.href);
    if (!servable.has(path)) return children;
    return [{ title: node.title, href: sampleHref(publicationId, path) + fragment, children }];
  });
}

// The entitled manifest: the full reading order and table of contents, with every link pointing
// at this application's authenticated Route Handlers rather than a Supabase object URL.
export async function resolveEntitledManifest(publicationId: string): Promise<ReaderManifest> {
  const admin = createAdminClient();
  const { manifestKey, positionsJson } = await loadServablePublication(admin, publicationId, true);
  const stored = await loadStoredManifest(admin, manifestKey);

  const readingOrderHrefs = new Set(stored.readingOrder.map((item) => item.href));

  const { data: resourceRows, error: resourcesError } = await admin
    .from("ebook_resources")
    .select("href, media_type")
    .eq("publication_id", publicationId)
    .order("href", { ascending: true });

  // Checked rather than discarded: swallowing this yields `resources: []`, which is not an empty
  // publication but a manifest missing every stylesheet and image, handed to the reader as though
  // it were complete. Ruling CF: this is reached only after the caller's own entitlement is
  // confirmed, so a query fault is an outage rather than a refusal and surfaces as 502.
  if (resourcesError) throw new ReaderUnavailableError();

  return {
    "@context": READIUM_CONTEXT,
    metadata: stored.metadata,
    readingOrder: stored.readingOrder.map((item) => ({
      href: entitledHref(publicationId, item.href),
      type: item.mediaType,
    })),
    resources: (resourceRows ?? [])
      .filter((row: { href: string }) => !readingOrderHrefs.has(row.href))
      .map((row: { href: string; media_type: string }) => ({
        href: entitledHref(publicationId, row.href),
        type: row.media_type,
      })),
    toc: rewriteTocHrefs(stored.toc, publicationId),
    infinityBooks: {
      positions: projectPositions(publicationId, positionsJson, readingOrderHrefs),
    },
  };
}

// The sample manifest, built *from the allowlist* rather than by filtering the entitled manifest.
// Two properties this shape guarantees, both of which the brief asked be reasoned rather than
// guessed:
//
//  - It never mentions a non-sample href in any field, so it cannot be diffed against anything
//    to enumerate paid content. There are no placeholders, no gap markers, and no counts that
//    would reveal how many paid resources exist.
//  - It carries a `toc`, filtered to the same servable set as the readingOrder. That is safe, and
//    the filtering is what makes it so: every href the toc names is already disclosed by
//    readingOrder or resources, so there is nothing to obtain by subtracting one from the other.
//    The diff attack needs an *unfiltered* toc beside a filtered reading order, which this is not.
//    Non-servable nodes are dropped outright and their servable descendants promoted, so no paid
//    title is ever named - see filterTocToServable, where that reasoning lives in full.
//
// The servable set is the intersection of the allowlist with the resources whose own row says
// access_class = 'sample', for the same reason resolveSampleResource checks both.
export async function resolveSampleManifest(publicationId: string): Promise<ReaderManifest> {
  const admin = createAdminClient();
  const { manifestKey } = await loadServablePublication(admin, publicationId);

  const { data: sample, error: sampleError } = await admin
    .from("book_samples")
    .select("allowed_hrefs")
    .eq("publication_id", publicationId)
    .maybeSingle();

  if (sampleError || !sample) throw new ReaderAccessDeniedError();

  const allowed = new Set(Array.isArray(sample.allowed_hrefs) ? (sample.allowed_hrefs as string[]) : []);
  if (allowed.size === 0) throw new ReaderAccessDeniedError();

  const { data: sampleRows, error: sampleRowsError } = await admin
    .from("ebook_resources")
    .select("href, media_type, access_class")
    .eq("publication_id", publicationId)
    .eq("access_class", "sample");

  // Ruling CF, and this site failed *open* rather than closed: the error was not destructured at
  // all, so a failed query left `mediaTypeByHref` empty, drained both loops below, and returned a
  // structurally valid 200 with an empty readingOrder and resources. An anonymous visitor could
  // not tell "this book has no sample" from "the database is down". The guards above cannot catch
  // it - they check the book_samples row and an empty allowlist, both before this query runs.
  if (sampleRowsError) throw new ReaderUnavailableError();

  const mediaTypeByHref = new Map<string, string>();
  for (const row of (sampleRows ?? []) as { href: string; media_type: string }[]) {
    if (allowed.has(row.href)) mediaTypeByHref.set(row.href, row.media_type);
  }

  const stored = await loadStoredManifest(admin, manifestKey);
  const readingOrderHrefs = new Set<string>();
  const readingOrder: ManifestLink[] = [];

  for (const item of stored.readingOrder) {
    if (!mediaTypeByHref.has(item.href)) continue;
    readingOrderHrefs.add(item.href);
    readingOrder.push({ href: sampleHref(publicationId, item.href), type: item.mediaType });
  }

  // The assets a sample document actually needs to render (its CSS, images, and fonts - Ruling
  // AW's transitive closure put them in the allowlist), listed so the reader can fetch them.
  const resources: ManifestLink[] = [];
  // Ruling CH: code-point order, not localeCompare. These are machine-consumed hrefs, and
  // localeCompare with no explicit locale uses the runtime's default - so ordering could differ
  // between a developer machine and a CI runner with another OS, ICU build, or LANG. Manifest
  // order is part of the response body, which makes that a production determinism gap rather than
  // only a test one. Reserve localeCompare for text shown to humans.
  for (const [href, mediaType] of [...mediaTypeByHref].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (readingOrderHrefs.has(href)) continue;
    resources.push({ href: sampleHref(publicationId, href), type: mediaType });
  }

  return {
    "@context": READIUM_CONTEXT,
    metadata: stored.metadata,
    readingOrder,
    resources,
    toc: filterTocToServable(stored.toc, new Set(mediaTypeByHref.keys()), publicationId),
  };
}

// Which publication a book's public sample is served from.
//
// This lives here rather than in lib/data/catalog.ts because it needs the service-role client:
// ebook_publications and book_samples are admin-only under RLS and the caller is an anonymous
// visitor - the same situation resolveSampleResource is already in.
//
// Its allowlist check agrees with the condition catalog_book_cards.has_sample reports - a
// non-empty allowed_hrefs - not with resolveSampleManifest's stricter one, which also requires
// each href's own ebook_resources row to say access_class = 'sample'. That is deliberate: this
// function only gates whether the page renders, never what gets served, and duplicating the
// stricter check here would mean two places encoding the same trust boundary. The known
// consequence is a data-integrity anomaly the pipeline should not produce: a publication whose
// allowlist hrefs all resolve to non-sample (or no) resources would pass this check and then
// render a reader with an empty manifest, rather than a 404. That gap is not defended against
// here on purpose - see resolveSampleManifest for the check that actually decides servability.
//
// Returns null for every refusal reason rather than throwing, so the page turns all of them into one
// notFound(): a draft book, a rolled-back publication, and a book that never existed are
// indistinguishable from outside, matching the rest of this module.
//
// The public catalog DTOs carry no publication ids by contract (lib/catalog/public-types.ts), and
// this does not change that: the id reaches the browser only inside the sample manifest URL, exactly
// as it already does for an entitled reader.
export async function resolveSamplePublicationId(editionId: string): Promise<string | null> {
  const admin = createAdminClient();

  // The sample belongs to ONE edition: its own live publication, never another language's.
  const { data: edition, error: editionError } = await admin
    .from("editions")
    .select("active_publication_id, status, books!inner ( status )")
    .eq("id", editionId)
    .maybeSingle();

  const book = Array.isArray(edition?.books) ? edition?.books[0] : edition?.books;
  if (editionError || !edition || edition.status !== "published" || book?.status !== "published" || !edition.active_publication_id) {
    return null;
  }

  const { data: publication, error: publicationError } = await admin
    .from("ebook_publications")
    .select("id, status")
    .eq("id", edition.active_publication_id)
    .maybeSingle();

  if (publicationError || !publication || publication.status !== "published") return null;

  // The same allowlist condition catalog_book_cards.has_sample reports, so the book page's sample
  // link and this page agree about which books have one.
  const { data: sample, error: sampleError } = await admin
    .from("book_samples")
    .select("allowed_hrefs")
    .eq("publication_id", publication.id)
    .maybeSingle();

  if (sampleError || !sample) return null;
  const allowed = Array.isArray(sample.allowed_hrefs) ? sample.allowed_hrefs : [];
  return allowed.length > 0 ? publication.id : null;
}
