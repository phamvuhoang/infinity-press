// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireReaderRequestContext } from "@/lib/reader/request-context";
import { createClient } from "@/lib/supabase/server";
import { POST } from "./route";

vi.mock("@/lib/reader/request-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/request-context")>("@/lib/reader/request-context");
  return { ...actual, requireReaderRequestContext: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const publicationId = "c0000000-0000-4000-8000-000000000001";
const foreignPublicationId = "c0000000-0000-4000-8000-000000000002";
const context = {
  sessionId: "e0000000-0000-4000-8000-000000000001",
  profileId: "10000000-0000-4000-8000-000000000001",
  publicationId,
  publicationVersion: 1,
};
const locator = {
  href: `/api/reader/publications/${publicationId}/resources/OEBPS/text/chapter.xhtml`,
  progression: 0.2,
  totalProgression: 0.1,
  locations: { position: 1 },
};

function request(value: unknown) {
  return new NextRequest(`http://localhost/api/reader/publications/${publicationId}/annotations`, {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "x-request-id": "req-real-dal" },
  });
}

const routeContext = { params: Promise.resolve({ publicationId }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireReaderRequestContext).mockResolvedValue(context);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("annotation route with the real annotation DAL", () => {
  it("maps a structurally valid foreign protected href to a private 400", async () => {
    const rpc = vi.fn();
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    const response = await POST(
      request({
        kind: "bookmark",
        locator: {
          ...locator,
          href: `/api/reader/publications/${foreignPublicationId}/resources/OEBPS/text/chapter.xhtml`,
        },
        label: "Chapter",
      }),
      routeContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request." });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps a malformed protected href returned by the annotation RPC to a private 502", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ index_available: true, is_member: true }], error: null })
      .mockResolvedValueOnce({
        data: [
          {
            id: "d0000000-0000-4000-8000-000000000001",
            profile_id: context.profileId,
            publication_id: publicationId,
            kind: "bookmark",
            locator_json: {
              ...locator,
              href: `/api/reader/publications/${foreignPublicationId}/resources/OEBPS/text/chapter.xhtml`,
            },
            selected_text: null,
            color: null,
            note_text: null,
            label: "Chapter",
            created_at: "2026-09-20T00:00:00.000Z",
            updated_at: "2026-09-20T00:00:00.000Z",
          },
        ],
        error: null,
      });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    const response = await POST(
      request({ kind: "bookmark", locator, label: "Chapter" }),
      routeContext,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Reader request failed.", requestId: "req-real-dal" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
