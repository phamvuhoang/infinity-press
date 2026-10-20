// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEntityAction, saveEntityLocalizationAction, updateEntityAction } from "@/app/admin/entities/actions";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { createCatalogEntity, DuplicateCanonicalSlugError, DuplicateEntitySlugError, EntityNotReadyError, saveCatalogEntityLocalization, updateCatalogEntity } from "@/lib/data/catalog-entities";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }) }));
vi.mock("@/lib/data/catalog-entities", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/catalog-entities")>();
  return { ...original, createCatalogEntity: vi.fn(), saveCatalogEntityLocalization: vi.fn(), updateCatalogEntity: vi.fn() };
});

function form(entries: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("entity actions", () => {
  const id = "4a1b2c3d-0000-4000-8000-000000000001";
  const valid = () => form({ canonicalSlug: "a", name: "A", status: "published", slug: "a", description: "" });

  it.each(["create", "update", "localization"])("gates the %s action even with a tampered type", async (operation) => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    const call = operation === "create"
      ? createEntityAction("publisher" as never, initialAdminFormState, valid())
      : operation === "update"
        ? updateEntityAction("publisher" as never, id, initialAdminFormState, valid())
        : saveEntityLocalizationAction("publisher" as never, id, "vi", initialAdminFormState, valid());
    await expect(call).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createCatalogEntity).not.toHaveBeenCalled();
    expect(updateCatalogEntity).not.toHaveBeenCalled();
    expect(saveCatalogEntityLocalization).not.toHaveBeenCalled();
  });

  it.each([["author", "/admin/authors"], ["series", "/admin/series"], ["topic", "/admin/topics"]] as const)("creates %s and redirects after revalidation", async (type, path) => {
    vi.mocked(createCatalogEntity).mockResolvedValue({ id });
    await expect(createEntityAction(type, initialAdminFormState, valid())).rejects.toThrow("NEXT_REDIRECT");
    expect(createCatalogEntity).toHaveBeenCalledWith(type, { canonicalSlug: "a", name: "A" });
    expect(requireAdmin).toHaveBeenCalledWith({ next: `${path}/new` });
    expect(revalidatePath).toHaveBeenCalledWith(path);
    expect(redirect).toHaveBeenCalledWith(`${path}/${id}`);
  });

  it("maps canonical collisions and unready publishing to their fields", async () => {
    vi.mocked(createCatalogEntity).mockRejectedValue(new DuplicateCanonicalSlugError());
    expect((await createEntityAction("author", initialAdminFormState, valid())).fieldErrors.canonicalSlug).toBeTruthy();
    vi.mocked(updateCatalogEntity).mockRejectedValue(new EntityNotReadyError());
    expect((await updateEntityAction("author", id, initialAdminFormState, valid())).fieldErrors.status).toBeTruthy();
  });

  it("returns generic failures without leaking database errors", async () => {
    vi.mocked(updateCatalogEntity).mockRejectedValue(new Error("private database detail"));
    const result = await updateEntityAction("author", id, initialAdminFormState, valid());
    expect(result).toEqual({ fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("validates status and locale before mutation", async () => {
    expect((await updateEntityAction("author", id, initialAdminFormState, form({ canonicalSlug: "a", name: "A", status: "deleted" }))).fieldErrors.status).toBeTruthy();
    expect((await saveEntityLocalizationAction("author", id, "fr" as never, initialAdminFormState, valid())).fieldErrors.locale).toBeTruthy();
    expect(updateCatalogEntity).not.toHaveBeenCalled();
    expect(saveCatalogEntityLocalization).not.toHaveBeenCalled();
  });

  it("reads the ask-the-author checkbox for authors only", async () => {
    vi.mocked(updateCatalogEntity).mockResolvedValue();
    await updateEntityAction("author", id, initialAdminFormState, valid());
    expect(updateCatalogEntity).toHaveBeenLastCalledWith("author", id, { canonicalSlug: "a", name: "A", status: "published", acceptsQuestions: false });
    await updateEntityAction("author", id, initialAdminFormState, form({ canonicalSlug: "a", name: "A", status: "published", acceptsQuestions: "on" }));
    expect(updateCatalogEntity).toHaveBeenLastCalledWith("author", id, { canonicalSlug: "a", name: "A", status: "published", acceptsQuestions: true });
    // Series and topics never render the checkbox, so its absence must not read as "off".
    await updateEntityAction("series", id, initialAdminFormState, valid());
    expect(updateCatalogEntity).toHaveBeenLastCalledWith("series", id, { canonicalSlug: "a", name: "A", status: "published", acceptsQuestions: true });
  });

  it("saves localization and refreshes both detail and list languages", async () => {
    vi.mocked(saveCatalogEntityLocalization).mockResolvedValue();
    const result = await saveEntityLocalizationAction("author", id, "vi", initialAdminFormState, valid());
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(saveCatalogEntityLocalization).toHaveBeenCalledWith("author", id, { locale: "vi", slug: "a", name: "A", description: null, quote: null });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/authors");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/authors/${id}`);
  });
  it("rejects an entity type that is not author, series, or topic", async () => {
    const result = await createEntityAction("publisher" as never, initialAdminFormState, form({ canonicalSlug: "x", name: "X" }));
    expect(result.formError).toBe("Unknown catalog type.");
    expect(createCatalogEntity).not.toHaveBeenCalled();
  });

  it("returns field errors instead of calling the data layer", async () => {
    const result = await createEntityAction("author", initialAdminFormState, form({ canonicalSlug: "Not A Slug", name: "" }));
    expect(result.fieldErrors.canonicalSlug).toBeTruthy();
    expect(result.fieldErrors.name).toBe("Enter a name.");
    expect(createCatalogEntity).not.toHaveBeenCalled();
  });

  it("maps a localized slug collision to the slug field", async () => {
    vi.mocked(saveCatalogEntityLocalization).mockRejectedValue(new DuplicateEntitySlugError());
    const result = await saveEntityLocalizationAction(
      "author",
      "4a1b2c3d-0000-4000-8000-000000000001",
      "vi",
      initialAdminFormState,
      form({ slug: "phuong-bui", name: "Phương Bùi", description: "" }),
    );
    expect(result.fieldErrors.slug).toBe("This slug is already used in this language.");
  });
});
