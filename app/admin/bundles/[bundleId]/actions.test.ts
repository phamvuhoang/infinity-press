// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  publishBundleAction,
  saveBundleLocalizationAction,
  setBundleMembersAction,
  setBundleOfferAction,
  unpublishBundleAction,
} from "@/app/admin/bundles/[bundleId]/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import {
  BundleNotFoundError,
  BundleNotReadyError,
  publishBundle,
  saveBundleLocalization,
  setBundleMembers,
  setBundleOffer,
  unpublishBundle,
} from "@/lib/data/bundles";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/bundles", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/bundles")>();
  return {
    ...original,
    saveBundleLocalization: vi.fn(),
    setBundleMembers: vi.fn(),
    setBundleOffer: vi.fn(),
    publishBundle: vi.fn(),
    unpublishBundle: vi.fn(),
  };
});

const bundleId = "8a1b2c3d-0000-4000-8000-000000000001";
const bookA = "8a1b2c3d-0000-4000-8000-00000000000a";
const bookB = "8a1b2c3d-0000-4000-8000-00000000000b";
const editorPath = `/admin/bundles/${bundleId}`;

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("saveBundleLocalizationAction", () => {
  const valid = (overrides: Record<string, string> = {}) =>
    form({ slug: "bo-khoi-dau", title: "Bộ khởi đầu", subtitle: "", description: "Hai cuốn sách.", ...overrides });

  it("authorizes for this editor before touching the data layer", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(saveBundleLocalizationAction(bundleId, "vi", initialAdminFormState, valid())).rejects.toThrow("NEXT_FORBIDDEN");

    expect(saveBundleLocalization).not.toHaveBeenCalled();
  });

  it("saves the locale named by the server, not by the form", async () => {
    await saveBundleLocalizationAction(bundleId, "en", initialAdminFormState, valid({ locale: "vi" }));

    expect(requireAdmin).toHaveBeenCalledWith({ next: editorPath });
    expect(saveBundleLocalization).toHaveBeenCalledWith(bundleId, {
      locale: "en",
      slug: "bo-khoi-dau",
      title: "Bộ khởi đầu",
      subtitle: null,
      description: "Hai cuốn sách.",
    });
    expect(revalidatePath).toHaveBeenCalledWith(editorPath);
  });

  it("keeps a malformed slug on the slug field and saves nothing", async () => {
    const result = await saveBundleLocalizationAction(bundleId, "vi", initialAdminFormState, valid({ slug: "Bộ" }));

    expect(result.fieldErrors.slug).toBeTruthy();
    expect(result.fieldErrors.title).toBeUndefined();
    expect(saveBundleLocalization).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a bundle that is gone without leaking database text", async () => {
    vi.mocked(saveBundleLocalization).mockRejectedValue(new BundleNotFoundError());

    const result = await saveBundleLocalizationAction(bundleId, "vi", initialAdminFormState, valid());

    expect(result).toEqual({ fieldErrors: {}, formError: "This bundle no longer exists.", savedAt: null });
  });
});

describe("setBundleMembersAction", () => {
  function members(ids: string[]): FormData {
    const data = new FormData();
    for (const id of ids) data.append("editionIds", id);
    return data;
  }

  it("authorizes for this editor before touching the data layer", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(setBundleMembersAction(bundleId, initialAdminFormState, members([bookA]))).rejects.toThrow("NEXT_FORBIDDEN");

    expect(setBundleMembers).not.toHaveBeenCalled();
  });

  it("submits the complete ordered list in the order the form posted it", async () => {
    const result = await setBundleMembersAction(bundleId, initialAdminFormState, members([bookB, bookA]));

    expect(setBundleMembers).toHaveBeenCalledWith(bundleId, { editionIds: [bookB, bookA] });
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(revalidatePath).toHaveBeenCalledWith(editorPath);
  });

  it("refuses an empty membership on the editionIds field", async () => {
    const result = await setBundleMembersAction(bundleId, initialAdminFormState, members([]));

    expect(result.fieldErrors.editionIds).toBe("Add at least one edition.");
    expect(setBundleMembers).not.toHaveBeenCalled();
  });

  it("refuses a repeated edition on the editionIds field", async () => {
    const result = await setBundleMembersAction(bundleId, initialAdminFormState, members([bookA, bookA]));

    expect(result.fieldErrors.editionIds).toBe("Each edition can appear once.");
    expect(setBundleMembers).not.toHaveBeenCalled();
  });
});

describe("setBundleOfferAction", () => {
  const valid = (overrides: Record<string, string> = {}) =>
    form({ marketCode: "VN", currency: "VND", priceMinor: "150000", active: "on", ...overrides });

  it("authorizes for this editor before touching the data layer", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(setBundleOfferAction(bundleId, initialAdminFormState, valid())).rejects.toThrow("NEXT_FORBIDDEN");

    expect(setBundleOffer).not.toHaveBeenCalled();
  });

  it("saves the offer and refreshes the editor", async () => {
    const result = await setBundleOfferAction(bundleId, initialAdminFormState, valid());

    expect(setBundleOffer).toHaveBeenCalledWith(bundleId, { marketCode: "VN", currency: "VND", priceMinor: 150000, active: true });
    expect(result.savedAt).toEqual(expect.any(Number));
  });

  it("deactivates the offer when the checkbox is absent", async () => {
    const data = valid();
    data.delete("active");

    await setBundleOfferAction(bundleId, initialAdminFormState, data);

    expect(setBundleOffer).toHaveBeenCalledWith(bundleId, expect.objectContaining({ active: false }));
  });

  it("keeps a blank price on the price field rather than reading it as free", async () => {
    const result = await setBundleOfferAction(bundleId, initialAdminFormState, valid({ priceMinor: "" }));

    expect(result.fieldErrors.priceMinor).toBeTruthy();
    expect(setBundleOffer).not.toHaveBeenCalled();
  });

  it("keeps a malformed market code on the market field", async () => {
    const result = await setBundleOfferAction(bundleId, initialAdminFormState, valid({ marketCode: "vietnam" }));

    expect(result.fieldErrors.marketCode).toBeTruthy();
    expect(setBundleOffer).not.toHaveBeenCalled();
  });
});

describe.each([
  { name: "publish", action: publishBundleAction, write: publishBundle, message: "Bundle published." },
  { name: "unpublish", action: unpublishBundleAction, write: unpublishBundle, message: "Bundle unpublished." },
])("$name", ({ action, write, message }) => {
  it("authorizes, writes, and refreshes the editor and the list", async () => {
    vi.mocked(write).mockImplementation(async () => {
      expect(requireAdmin).toHaveBeenCalledWith({ next: editorPath });
    });

    await expect(action(bundleId)).resolves.toEqual({ ok: true, message });

    expect(write).toHaveBeenCalledWith(bundleId);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/bundles");
    expect(revalidatePath).toHaveBeenCalledWith(editorPath);
  });

  it("never writes for a denied caller", async () => {
    const denied = new Error("NEXT_FORBIDDEN");
    vi.mocked(requireAdmin).mockRejectedValue(denied);

    await expect(action(bundleId)).rejects.toBe(denied);

    expect(write).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides unexpected errors and does not revalidate a failed write", async () => {
    vi.mocked(write).mockRejectedValue(new Error("connection reset"));

    await expect(action(bundleId)).resolves.toEqual({ ok: false, error: "Something went wrong. Try again.", issues: [] });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

it("returns the database's readiness issues to the publisher without revalidating", async () => {
  vi.mocked(publishBundle).mockRejectedValue(new BundleNotReadyError(["too_few_published_members", "missing_cover"]));

  await expect(publishBundleAction(bundleId)).resolves.toEqual({
    ok: false,
    error: "This bundle is not ready to publish.",
    issues: ["too_few_published_members", "missing_cover"],
  });
  expect(revalidatePath).not.toHaveBeenCalled();
});
