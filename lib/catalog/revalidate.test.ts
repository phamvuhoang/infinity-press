// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, expect, it, vi } from "vitest";

import { revalidateBookAdmin, revalidateKnowledgeHub, revalidateStorefront } from "@/lib/catalog/revalidate";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it("refreshes every public page under the locale layout", () => {
  revalidateStorefront();
  expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
});

it("refreshes the sitemap with the storefront", () => {
  revalidateStorefront();
  expect(revalidatePath).toHaveBeenCalledWith("/sitemap.xml");
});

it("refreshes the llms.txt index with the storefront", () => {
  revalidateStorefront();
  expect(revalidatePath).toHaveBeenCalledWith("/llms.txt");
});

it("refreshes the storefront whenever a book changes in the admin", () => {
  revalidateBookAdmin("30000000-0000-4000-8000-000000000001");
  expect(revalidatePath).toHaveBeenCalledWith("/admin/books/30000000-0000-4000-8000-000000000001");
  expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
  expect(revalidatePath).toHaveBeenCalledWith("/sitemap.xml");
});

it.each([
  ["idea", "/admin/ideas/5a1b2c3d-0000-4000-8000-000000000001"],
  ["article", "/admin/articles/5a1b2c3d-0000-4000-8000-000000000001"],
] as const)("refreshes the storefront, sitemap, llms.txt, both knowledge lists, and the edited %s", (kind, detail) => {
  revalidateKnowledgeHub(kind, "5a1b2c3d-0000-4000-8000-000000000001");
  expect(vi.mocked(revalidatePath).mock.calls).toEqual(
    expect.arrayContaining([["/[lang]", "layout"], ["/sitemap.xml"], ["/llms.txt"], ["/admin/ideas"], ["/admin/articles"], [detail]]),
  );
  expect(revalidatePath).toHaveBeenCalledTimes(6);
});
