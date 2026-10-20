// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { getSessionUser } from "@/lib/auth/session";
import { createReaderSession, ReaderAccessDeniedError } from "@/lib/reader/session";

vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/reader/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/session")>("@/lib/reader/session");
  return { ...actual, createReaderSession: vi.fn() };
});

const publicationId = "c0000000-0000-0000-0000-000000000001";
const sessionId = "d0000000-0000-0000-0000-000000000001";
const expiresAt = "2026-09-12T10:15:00.000Z";

function request(body: string, url = "http://localhost/api/reader/sessions") {
  return new NextRequest(url, { method: "POST", body });
}

beforeEach(() => {
  // Ruling CG: resetAllMocks clears implementations and return values, not just call records.
  // clearAllMocks alone leaves an implementation installed by one test (notably a real one from
  // importActual) in place for every later test in the file, which fails order-dependently. It
  // must run before the defaults below, or it would wipe them.
  vi.resetAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue({ id: "auth-user-1" } as unknown as Awaited<
    ReturnType<typeof getSessionUser>
  >);
  vi.mocked(createReaderSession).mockResolvedValue({
    sessionId,
    publicationId,
    publicationVersion: 1,
    expiresAt,
  });
});

describe("POST /api/reader/sessions", () => {
  it("returns 401 for an anonymous caller and never mints a session", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    const response = await POST(request(JSON.stringify({ publicationId })));

    expect(response.status).toBe(401);
    expect(createReaderSession).not.toHaveBeenCalled();
  });

  // The cookie is how the reading engine carries the session on its own sub-resource fetches, and
  // every one of these attributes is load-bearing: httpOnly keeps it away from page scripts, the
  // per-publication name stops two open books evicting each other, `path` scopes it to the API,
  // and `expires` comes from the grant so the browser drops it exactly when the server would stop
  // honouring it. None of this was tested before fix round 1.
  it("sets an httpOnly, per-publication, api-scoped cookie that expires with the grant", async () => {
    const response = await POST(request(JSON.stringify({ publicationId })));

    expect(response.status).toBe(201);

    const cookie = response.cookies.get(`reader-session-${publicationId}`);
    expect(cookie?.value).toBe(sessionId);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/api");
    expect(cookie?.expires).toEqual(new Date(expiresAt));
    expect(cookie?.secure).toBe(false);
  });

  it("marks the reader cookie secure when the request itself is HTTPS", async () => {
    const response = await POST(request(JSON.stringify({ publicationId }), "https://books.example/api/reader/sessions"));

    expect(response.cookies.get(`reader-session-${publicationId}`)?.secure).toBe(true);
  });

  it("marks the reader cookie secure behind a forwarded HTTPS terminator", async () => {
    const forwarded = request(JSON.stringify({ publicationId }));
    forwarded.headers.set("x-forwarded-proto", "https");

    const response = await POST(forwarded);

    expect(response.cookies.get(`reader-session-${publicationId}`)?.secure).toBe(true);
  });

  it("returns the grant without any storage key, and marks it uncacheable", async () => {
    const response = await POST(request(JSON.stringify({ publicationId })));

    const body = await response.json();
    // The `toEqual` above already pins the exact body, so a `not.toContain("storage")` alongside
    // it could only fail if this test's own mock changed - it read as coverage while asserting
    // nothing. Removed rather than kept (fix round 2, item 2).
    expect(body).toEqual({ sessionId, publicationId, publicationVersion: 1, expiresAt });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    ["a non-string publicationId", JSON.stringify({ publicationId: 42 })],
    ["a missing publicationId", JSON.stringify({})],
    ["a malformed body", "not json at all"],
  ])("returns 404 for %s without minting a session", async (_case, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(404);
    expect(createReaderSession).not.toHaveBeenCalled();
  });

  // Same 404 as a malformed request: "you are not entitled to this publication" must not be
  // distinguishable from "there is no such publication".
  it("returns 404 when the session cannot be minted", async () => {
    vi.mocked(createReaderSession).mockRejectedValue(new ReaderAccessDeniedError());

    const response = await POST(request(JSON.stringify({ publicationId })));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
  });
});
