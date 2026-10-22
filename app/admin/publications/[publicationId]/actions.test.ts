// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishPublicationAction } from "@/app/admin/publications/[publicationId]/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { computeAlignmentsForBook } from "@/lib/data/alignments";
import { publishPublication, PublicationTransitionRejectedError } from "@/lib/data/publications";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/catalog/revalidate", () => ({ revalidateStorefront: vi.fn() }));
vi.mock("@/lib/data/alignments", () => ({ computeAlignmentsForBook: vi.fn() }));
vi.mock("@/lib/data/publications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/publications")>()),
  publishPublication: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-request-id": "req-publish-1" }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("publishPublicationAction alignment", () => {
  it("aligns the work after a publish", async () => {
    vi.mocked(computeAlignmentsForBook).mockResolvedValue([]);
    await expect(publishPublicationAction("asset-1", "book-1", "pub-1")).resolves.toEqual({ ok: true });
    expect(computeAlignmentsForBook).toHaveBeenCalledExactlyOnceWith("book-1");
  });

  it("still reports the publish when alignment fails, logging the request ID", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(computeAlignmentsForBook).mockRejectedValue(new Error("boom"));
    await expect(publishPublicationAction("asset-1", "book-1", "pub-1")).resolves.toEqual({ ok: true });
    expect(log).toHaveBeenCalledWith(
      "Alignment after a publication change failed.",
      expect.objectContaining({ bookId: "book-1", requestId: "req-publish-1" }),
    );
  });

  it("does not align when the publish is refused", async () => {
    vi.mocked(publishPublication).mockRejectedValue(new PublicationTransitionRejectedError("no"));
    await expect(publishPublicationAction("asset-1", "book-1", "pub-1")).resolves.toEqual({ ok: false, error: "no" });
    expect(computeAlignmentsForBook).not.toHaveBeenCalled();
  });
});
