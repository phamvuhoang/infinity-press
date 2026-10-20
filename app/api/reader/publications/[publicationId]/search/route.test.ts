// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReaderDataUnavailableError } from "@/lib/data/reader-annotations";
import { searchReaderPublication } from "@/lib/data/reader-search";
import { ReaderRequestNotFoundError, ReaderRequestUnauthorizedError, requireReaderRequestContext } from "@/lib/reader/request-context";
import { GET } from "./route";

vi.mock("@/lib/reader/request-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/request-context")>("@/lib/reader/request-context");
  return { ...actual, requireReaderRequestContext: vi.fn() };
});
vi.mock("@/lib/data/reader-search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/reader-search")>("@/lib/data/reader-search");
  return { ...actual, searchReaderPublication: vi.fn() };
});

const publicationId = "c0000000-0000-4000-8000-000000000001";
const readerContext = { sessionId: "s1", profileId: "p1", publicationId, publicationVersion: 1 };
const routeContext = () => ({ params: Promise.resolve({ publicationId }) });
const request = (query = "matching") => new NextRequest(`http://localhost/x?q=${encodeURIComponent(query)}`);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireReaderRequestContext).mockResolvedValue(readerContext);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("publication search route", () => {
  it("returns 401 before search for an anonymous caller", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestUnauthorizedError());
    const response = await GET(request(), routeContext());
    expect(response.status).toBe(401);
    expect(searchReaderPublication).not.toHaveBeenCalled();
  });

  it("returns the opaque 404 for a reader-session refusal", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestNotFoundError());
    const response = await GET(request(), routeContext());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
    expect(searchReaderPublication).not.toHaveBeenCalled();
  });

  it.each(["x", "x".repeat(101)])("rejects an out-of-bounds authenticated query", async (query) => {
    const response = await GET(request(query), routeContext());
    expect(response.status).toBe(400);
    expect(searchReaderPublication).not.toHaveBeenCalled();
  });

  it("returns bounded search results without caching", async () => {
    vi.mocked(searchReaderPublication).mockResolvedValue([]);
    const response = await GET(request("  tiếng Việt  "), routeContext());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(searchReaderPublication).toHaveBeenCalledExactlyOnceWith(readerContext, "tiếng Việt");
  });

  it("does not log the search query when returning a generic 502", async () => {
    vi.mocked(searchReaderPublication).mockRejectedValue(new ReaderDataUnavailableError("XX000"));
    const response = await GET(
      new NextRequest("http://localhost/x?q=private%20words", { headers: { "x-request-id": "req-search-1" } }),
      routeContext(),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Reader request failed.", requestId: "req-search-1" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private words");
    expect(console.error).toHaveBeenCalledWith("Reader search request failed.", {
      requestId: "req-search-1",
      code: "XX000",
    });
  });
});
