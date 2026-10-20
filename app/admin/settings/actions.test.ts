// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { savePlatformSettingsAction } from "@/app/admin/settings/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { savePlatformSettings } from "@/lib/i18n/settings";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n/settings", () => ({ savePlatformSettings: vi.fn() }));

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const valid = { defaultUiLocale: "ja", defaultContentLanguage: "en", defaultMetadataLocale: "en" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("savePlatformSettingsAction", () => {
  it("denies at the action boundary before validating or writing", async () => {
    const denied = new Error("NEXT_FORBIDDEN");
    vi.mocked(requireAdmin).mockRejectedValue(denied);
    await expect(savePlatformSettingsAction(initialAdminFormState, form(valid))).rejects.toBe(denied);
    expect(savePlatformSettings).not.toHaveBeenCalled();
  });

  it("rejects a UI locale outside the registry", async () => {
    const result = await savePlatformSettingsAction(initialAdminFormState, form({ ...valid, defaultUiLocale: "fr" }));
    expect(result.fieldErrors.defaultUiLocale).toBeDefined();
    expect(savePlatformSettings).not.toHaveBeenCalled();
  });

  it("rejects a malformed content language", async () => {
    const result = await savePlatformSettingsAction(
      initialAdminFormState,
      form({ ...valid, defaultContentLanguage: "English!" }),
    );
    expect(result.fieldErrors.defaultContentLanguage).toBeDefined();
    expect(savePlatformSettings).not.toHaveBeenCalled();
  });

  it("saves and refreshes every locale's storefront", async () => {
    const result = await savePlatformSettingsAction(initialAdminFormState, form(valid));
    expect(result.savedAt).not.toBeNull();
    expect(savePlatformSettings).toHaveBeenCalledWith({
      defaultUiLocale: "ja",
      defaultContentLanguage: "en",
      defaultMetadataLocale: "en",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/settings");
  });

  it("reports a failed save without pretending it worked", async () => {
    vi.mocked(savePlatformSettings).mockRejectedValue(new Error("savePlatformSettings failed."));
    const result = await savePlatformSettingsAction(initialAdminFormState, form(valid));
    expect(result.savedAt).toBeNull();
    expect(result.formError).toMatch(/Something went wrong/);
  });
});
