// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import { getSessionUser } from "@/lib/auth/session";
import { authorizeReaderSession, ReaderAccessDeniedError, ReaderUnavailableError, resolveEntitledManifest } from "@/lib/reader/session";

vi.mock("@/lib/reader/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/session")>("@/lib/reader/session");
  return { ...actual, authorizeReaderSession: vi.fn(), resolveEntitledManifest: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));

const publicationId = "c0000000-0000-0000-0000-000000000001";

function request(headers: Record<string, string> = { "x-reader-session": "session-1" }) {
  return new NextRequest("http://localhost/x", { headers });
}

function context() {
  return { params: Promise.resolve({ publicationId }) };
}

beforeEach(() => {
  // Ruling CG: resets implementations and return values, not only call records.
  vi.resetAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue({ id: "auth-user-1" } as unknown as Awaited<
    ReturnType<typeof getSessionUser>
  >);
});

// This handler had no test file of its own before S4, which is exactly why the TOC drawer's `toc`
// field going missing from its response would not have failed anything here.
describe("GET /api/reader/publications/[publicationId]/manifest", () => {
  it("returns 401 for an anonymous caller without authorizing or reading anything", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    expect(authorizeReaderSession).not.toHaveBeenCalled();
    expect(resolveEntitledManifest).not.toHaveBeenCalled();
  });

  // The whole point of this case is to be indistinguishable from the ReaderAccessDeniedError 404
  // below - a missing session id must never be an existence oracle for "no such publication" or
  // "you have no entitlement". Asserting only the status would let a regression give this path its
  // own distinguishing body and still pass.
  it("returns 404 when no reader session is presented at all, with the single body", async () => {
    const response = await GET(new NextRequest("http://localhost/x"), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(authorizeReaderSession).not.toHaveBeenCalled();
  });

  it("returns 404 for an authorization refusal, with the single body", async () => {
    vi.mocked(authorizeReaderSession).mockRejectedValue(new ReaderAccessDeniedError());

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(resolveEntitledManifest).not.toHaveBeenCalled();
  });

  // The branch after both instanceof checks: an error the handler does not recognize must
  // propagate rather than being silently absorbed into a 404 or 502, which would make an
  // unexpected bug look like a plausible, ordinary refusal.
  it("propagates an error it does not recognize instead of reporting a refusal or an outage", async () => {
    vi.mocked(authorizeReaderSession).mockResolvedValue({ profileId: "p1", publicationId, publicationVersion: 1 });
    vi.mocked(resolveEntitledManifest).mockRejectedValue(new Error("boom"));

    await expect(GET(request(), context())).rejects.toThrow("boom");
  });

  it("returns 502, not 404, when the resolver reports an outage", async () => {
    vi.mocked(authorizeReaderSession).mockResolvedValue({ profileId: "p1", publicationId, publicationVersion: 1 });
    vi.mocked(resolveEntitledManifest).mockRejectedValue(new ReaderUnavailableError());

    const response = await GET(request(), context());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Failed to load resource." });
  });

  it("returns the manifest with the expected headers and a toc", async () => {
    vi.mocked(authorizeReaderSession).mockResolvedValue({ profileId: "p1", publicationId, publicationVersion: 1 });
    vi.mocked(resolveEntitledManifest).mockResolvedValue({
      "@context": "https://readium.org/webpub-manifest/context.jsonld",
      metadata: { title: "A Book", language: "en", identifier: "urn:x", authors: [] },
      readingOrder: [],
      resources: [],
      toc: [
        {
          title: "Chapter 1",
          href: `/api/reader/publications/${publicationId}/resources/OEBPS/text/chapter1.xhtml`,
          children: [],
        },
      ],
      infinityBooks: {
        positions: [
          {
            href: `/api/reader/publications/${publicationId}/resources/OEBPS/text/chapter1.xhtml`,
            progression: 0,
            totalProgression: 0,
            locations: { position: 1 },
          },
        ],
      },
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/webpub+json");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await response.json();
    expect(body.toc).toHaveLength(1);
    expect(body.infinityBooks.positions).toHaveLength(1);
  });
});
