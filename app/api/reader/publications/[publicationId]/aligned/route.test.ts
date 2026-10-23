// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAlignedPassage } from "@/lib/data/reader-aligned";
import { ReaderRequestUnauthorizedError, requireReaderRequestContext } from "@/lib/reader/request-context";
import { GET } from "./route";

vi.mock("@/lib/reader/request-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/request-context")>("@/lib/reader/request-context");
  return { ...actual, requireReaderRequestContext: vi.fn() };
});
vi.mock("@/lib/data/reader-aligned", () => ({ getAlignedPassage: vi.fn() }));

const publicationId = "c0000000-0000-4000-8000-000000000001";
const readerContext = { sessionId: "s1", profileId: "p1", publicationId, publicationVersion: 1 };
const routeContext = () => ({ params: Promise.resolve({ publicationId }) });
const request = (query: string) => new NextRequest(`http://localhost/x?${query}`);
const passage = {
  targetPublicationId: "c0000000-0000-4000-8000-000000000002",
  targetEditionId: "e0000000-0000-4000-8000-000000000002",
  targetLanguageCode: "en",
  targetOrdinal: 4,
  text: "Aligned text",
  confidence: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireReaderRequestContext).mockResolvedValue(readerContext);
});

describe("aligned passage route", () => {
  it("returns 401 before any lookup for an anonymous caller", async () => {
    vi.mocked(requireReaderRequestContext).mockRejectedValue(new ReaderRequestUnauthorizedError());
    const response = await GET(request("ordinal=1"), routeContext());
    expect(response.status).toBe(401);
    expect(getAlignedPassage).not.toHaveBeenCalled();
  });

  it.each(["", "ordinal=-1", "ordinal=x", "href=/elsewhere&progression=0.5", `href=/api/reader/publications/${publicationId}/resources/c1.xhtml&progression=2`])(
    "rejects a missing or invalid place (%s)",
    async (query) => {
      const response = await GET(request(query), routeContext());
      expect(response.status).toBe(400);
      expect(getAlignedPassage).not.toHaveBeenCalled();
    },
  );

  it("returns the RPC payload for an ordinal", async () => {
    vi.mocked(getAlignedPassage).mockResolvedValue(passage);
    const response = await GET(request("ordinal=3"), routeContext());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ passage });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getAlignedPassage).toHaveBeenCalledExactlyOnceWith(readerContext, { ordinal: 3 });
  });

  it("turns the reader URL href into the in-publication href", async () => {
    vi.mocked(getAlignedPassage).mockResolvedValue(null);
    const href = encodeURIComponent(`/api/reader/publications/${publicationId}/resources/text/c1.xhtml`);
    const response = await GET(request(`href=${href}&progression=0.25`), routeContext());
    await expect(response.json()).resolves.toEqual({ passage: null });
    expect(getAlignedPassage).toHaveBeenCalledExactlyOnceWith(readerContext, { href: "text/c1.xhtml", progression: 0.25 });
  });
});
