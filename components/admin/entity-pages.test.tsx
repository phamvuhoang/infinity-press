import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { EntityEditPage } from "@/components/admin/entity-pages";
import { entityBaseSchema } from "@/lib/catalog/schemas";
import { getCatalogEntity } from "@/lib/data/catalog-entities";

vi.mock("@/lib/data/catalog-entities", () => ({ getCatalogEntity: vi.fn() }));
vi.mock("@/lib/data/author-image", () => ({ getAuthorImage: vi.fn().mockResolvedValue(null) }));
// The author portrait uploader is a client component, so this server-rendered page needs a router.
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));
vi.mock("@/app/admin/entities/author-image-actions", () => ({
  createAuthorImageUploadAction: vi.fn(),
  finalizeAuthorImageUploadAction: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("@/app/admin/entities/actions", () => ({
  createEntityAction: vi.fn(),
  updateEntityAction: vi.fn(),
  saveEntityLocalizationAction: vi.fn(),
}));

afterEach(cleanup);

it.each(["author", "series", "topic"] as const)("keeps long unbroken %s names and slugs inside a wrappable edit container", async (type) => {
  const name = "W".repeat(200);
  const canonicalSlug = "a".repeat(200);
  const input = entityBaseSchema.parse({ name, canonicalSlug, status: "draft" });
  vi.mocked(getCatalogEntity).mockResolvedValue({
    ...input, id: "4a1b2c3d-0000-4000-8000-000000000001", type,
    locales: [], localizations: [],
  });

  const { container } = render(await EntityEditPage({ type, id: "4a1b2c3d-0000-4000-8000-000000000001" }));
  const heading = screen.getByRole("heading", { level: 1, name });
  const details = screen.getByText(`${canonicalSlug} · draft`);

  // These inherited layout utilities protect both pieces of arbitrary text. Browser coverage
  // in admin-entities.spec.ts checks the resulting 375px geometry with the same valid inputs.
  expect(container.firstElementChild).toHaveClass("min-w-0", "wrap-anywhere");
  expect(container.firstElementChild).toContainElement(heading);
  expect(container.firstElementChild).toContainElement(details);
  expect(screen.getByLabelText("Canonical slug")).toHaveValue(canonicalSlug);
  expect(screen.getByLabelText("Name", { exact: true })).toHaveValue(name);
});
