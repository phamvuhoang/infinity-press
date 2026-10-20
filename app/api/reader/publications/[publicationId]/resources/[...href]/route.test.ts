// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import { getSessionUser } from "@/lib/auth/session";
import {
  authorizeReaderSession,
  ReaderAccessDeniedError,
  ReaderUnavailableError,
  resolveEntitledResource,
} from "@/lib/reader/session";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/reader/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/session")>("@/lib/reader/session");
  return { ...actual, authorizeReaderSession: vi.fn(), resolveEntitledResource: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const publicationId = "c0000000-0000-0000-0000-000000000001";

function request() {
  return new NextRequest("http://localhost/x", { headers: { "x-reader-session": "session-1" } });
}

function context(hrefSegments: string[]) {
  return { params: Promise.resolve({ publicationId, href: hrefSegments }) };
}

function downloadingClient(download: ReturnType<typeof vi.fn>) {
  return { storage: { from: vi.fn(() => ({ download })) } } as unknown as ReturnType<typeof createAdminClient>;
}

beforeEach(() => {
  // Ruling CG: resets implementations and return values, not only call records. Must run before
  // the defaults below.
  vi.resetAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue({ id: "auth-user-1" } as unknown as Awaited<
    ReturnType<typeof getSessionUser>
  >);
});

describe("GET /api/reader/publications/[publicationId]/resources/[...href]", () => {
  // 401 is decided before any lookup, so it is a statement about the caller and never about the
  // publication - an invented publication id produces exactly this same response.
  it("returns 401 for an anonymous caller without authorizing or reading anything", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    const response = await GET(request(), context(["OEBPS", "text", "chapter1.xhtml"]));

    expect(response.status).toBe(401);
    expect(authorizeReaderSession).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // The Ruling AD/AM ordering, third instance: authorize first, construct the privileged client
  // second. Until this test, that ordering was held by nothing but the order of statements -
  // hoisting the download above the gate would typecheck and pass every other suite while making
  // paid content readable by any signed-in user.
  it("never constructs the service-role client when authorization is refused", async () => {
    vi.mocked(authorizeReaderSession).mockRejectedValue(new ReaderAccessDeniedError());

    const response = await GET(request(), context(["OEBPS", "text", "chapter1.xhtml"]));

    expect(response.status).toBe(404);
    expect(resolveEntitledResource).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // Ruling CF: an outage must not be reported as a refusal. Without the handler branch this new
  // error type would escape the catch and become a 500 instead.
  it("returns 502, not 404, when the resolver reports an outage", async () => {
    vi.mocked(authorizeReaderSession).mockResolvedValue({
      profileId: "p1",
      publicationId,
      publicationVersion: 1,
    });
    vi.mocked(resolveEntitledResource).mockRejectedValue(new ReaderUnavailableError());

    const response = await GET(request(), context(["OEBPS", "text", "chapter1.xhtml"]));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Failed to load resource." });
  });

  it("returns 404 when no reader session is presented at all", async () => {
    const response = await GET(new NextRequest("http://localhost/x"), context(["OEBPS", "text", "chapter1.xhtml"]));

    expect(response.status).toBe(404);
    expect(authorizeReaderSession).not.toHaveBeenCalled();
  });

  it("rejects a traversal href before authorizing or reading storage", async () => {
    const response = await GET(request(), context(["OEBPS", "%2e%2e", "secret.xhtml"]));

    expect(response.status).toBe(404);
    expect(authorizeReaderSession).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // An unentitled caller and a nonexistent resource must be indistinguishable.
  it("returns an identical response for an unauthorized publication and a missing resource", async () => {
    vi.mocked(authorizeReaderSession).mockRejectedValue(new ReaderAccessDeniedError());
    const unauthorized = await GET(request(), context(["OEBPS", "text", "chapter1.xhtml"]));

    vi.mocked(authorizeReaderSession).mockResolvedValue({
      profileId: "p1",
      publicationId,
      publicationVersion: 1,
    });
    vi.mocked(resolveEntitledResource).mockRejectedValue(new ReaderAccessDeniedError());
    const missing = await GET(request(), context(["OEBPS", "text", "nope.xhtml"]));

    expect(unauthorized.status).toBe(missing.status);
    expect(await unauthorized.json()).toEqual(await missing.json());
    // Byte-identical, not merely same-status: a branch-specific Cache-Control or any other
    // differing header would reintroduce the oracle the shared body was meant to close.
    expect([...unauthorized.headers.entries()].sort()).toEqual([...missing.headers.entries()].sort());
  });

  it("streams the resolved object and marks it private and uncacheable", async () => {
    vi.mocked(authorizeReaderSession).mockResolvedValue({
      profileId: "p1",
      publicationId,
      publicationVersion: 1,
    });
    vi.mocked(resolveEntitledResource).mockResolvedValue({
      storageKey: "ed/asset/OEBPS/text/chapter1.xhtml",
      mediaType: "application/xhtml+xml",
    });
    const download = vi.fn().mockResolvedValue({ data: new Blob(["<html></html>"]), error: null });
    vi.mocked(createAdminClient).mockReturnValue(downloadingClient(download));

    const response = await GET(request(), context(["OEBPS", "text", "chapter1.xhtml"]));

    expect(response.status).toBe(200);
    expect(resolveEntitledResource).toHaveBeenCalledWith(publicationId, "OEBPS/text/chapter1.xhtml");
    expect(download).toHaveBeenCalledWith("ed/asset/OEBPS/text/chapter1.xhtml");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // Pinned exactly, so changing a security header is a test failure rather than a silent edit.
    // Until this assertion existed, replacing the whole value with a bogus string left the suite
    // green - while the same mutation on the admin route, which HAS an assertion, failed.
    //
    // Read this together with the route's own comment: on the READER path this header is inert.
    // Readium fetches the resource and re-hosts it in a `blob:` frame carrying its own substituted
    // `<meta>` CSP, so the policy the browser enforces there is Readium's, not this one. It is
    // pinned because it still governs any direct navigation to the route, and because a header
    // nobody asserts is one a later change can drop without anyone noticing.
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
    );
  });
});
