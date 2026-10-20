// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteReaderAnnotation, ReaderDataDeniedError, ReaderDataUnavailableError, updateReaderAnnotation } from "@/lib/data/reader-annotations";
import { ReaderRequestNotFoundError, ReaderRequestUnauthorizedError, requireReaderRequestContext } from "@/lib/reader/request-context";
import { DELETE, PATCH } from "./route";

vi.mock("@/lib/reader/request-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/request-context")>("@/lib/reader/request-context");
  return { ...actual, requireReaderRequestContext: vi.fn() };
});
vi.mock("@/lib/data/reader-annotations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/reader-annotations")>("@/lib/data/reader-annotations");
  return { ...actual, deleteReaderAnnotation: vi.fn(), updateReaderAnnotation: vi.fn() };
});

const publicationId = "c0000000-0000-4000-8000-000000000001";
const annotationId = "d0000000-0000-4000-8000-000000000001";
const readerContext = { sessionId: "s1", profileId: "p1", publicationId, publicationVersion: 1 };
const routeContext = () => ({ params: Promise.resolve({ annotationId }) });
function request(method: string, body?: string, candidate = publicationId) {
  return new NextRequest(`http://localhost/api/reader/annotations/${annotationId}?publicationId=${candidate}`, { method, body });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireReaderRequestContext).mockResolvedValue(readerContext);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("annotation mutation routes", () => {
  it("returns 401 before PATCH touches the DAL", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestUnauthorizedError());
    const response = await PATCH(request("PATCH", JSON.stringify({ kind: "highlight", color: "green" })), routeContext());
    expect(response.status).toBe(401);
    expect(updateReaderAnnotation).not.toHaveBeenCalled();
  });

  it("uses the candidate publication only to authorize and returns opaque 404 on refusal", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestNotFoundError());
    const response = await PATCH(request("PATCH", "{}", "c0000000-0000-4000-8000-000000000002"), routeContext());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
    expect(updateReaderAnnotation).not.toHaveBeenCalled();
  });

  it("rejects an immutable-field PATCH after authorization", async () => {
    const response = await PATCH(
      request("PATCH", JSON.stringify({ kind: "highlight", color: "green", locator: {} })),
      routeContext(),
    );
    expect(response.status).toBe(400);
    expect(updateReaderAnnotation).not.toHaveBeenCalled();
  });

  it("returns the updated annotation", async () => {
    const annotation = { id: annotationId, publicationId } as never;
    vi.mocked(updateReaderAnnotation).mockResolvedValue(annotation);
    const response = await PATCH(request("PATCH", JSON.stringify({ kind: "highlight", color: "green" })), routeContext());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ annotation });
    expect(updateReaderAnnotation).toHaveBeenCalledExactlyOnceWith(readerContext, annotationId, {
      kind: "highlight",
      color: "green",
    });
  });

  it("deletes an annotation with no response body", async () => {
    const response = await DELETE(request("DELETE"), routeContext());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(deleteReaderAnnotation).toHaveBeenCalledExactlyOnceWith(readerContext, annotationId);
  });

  it("returns a private 401 before DELETE touches the DAL", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestUnauthorizedError());
    const response = await DELETE(request("DELETE"), routeContext());
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(deleteReaderAnnotation).not.toHaveBeenCalled();
  });

  it("returns a private opaque 404 before DELETE touches the DAL", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestNotFoundError());
    const response = await DELETE(request("DELETE"), routeContext());
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
    expect(deleteReaderAnnotation).not.toHaveBeenCalled();
  });

  it("returns the same 404 for a missing or foreign annotation ID", async () => {
    vi.mocked(deleteReaderAnnotation).mockRejectedValue(new ReaderDataDeniedError());
    const response = await DELETE(request("DELETE"), routeContext());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
  });

  it("returns a request-ID-correlated 502 without exposing database text", async () => {
    vi.mocked(updateReaderAnnotation).mockRejectedValue(new ReaderDataUnavailableError("XX000"));
    const response = await PATCH(
      new NextRequest(`http://localhost/x?publicationId=${publicationId}`, {
        method: "PATCH",
        body: JSON.stringify({ kind: "bookmark", label: "Here" }),
        headers: { "x-request-id": "req-mutation-1" },
      }),
      routeContext(),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Reader request failed.", requestId: "req-mutation-1" });
    expect(console.error).toHaveBeenCalledWith("Reader annotation request failed.", {
      requestId: "req-mutation-1",
      code: "XX000",
    });
  });
});
