// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import { requireAdmin } from "@/lib/auth/admin";
import { PreviewResourceNotFoundError, resolvePreviewResourceStorageKey } from "@/lib/data/publications";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/publications", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/publications")>("@/lib/data/publications");
  return { ...actual, resolvePreviewResourceStorageKey: vi.fn() };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const publicationId = "b0000000-0000-0000-0000-000000000001";

function context(hrefSegments: string[]) {
  return { params: Promise.resolve({ publicationId, href: hrefSegments }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/publications/[publicationId]/resources/[...href]", () => {
  // Ruling AM's ordering, pinned exactly like lib/data/admin.test.ts pins getAdminSummary: an
  // unauthenticated (or non-admin) caller streaming paid derived content is the failure this
  // route exists to prevent, so the privileged client must never even be constructed for a
  // denied request.
  it("never constructs the service-role client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(GET(new Request("http://localhost/x"), context(["OEBPS", "text", "chapter1.xhtml"]))).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );

    expect(resolvePreviewResourceStorageKey).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("never constructs the service-role client when the resource does not belong to the publication", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof requireAdmin>>);
    vi.mocked(resolvePreviewResourceStorageKey).mockRejectedValue(new PreviewResourceNotFoundError());

    const response = await GET(new Request("http://localhost/x"), context(["not", "a", "real", "resource.xhtml"]));

    expect(response.status).toBe(404);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("joins catch-all href segments back into one path and never accepts a caller-supplied storage key", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof requireAdmin>>);
    vi.mocked(resolvePreviewResourceStorageKey).mockResolvedValue({
      storageKey: "resolved/only/from/ebook_resources.xhtml",
      mediaType: "application/xhtml+xml",
    });
    const download = vi.fn().mockResolvedValue({ data: new Blob(["<html></html>"]), error: null });
    vi.mocked(createAdminClient).mockReturnValue({
      storage: { from: vi.fn(() => ({ download })) },
    } as unknown as ReturnType<typeof createAdminClient>);

    const response = await GET(new Request("http://localhost/x"), context(["OEBPS", "text", "chapter1.xhtml"]));

    expect(resolvePreviewResourceStorageKey).toHaveBeenCalledWith(publicationId, "OEBPS/text/chapter1.xhtml");
    // The handler passes through exactly what resolvePreviewResourceStorageKey resolved - never a
    // path built from the request's own href segments.
    expect(download).toHaveBeenCalledWith("resolved/only/from/ebook_resources.xhtml");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xhtml+xml");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("returns 502 without exposing storage details when the download fails", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof requireAdmin>>);
    vi.mocked(resolvePreviewResourceStorageKey).mockResolvedValue({
      storageKey: "k1",
      mediaType: "application/xhtml+xml",
    });
    vi.mocked(createAdminClient).mockReturnValue({
      storage: { from: vi.fn(() => ({ download: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) })) },
    } as unknown as ReturnType<typeof createAdminClient>);

    const response = await GET(new Request("http://localhost/x"), context(["chapter1.xhtml"]));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).not.toContain("boom");
  });
});
