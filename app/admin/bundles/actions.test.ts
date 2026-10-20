// @vitest-environment node
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleAction } from "@/app/admin/bundles/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { createBundle, DuplicateBundleSlugError } from "@/lib/data/bundles";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/data/bundles", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/bundles")>();
  return { ...original, createBundle: vi.fn() };
});

const bundleId = "8a1b2c3d-0000-4000-8000-000000000001";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const valid = (overrides: Record<string, string> = {}) =>
  form({ locale: "vi", slug: "bo-khoi-dau", title: "Bộ khởi đầu", ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("createBundleAction", () => {
  it("gates on requireAdmin for the page it is posted from, before touching the data layer", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(createBundleAction(initialAdminFormState, valid())).rejects.toThrow("NEXT_FORBIDDEN");

    expect(createBundle).not.toHaveBeenCalled();
  });

  it("names the new-bundle page as the sign-in destination", async () => {
    vi.mocked(createBundle).mockResolvedValue({ bundleId });

    await expect(createBundleAction(initialAdminFormState, valid())).rejects.toThrow("NEXT_REDIRECT");

    expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/bundles/new" });
  });

  it("keeps a malformed slug on the slug field", async () => {
    const result = await createBundleAction(initialAdminFormState, valid({ slug: "Bộ Khởi Đầu" }));

    expect(result.fieldErrors.slug).toBeTruthy();
    expect(result.fieldErrors.title).toBeUndefined();
    expect(createBundle).not.toHaveBeenCalled();
  });

  it("keeps a blank title on the title field", async () => {
    const result = await createBundleAction(initialAdminFormState, valid({ title: "  " }));

    expect(result.fieldErrors.title).toBeTruthy();
    expect(result.fieldErrors.slug).toBeUndefined();
    expect(createBundle).not.toHaveBeenCalled();
  });

  it("creates the bundle and redirects to its editor", async () => {
    vi.mocked(createBundle).mockResolvedValue({ bundleId });

    await expect(createBundleAction(initialAdminFormState, valid())).rejects.toThrow("NEXT_REDIRECT");

    expect(createBundle).toHaveBeenCalledWith({ locale: "vi", slug: "bo-khoi-dau", title: "Bộ khởi đầu" });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/bundles");
    expect(redirect).toHaveBeenCalledWith(`/admin/bundles/${bundleId}`);
  });

  it("surfaces a taken slug against the slug field", async () => {
    vi.mocked(createBundle).mockRejectedValue(new DuplicateBundleSlugError());

    const result = await createBundleAction(initialAdminFormState, valid());

    expect(result).toEqual({
      fieldErrors: { slug: "A bundle with this locale and slug already exists." },
      formError: null,
      savedAt: null,
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("hides unexpected errors behind a generic failure", async () => {
    vi.mocked(createBundle).mockRejectedValue(new Error("private database detail"));

    const result = await createBundleAction(initialAdminFormState, valid());

    expect(result).toEqual({ fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null });
  });
});
