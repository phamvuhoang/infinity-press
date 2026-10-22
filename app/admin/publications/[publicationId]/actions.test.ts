// @vitest-environment node
import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishPublicationAction, rollbackPublicationAction } from "@/app/admin/publications/[publicationId]/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { computeAlignmentsForBook } from "@/lib/data/alignments";
import { publishPublication, PublicationTransitionRejectedError, rollbackPublication } from "@/lib/data/publications";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/catalog/revalidate", () => ({ revalidateStorefront: vi.fn() }));
vi.mock("@/lib/data/alignments", () => ({ computeAlignmentsForBook: vi.fn() }));
vi.mock("@/lib/data/publications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/publications")>()),
  publishPublication: vi.fn(),
  rollbackPublication: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-request-id": "req-publish-1" }) }));
// Captured, not run: the action must have returned before the alignment work starts.
vi.mock("next/server", () => ({ after: vi.fn() }));

const scheduled = () => vi.mocked(after).mock.calls.map(([task]) => task as () => Promise<void>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("publication actions schedule alignment after the response", () => {
  it("returns from publish before alignment runs, then aligns the work", async () => {
    vi.mocked(computeAlignmentsForBook).mockResolvedValue([]);
    await expect(publishPublicationAction("asset-1", "book-1", "pub-1")).resolves.toEqual({ ok: true });
    expect(computeAlignmentsForBook).not.toHaveBeenCalled();

    expect(scheduled()).toHaveLength(1);
    // The action's own revalidate ran; the scheduled one has not yet.
    expect(revalidateStorefront).toHaveBeenCalledTimes(1);
    await scheduled()[0]();
    expect(computeAlignmentsForBook).toHaveBeenCalledExactlyOnceWith("book-1");
    // Recomputed passages reach the prerendered home page.
    expect(revalidateStorefront).toHaveBeenCalledTimes(2);
  });

  it("keeps the publish result when the scheduled alignment fails, logging the request ID", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(computeAlignmentsForBook).mockRejectedValue(new Error("boom"));
    const result = await publishPublicationAction("asset-1", "book-1", "pub-1");
    expect(revalidateStorefront).toHaveBeenCalledTimes(1);
    await expect(scheduled()[0]()).resolves.toBeUndefined();
    expect(revalidateStorefront).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
    expect(log).toHaveBeenCalledWith(
      "Alignment after a publication change failed.",
      expect.objectContaining({ bookId: "book-1", requestId: "req-publish-1" }),
    );
  });

  it("schedules alignment after a rollback too", async () => {
    vi.mocked(rollbackPublication).mockResolvedValue(undefined);
    await expect(rollbackPublicationAction("asset-1", "asset-0", "book-1", "pub-0")).resolves.toEqual({ ok: true });
    expect(scheduled()).toHaveLength(1);
  });

  it("schedules nothing when the publish is refused", async () => {
    vi.mocked(publishPublication).mockRejectedValue(new PublicationTransitionRejectedError("no"));
    await expect(publishPublicationAction("asset-1", "book-1", "pub-1")).resolves.toEqual({ ok: false, error: "no" });
    expect(after).not.toHaveBeenCalled();
  });
});
