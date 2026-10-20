// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { getAdminSummary } from "@/lib/data/admin";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

type CountResult = { count: number | null; error: { message: string } | null };

// Mirrors the PostgREST builder shape getAdminSummary awaits: `select(...)` is
// itself thenable, and one of the five counts narrows it with `.eq(...)`.
function countingClient(result: CountResult = { count: 1, error: null }) {
  const query = () => Object.assign(Promise.resolve(result), { eq: () => Promise.resolve(result) });
  return { from: () => ({ select: query }) } as unknown as ReturnType<typeof createAdminClient>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(
    {} as unknown as Awaited<ReturnType<typeof requireAdmin>>,
  );
  vi.mocked(createAdminClient).mockReturnValue(countingClient());
});

describe("getAdminSummary", () => {
  // Ruling F let this function read through the service-role client, which
  // bypasses RLS entirely, on the strength of requireAdmin() running first.
  // Until this test, that ordering was held by a comment: hoisting
  // createAdminClient() above the gate would typecheck and pass every other
  // suite while making five counts readable by anyone who reached here.
  it("never constructs the service-role client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(getAdminSummary()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("constructs the service-role client once the admin gate allows", async () => {
    await getAdminSummary();

    expect(requireAdmin).toHaveBeenCalled();
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });

  it("counts pending reviews and new questions live", async () => {
    const summary = await getAdminSummary();

    expect(summary.pendingReviewCount).toBe(1);
    expect(summary.newQuestionCount).toBe(1);
  });

  it("fails loud rather than reporting a failed count as zero", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      countingClient({ count: null, error: { message: "permission denied" } }),
    );

    await expect(getAdminSummary()).rejects.toThrow(/permission denied/);
  });
});
