// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { getGrowthReport, ratio } from "@/lib/data/growth";
import { chainResult } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";

function useClient(rpcs: Record<string, { data: unknown; error: unknown }>, localizations: unknown[] = []) {
  const rpc = vi.fn(async (name: string) => rpcs[name] ?? { data: null, error: null });
  const from = vi.fn(() => chainResult({ data: localizations, error: null }));
  vi.mocked(createClient).mockResolvedValue({ rpc, from } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { rpc, from };
}

beforeEach(() => vi.clearAllMocks());

it("formats a ratio only when the denominator is above 0", () => {
  expect(ratio(1, 2)).toBe("50%");
  expect(ratio(0, 3)).toBe("0%");
  expect(ratio(0, 0)).toBeNull();
  expect(ratio(2, 0)).toBeNull();
});

it("gates on requireAdmin, passes the window, and maps rows with titles and retention rates", async () => {
  const { rpc } = useClient(
    {
      admin_growth_funnel: {
        data: [{ book_id: BOOK_ID, open_sample: 4, open_reader: 3, session_completed_readers: 2, journey_completed: 1 }],
        error: null,
      },
      admin_growth_retention: {
        data: [
          { cohort_day: "2026-10-01", activated: 4, returned_d7: 1 },
          { cohort_day: "2026-10-02", activated: 0, returned_d7: 0 },
        ],
        error: null,
      },
      admin_growth_share: { data: [{ shared: 3, opened: 2, continued: 1 }], error: null },
    },
    [
      { book_id: BOOK_ID, locale: "vi", title: "Sách" },
      { book_id: BOOK_ID, locale: "en", title: "Book" },
    ],
  );

  const report = await getGrowthReport(90);

  expect(requireAdmin).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith("admin_growth_funnel", { p_days: 90 });
  expect(rpc).toHaveBeenCalledWith("admin_growth_retention", { p_days: 90 });
  expect(rpc).toHaveBeenCalledWith("admin_growth_share", { p_days: 90 });
  expect(report).toEqual({
    funnel: [{ bookId: BOOK_ID, bookTitle: "Book", openSample: 4, openReader: 3, sessionCompletedReaders: 2, journeyCompleted: 1 }],
    retention: [
      { cohortDay: "2026-10-01", activated: 4, returnedD7: 1, rate: "25%" },
      { cohortDay: "2026-10-02", activated: 0, returnedD7: 0, rate: null },
    ],
    share: { shared: 3, opened: 2, continued: 1 },
  });
});

it("does not query anything when requireAdmin refuses", async () => {
  vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
  const { rpc } = useClient({});
  await expect(getGrowthReport(30)).rejects.toThrow("NEXT_REDIRECT");
  expect(rpc).not.toHaveBeenCalled();
});

it("throws a generic error when a report function fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  useClient({ admin_growth_share: { data: null, error: { code: "42501", message: "not an admin" } } });
  await expect(getGrowthReport(30)).rejects.toThrow("admin_growth_share failed.");
});
