// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createReaderAnnotation, listReaderAnnotations, ReaderDataUnavailableError } from "@/lib/data/reader-annotations";
import { ReaderRequestNotFoundError, ReaderRequestUnauthorizedError, requireReaderRequestContext } from "@/lib/reader/request-context";
import { GET, POST } from "./route";

vi.mock("@/lib/reader/request-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/request-context")>("@/lib/reader/request-context");
  return { ...actual, requireReaderRequestContext: vi.fn() };
});
vi.mock("@/lib/data/reader-annotations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/reader-annotations")>("@/lib/data/reader-annotations");
  return { ...actual, createReaderAnnotation: vi.fn(), listReaderAnnotations: vi.fn() };
});

const publicationId = "c0000000-0000-4000-8000-000000000001";
const readerContext = { sessionId: "s1", profileId: "p1", publicationId, publicationVersion: 1 };
const locator = {
  href: `/api/reader/publications/${publicationId}/resources/OEBPS/chapter.xhtml`,
  progression: 0,
  totalProgression: 0,
  locations: { position: 1 },
  text: { highlight: "selected" },
};
const draft = { kind: "highlight" as const, locator, selectedText: "selected", color: "yellow" as const, noteText: null };

function request(method = "GET", body?: string) {
  return new NextRequest(`http://localhost/api/reader/publications/${publicationId}/annotations`, { method, body });
}
const routeContext = () => ({ params: Promise.resolve({ publicationId }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireReaderRequestContext).mockResolvedValue(readerContext);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("publication annotation routes", () => {
  it("returns 401 before a collection read for a missing application session", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestUnauthorizedError());
    const response = await GET(request(), routeContext());
    expect(response.status).toBe(401);
    expect(listReaderAnnotations).not.toHaveBeenCalled();
  });

  it.each(["missing", "expired", "wrong-publication", "foreign", "revoked", "superseded"])(
    "returns the identical private 404 for a %s reader session",
    async () => {
      vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestNotFoundError());
      const response = await GET(request(), routeContext());
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Not found." });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(listReaderAnnotations).not.toHaveBeenCalled();
    },
  );

  it("returns the private annotation collection", async () => {
    vi.mocked(listReaderAnnotations).mockResolvedValue([]);
    const response = await GET(request(), routeContext());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ annotations: [] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(listReaderAnnotations).toHaveBeenCalledExactlyOnceWith(readerContext);
  });

  it("authorizes POST before parsing and rejects malformed authenticated payloads", async () => {
    const response = await POST(request("POST", JSON.stringify({ ...draft, selectedText: "different" })), routeContext());
    expect(response.status).toBe(400);
    expect(requireReaderRequestContext).toHaveBeenCalled();
    expect(createReaderAnnotation).not.toHaveBeenCalled();
  });

  it("returns a private 401 before POST touches the DAL", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestUnauthorizedError());
    const response = await POST(request("POST", JSON.stringify(draft)), routeContext());
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(createReaderAnnotation).not.toHaveBeenCalled();
  });

  it("returns a private opaque 404 before POST touches the DAL", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestNotFoundError());
    const response = await POST(request("POST", JSON.stringify(draft)), routeContext());
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
    expect(createReaderAnnotation).not.toHaveBeenCalled();
  });

  it("creates a validated annotation", async () => {
    const annotation = { ...draft, id: "d0000000-0000-4000-8000-000000000001", publicationId, createdAt: "now", updatedAt: "now" };
    vi.mocked(createReaderAnnotation).mockResolvedValue(annotation);
    const response = await POST(request("POST", JSON.stringify(draft)), routeContext());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ annotation });
  });

  it("returns a generic private 502 with request ID and sanitized logging", async () => {
    vi.mocked(listReaderAnnotations).mockRejectedValue(new ReaderDataUnavailableError("XX000"));
    const response = await GET(
      new NextRequest("http://localhost/x", { headers: { "x-request-id": "req-reader-123" } }),
      routeContext(),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Reader request failed.", requestId: "req-reader-123" });
    expect(response.headers.get("x-request-id")).toBe("req-reader-123");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(console.error).toHaveBeenCalledWith("Reader annotation request failed.", {
      requestId: "req-reader-123",
      code: "XX000",
    });
  });
});
