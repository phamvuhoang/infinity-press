// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveMerchandisingAction } from "@/app/admin/merchandising/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { setMerchandising } from "@/lib/data/merchandising";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/merchandising", () => ({ setMerchandising: vi.fn() }));

const a = "3a1b2c3d-0000-4000-8000-000000000001";

function form(ids: string[]) {
  const data = new FormData();
  for (const id of ids) data.append("bookIds", id);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("saveMerchandisingAction", () => {
  it("denies at the action boundary before validating or writing a slot", async () => {
    const denied = new Error("NEXT_FORBIDDEN");
    vi.mocked(requireAdmin).mockRejectedValue(denied);
    await expect(saveMerchandisingAction("home_shelf", initialAdminFormState, form([a]))).rejects.toBe(denied);
    expect(setMerchandising).not.toHaveBeenCalled();
  });

  it("rejects duplicate shelf entries", async () => {
    const result = await saveMerchandisingAction("home_shelf", initialAdminFormState, form([a, a]));
    expect(result.fieldErrors.bookIds).toBe("Each book can appear once.");
    expect(setMerchandising).not.toHaveBeenCalled();
  });

  it("saves the submitted order", async () => {
    const result = await saveMerchandisingAction("home_shelf", initialAdminFormState, form([a]));
    expect(result.savedAt).not.toBeNull();
    expect(setMerchandising).toHaveBeenCalledWith({ slotKey: "home_shelf", bookIds: [a] });
    expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
  });

  it("treats an empty featured selection as clearing the slot", async () => {
    await saveMerchandisingAction("home_featured", initialAdminFormState, form([""]));
    expect(setMerchandising).toHaveBeenCalledWith({ slotKey: "home_featured", bookIds: [] });
  });
});
