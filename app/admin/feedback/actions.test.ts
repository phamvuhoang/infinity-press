// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveFeedbackAction } from "@/app/admin/feedback/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { resolveEditionFeedback } from "@/lib/data/edition-feedback";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/edition-feedback", () => ({ resolveEditionFeedback: vi.fn() }));

const id = "6a1b2c3d-0000-4000-8000-000000000001";
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("resolveFeedbackAction", () => {
  it("denies before touching anything", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(resolveFeedbackAction(id, initialAdminFormState, form({ status: "resolved" }))).rejects.toThrow("NEXT_FORBIDDEN");
    expect(resolveEditionFeedback).not.toHaveBeenCalled();
  });

  it("records the triage with its note and refreshes the inbox", async () => {
    const state = await resolveFeedbackAction(id, initialAdminFormState, form({ status: "resolved", note: " Fixed in v2 " }));
    expect(resolveEditionFeedback).toHaveBeenCalledWith(id, "resolved", "Fixed in v2");
    expect(state.savedAt).not.toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith("/admin/feedback");
  });

  it("refuses an unknown status and a malformed id", async () => {
    expect((await resolveFeedbackAction(id, initialAdminFormState, form({ status: "deleted" }))).savedAt).toBeNull();
    expect((await resolveFeedbackAction("nope", initialAdminFormState, form({ status: "resolved" }))).formError).toBeTruthy();
    expect(resolveEditionFeedback).not.toHaveBeenCalled();
  });
});
