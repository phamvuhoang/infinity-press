// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import { getSessionUser } from "@/lib/auth/session";
import { ReaderAccessDeniedError, resolveSampleResource } from "@/lib/reader/session";
import { createAdminClient } from "@/lib/supabase/admin";

// normalizeResourceHref and ReaderAccessDeniedError stay real: the traversal rejection is part of
// what this route is being tested for, so mocking it away would test nothing.
vi.mock("@/lib/reader/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/session")>("@/lib/reader/session");
  return { ...actual, resolveSampleResource: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const publicationId = "c0000000-0000-0000-0000-000000000001";

function context(hrefSegments: string[]) {
  return { params: Promise.resolve({ publicationId, href: hrefSegments }) };
}

function downloadingClient(download: ReturnType<typeof vi.fn>) {
  return { storage: { from: vi.fn(() => ({ download })) } } as unknown as ReturnType<typeof createAdminClient>;
}

// An admin client that answers the resource lookup according to the href being filtered on, so a
// test can drive the real resolveSampleResource down two different refusal branches in one
// fixture. `chapter9` is in the allowlist but its row is `paid`; `nope.xhtml` has no row and is
// not allowlisted.
function hrefAwareClient() {
  const resourcesByHref: Record<string, unknown> = {
    "OEBPS/text/chapter9.xhtml": {
      storage_key: "ed/asset/OEBPS/text/chapter9.xhtml",
      media_type: "application/xhtml+xml",
      access_class: "paid",
    },
  };

  const from = vi.fn((table: string) => {
    let href: string | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (field: string, value: unknown) => {
        if (field === "href") href = value as string;
        return builder;
      },
      order: () => builder,
      maybeSingle: () => {
        if (table === "ebook_publications") {
          return Promise.resolve({
            data: { id: publicationId, manifest_key: "ed/asset/manifest.json", status: "published" },
            error: null,
          });
        }
        if (table === "book_samples") {
          return Promise.resolve({
            data: { allowed_hrefs: ["OEBPS/text/chapter1.xhtml", "OEBPS/text/chapter9.xhtml"] },
            error: null,
          });
        }
        return Promise.resolve({ data: href ? (resourcesByHref[href] ?? null) : null, error: null });
      },
    };
    return builder;
  });

  return {
    from,
    storage: { from: vi.fn(() => ({ download: vi.fn() })) },
  } as unknown as ReturnType<typeof createAdminClient>;
}

beforeEach(() => {
  // Ruling CG. This file is the one the fragility was found in: the equality test installs the
  // *real* resolver via importActual, and clearAllMocks would leave it (plus its admin fixture)
  // in place for every later test. Benign only by accident today; resetAllMocks closes it.
  vi.resetAllMocks();
});

describe("GET /api/samples/[publicationId]/resources/[...href]", () => {
  // Ruling AR: no user gate of any kind. An anonymous visitor is the expected caller, so the
  // route must never consult the session - if someone later adds a gate here, public samples
  // break silently for everyone who is not signed in, and this assertion is what catches it.
  it("serves an anonymous caller and never consults the session", async () => {
    vi.mocked(resolveSampleResource).mockResolvedValue({
      storageKey: "ed/asset/OEBPS/text/chapter1.xhtml",
      mediaType: "application/xhtml+xml",
    });
    const download = vi.fn().mockResolvedValue({ data: new Blob(["<html></html>"]), error: null });
    vi.mocked(createAdminClient).mockReturnValue(downloadingClient(download));

    const response = await GET(new Request("http://localhost/x"), context(["OEBPS", "text", "chapter1.xhtml"]));

    expect(response.status).toBe(200);
    expect(getSessionUser).not.toHaveBeenCalled();
    // The key reaching storage is the one the resource row carried, never a path built from the
    // request's own segments.
    expect(download).toHaveBeenCalledWith("ed/asset/OEBPS/text/chapter1.xhtml");
    expect(response.headers.get("Content-Type")).toBe("application/xhtml+xml");
    // Pinned exactly, for the same reason as the reader route: gutting this value used to leave
    // the whole suite green. Samples are served to anonymous callers, so `no-store` here is the
    // public variant rather than `private, no-store`.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
    );
  });

  // The negative test Ruling AR names explicitly.
  it("refuses a paid href with 404 and never reads storage", async () => {
    vi.mocked(resolveSampleResource).mockRejectedValue(new ReaderAccessDeniedError());

    const response = await GET(new Request("http://localhost/x"), context(["OEBPS", "text", "chapter9.xhtml"]));

    expect(response.status).toBe(404);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // A paid href and an href that was never a resource must be indistinguishable - same status,
  // same body, same headers. Anything else is an existence oracle for paid content.
  //
  // Fix round 1, item 5: this used to set ONE mock rejection and call the route twice with
  // different href strings, so the paid-vs-nonexistent distinction lived entirely inside the
  // mocked-away resolver and the two hrefs were decoration - one code path compared against
  // itself. The real resolver runs here instead, against an href-aware fixture, so the two
  // responses are produced by genuinely different branches: `chapter9` is allowlisted but its row
  // is `paid` (refused on access_class, after both lookups), while `nope.xhtml` is not in the
  // allowlist at all (refused earlier, before the resource is ever looked up).
  it("returns an identical response for a paid href and a nonexistent one", async () => {
    const actual = await vi.importActual<typeof import("@/lib/reader/session")>("@/lib/reader/session");
    vi.mocked(resolveSampleResource).mockImplementation(actual.resolveSampleResource);
    vi.mocked(createAdminClient).mockReturnValue(hrefAwareClient());

    const paid = await GET(new Request("http://localhost/x"), context(["OEBPS", "text", "chapter9.xhtml"]));
    const missing = await GET(new Request("http://localhost/x"), context(["OEBPS", "text", "nope.xhtml"]));

    expect(paid.status).toBe(missing.status);
    expect(await paid.json()).toEqual(await missing.json());
    // Byte-identical, not merely same-status: a branch-specific Cache-Control or any other
    // differing header would reintroduce the oracle the shared body was meant to close.
    expect([...paid.headers.entries()].sort()).toEqual([...missing.headers.entries()].sort());
  });

  it("rejects a traversal href before the resolver or the privileged client is reached", async () => {
    const response = await GET(new Request("http://localhost/x"), context(["OEBPS", "..", "..", "etc", "passwd"]));

    expect(response.status).toBe(404);
    expect(resolveSampleResource).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("returns a generic 502 that does not echo the storage error", async () => {
    vi.mocked(resolveSampleResource).mockResolvedValue({ storageKey: "k1", mediaType: "application/xhtml+xml" });
    vi.mocked(createAdminClient).mockReturnValue(
      downloadingClient(vi.fn().mockResolvedValue({ data: null, error: { message: "bucket exploded" } })),
    );

    const response = await GET(new Request("http://localhost/x"), context(["chapter1.xhtml"]));

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("bucket exploded");
  });
});
