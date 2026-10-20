import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import SettingsPage from "@/app/admin/settings/page";
import { requireAdmin } from "@/lib/auth/admin";
import { getPlatformSettings, listContentLanguages } from "@/lib/i18n/settings";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/i18n/settings", () => ({ getPlatformSettings: vi.fn(), listContentLanguages: vi.fn() }));
vi.mock("@/app/admin/settings/actions", () => ({ savePlatformSettingsAction: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

it("denies the settings page before loading anything", async () => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

  await expect(SettingsPage()).rejects.toThrow("NEXT_FORBIDDEN");

  expect(getPlatformSettings).not.toHaveBeenCalled();
  expect(listContentLanguages).not.toHaveBeenCalled();
});

it("offers every registered interface locale, preselecting the saved default", async () => {
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(getPlatformSettings).mockResolvedValue({
    defaultUiLocale: "ja",
    defaultContentLanguage: "en",
    defaultMetadataLocale: "en",
  });
  vi.mocked(listContentLanguages).mockResolvedValue([
    { code: "en", name: "English" },
    { code: "fr", name: "French" },
  ]);

  render(await SettingsPage());

  const ui = screen.getByLabelText("Default interface language") as HTMLSelectElement;
  expect([...ui.options].map((option) => option.value)).toEqual(["vi", "en", "ja"]);
  expect(ui.value).toBe("ja");
  const content = screen.getByLabelText("Default edition language") as HTMLSelectElement;
  expect([...content.options].map((option) => option.value)).toEqual(["en", "fr"]);
});
