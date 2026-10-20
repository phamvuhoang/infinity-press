// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleCoverUploadAction, finalizeBundleCoverUploadAction } from "@/app/admin/bundles/[bundleId]/cover-actions";
import { requireAdmin } from "@/lib/auth/admin";
import { CoverBundleNotFoundError, createBundleCoverUpload, finalizeBundleCoverUpload } from "@/lib/data/bundle-covers";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/bundle-covers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/bundle-covers")>();
  return { ...original, createBundleCoverUpload: vi.fn(), finalizeBundleCoverUpload: vi.fn() };
});

const bundleId = "8a1b2c3d-0000-4000-8000-000000000001";
const storageKey = `bundles/${bundleId}/6c2f1b3a-0000-4000-8000-000000000000.webp`;
const editorPath = `/admin/bundles/${bundleId}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("createBundleCoverUploadAction", () => {
  it("authorizes before validating or reserving an upload", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(
      createBundleCoverUploadAction(bundleId, { fileName: "cover.webp", mimeType: "image/webp", sizeBytes: 1 }),
    ).rejects.toThrow("NEXT_FORBIDDEN");

    expect(createBundleCoverUpload).not.toHaveBeenCalled();
  });

  it("refuses a file type admin_set_bundle_cover could never accept", async () => {
    const result = await createBundleCoverUploadAction(bundleId, { fileName: "cover.gif", mimeType: "image/gif", sizeBytes: 1 });

    expect(result).toEqual({ ok: false, error: "Upload a JPEG, PNG, or WebP image." });
    expect(createBundleCoverUpload).not.toHaveBeenCalled();
  });

  it("returns only the signed reservation", async () => {
    vi.mocked(createBundleCoverUpload).mockResolvedValue({ storageKey, path: "path", token: "token" });

    await expect(
      createBundleCoverUploadAction(bundleId, { fileName: "cover.webp", mimeType: "image/webp", sizeBytes: 1 }),
    ).resolves.toEqual({ ok: true, storageKey, path: "path", token: "token" });

    expect(requireAdmin).toHaveBeenCalledWith({ next: editorPath });
    // Reserving a key changes nothing an admin page renders; only finalizing does.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides unexpected reservation errors", async () => {
    vi.mocked(createBundleCoverUpload).mockRejectedValue(new Error("storage internals"));

    await expect(
      createBundleCoverUploadAction(bundleId, { fileName: "cover.webp", mimeType: "image/webp", sizeBytes: 1 }),
    ).resolves.toEqual({ ok: false, error: "Something went wrong saving the cover. Try again." });
  });
});

describe("finalizeBundleCoverUploadAction", () => {
  it("authorizes before finalizing", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(
      finalizeBundleCoverUploadAction(bundleId, { storageKey, altText: "Bìa", width: null, height: null }),
    ).rejects.toThrow("NEXT_FORBIDDEN");

    expect(finalizeBundleCoverUpload).not.toHaveBeenCalled();
  });

  it("validates alt text before finalizing", async () => {
    const result = await finalizeBundleCoverUploadAction(bundleId, { storageKey, altText: "  ", width: 600, height: 900 });

    expect(result).toEqual({ ok: false, error: "Describe the bundle cover for screen readers." });
    expect(finalizeBundleCoverUpload).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("finalizes and refreshes the admin bundle paths", async () => {
    const input = { storageKey, altText: "Bìa bộ sách", width: 600, height: 900 };

    await expect(finalizeBundleCoverUploadAction(bundleId, input)).resolves.toEqual({ ok: true });

    expect(finalizeBundleCoverUpload).toHaveBeenCalledWith(bundleId, input);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/bundles");
    expect(revalidatePath).toHaveBeenCalledWith(editorPath);
  });

  it("explains a key the database refused without leaking its sentence", async () => {
    vi.mocked(finalizeBundleCoverUpload).mockRejectedValue(new CoverBundleNotFoundError());

    await expect(
      finalizeBundleCoverUploadAction(bundleId, { storageKey, altText: "Bìa", width: null, height: null }),
    ).resolves.toEqual({ ok: false, error: "This bundle no longer exists." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
