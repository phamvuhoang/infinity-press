// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import { getSessionUser } from "@/lib/auth/session";
import { ReaderAccessDeniedError, ReaderUnavailableError, resolveSampleManifest } from "@/lib/reader/session";

vi.mock("@/lib/reader/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/session")>("@/lib/reader/session");
  return { ...actual, resolveSampleManifest: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));

const publicationId = "c0000000-0000-0000-0000-000000000001";

function context() {
  return { params: Promise.resolve({ publicationId }) };
}

beforeEach(() => {
  // Ruling CG: resets implementations, not just call records.
  vi.resetAllMocks();
});

// This route had no test file at all before fix round 2, which is part of why its resolver could
// return an empty manifest on a database fault without anything noticing.
describe("GET /api/samples/[publicationId]/manifest", () => {
  it("serves an anonymous caller and never consults the session (Ruling AR)", async () => {
    vi.mocked(resolveSampleManifest).mockResolvedValue({
      "@context": "https://readium.org/webpub-manifest/context.jsonld",
      metadata: { title: "A Book", language: "en", identifier: "urn:x", authors: [] },
      readingOrder: [],
      resources: [],
      toc: [],
    });

    const response = await GET(new Request("http://localhost/x"), context());

    expect(response.status).toBe(200);
    expect(getSessionUser).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).not.toHaveProperty("infinityBooks");
    expect(JSON.stringify(body)).not.toContain("plain_text");
    expect(JSON.stringify(body)).not.toContain("search_document");
  });

  it("returns 404 for an authorization refusal", async () => {
    vi.mocked(resolveSampleManifest).mockRejectedValue(new ReaderAccessDeniedError());

    const response = await GET(new Request("http://localhost/x"), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
  });

  // Ruling CF. Before this round a failed resources query produced HTTP 200 with an empty sample
  // manifest - failing open, on the public path, indistinguishable from "this book has no sample".
  it("returns 502, not 404 and not an empty 200, when the resolver reports an outage", async () => {
    vi.mocked(resolveSampleManifest).mockRejectedValue(new ReaderUnavailableError());

    const response = await GET(new Request("http://localhost/x"), context());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Failed to load resource." });
  });
});
