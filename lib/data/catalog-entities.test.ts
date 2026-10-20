// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  createCatalogEntity,
  DuplicateCanonicalSlugError,
  DuplicateEntitySlugError,
  EntityNotReadyError,
  getCatalogEntity,
  listCatalogEntities,
  listCatalogEntityOptions,
  saveCatalogEntityLocalization,
  updateCatalogEntity,
} from "@/lib/data/catalog-entities";
import { fakeSupabaseClient, recordingChain } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const id = "4a1b2c3d-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("catalog entities", () => {
  it("does not expose raw database read or write errors", async () => {
    const fake = fakeSupabaseClient({ tables: { authors: { data: null, error: { code: "XX000", message: "private database detail" } } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(listCatalogEntities("author")).rejects.toThrow("Unable to load catalog entries.");
    await expect(createCatalogEntity("author", { canonicalSlug: "a", name: "A" })).rejects.toThrow("Unable to save catalog entry.");
  });

  it("returns not found for invalid and missing IDs", async () => {
    await expect(getCatalogEntity("author", "invalid")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createClient).not.toHaveBeenCalled();
    const fake = fakeSupabaseClient({});
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(getCatalogEntity("author", id)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([["author", "authors", "display_name"], ["series", "series", "display_name"], ["topic", "topics", "name"]] as const)("inserts a draft into %s's configured table and column", async (type, table, column) => {
    const query = { insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id }, error: null }) };
    const from = vi.fn(() => query);
    vi.mocked(createClient).mockResolvedValue({ from } as unknown as SessionClient);
    await expect(createCatalogEntity(type, { canonicalSlug: "a", name: "A" })).resolves.toEqual({ id });
    expect(from).toHaveBeenCalledWith(table);
    expect(query.insert).toHaveBeenCalledWith({ canonical_slug: "a", [column]: "A", status: "draft" });
  });

  it("lists options including drafts for relation editing", async () => {
    const fake = fakeSupabaseClient({ tables: { authors: { data: [{ id, canonical_slug: "a", display_name: "A", status: "draft", localizations: [] }], error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(listCatalogEntityOptions("author")).resolves.toEqual([{ id, name: "A", canonicalSlug: "a" }]);
  });

  it("never builds a client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(listCatalogEntities("author")).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reads the right table and name column, and lists localized locales", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        topics: {
          data: [{ id, canonical_slug: "tinh-biet", name: "Tỉnh biết", status: "draft", localizations: [{ locale: "vi", slug: "tinh-biet", name: "Tỉnh biết", description: null }] }],
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const topics = await listCatalogEntities("topic");

    expect(fake.from).toHaveBeenCalledWith("topics");
    expect(topics).toEqual([{ id, canonicalSlug: "tinh-biet", name: "Tỉnh biết", status: "draft", locales: ["vi"] }]);
  });

  it("creates new entities as drafts", async () => {
    const fake = fakeSupabaseClient({ tables: { series: { data: { id }, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createCatalogEntity("series", { canonicalSlug: "thay", name: "Thấy" })).resolves.toEqual({ id });
    expect(fake.from).toHaveBeenCalledWith("series");
  });

  it("maps a canonical slug collision", async () => {
    const fake = fakeSupabaseClient({
      tables: { authors: { data: null, error: { code: "23505", message: 'violates unique constraint "authors_canonical_slug_key"' } } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createCatalogEntity("author", { canonicalSlug: "jane-austen", name: "Jane Austen" })).rejects.toBeInstanceOf(DuplicateCanonicalSlugError);
  });

  it("refuses to publish an entity with no localized copy", async () => {
    const fake = fakeSupabaseClient({
      tables: { authors: { data: { id, canonical_slug: "a", display_name: "A", status: "draft", localizations: [] }, error: null } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(
      updateCatalogEntity("author", id, { canonicalSlug: "a", name: "A", status: "published", acceptsQuestions: true }),
    ).rejects.toBeInstanceOf(EntityNotReadyError);
  });

  it("writes accepts_questions for authors and leaves it off series", async () => {
    const ready = { id, canonical_slug: "a", status: "draft", localizations: [{ locale: "vi", slug: "a", name: "A", description: null }] };
    const calls: [string, unknown[]][] = [];
    const client = {
      from: (table: string) =>
        recordingChain({ data: table === "authors" ? { ...ready, display_name: "A" } : { ...ready, name: "S" }, error: null }, calls).chain,
    };
    vi.mocked(createClient).mockResolvedValue(client as unknown as SessionClient);
    const updates = () => calls.filter(([method]) => method === "update").map(([, args]) => args[0]);

    await updateCatalogEntity("author", id, { canonicalSlug: "a", name: "A", status: "draft", acceptsQuestions: false });
    expect(updates().at(-1)).toEqual({ canonical_slug: "a", display_name: "A", status: "draft", accepts_questions: false });
    await updateCatalogEntity("series", id, { canonicalSlug: "a", name: "S", status: "draft", acceptsQuestions: true });
    expect(updates().at(-1)).toEqual({ canonical_slug: "a", display_name: "S", status: "draft" });
  });

  it("maps a localized slug collision", async () => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "23505", message: 'violates unique constraint "author_localizations_locale_slug_key"' } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(
      saveCatalogEntityLocalization("author", id, { locale: "vi", slug: "jane-austen", name: "Jane Austen", description: null, quote: "Tôi viết để bạn nhìn lại." }),
    ).rejects.toBeInstanceOf(DuplicateEntitySlugError);
    expect(fake.rpc).toHaveBeenCalledWith("admin_save_entity_localization", {
      p_entity_type: "author",
      p_entity_id: id,
      p_locale: "vi",
      p_slug: "jane-austen",
      p_name: "Jane Austen",
      p_description: null,
      p_quote: "Tôi viết để bạn nhìn lại.",
    });
  });

  it("returns localizations in vi, en order", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        series: {
          data: {
            id,
            canonical_slug: "thay",
            display_name: "Thấy",
            status: "draft",
            localizations: [
              { locale: "en", slug: "see", name: "See", description: null },
              { locale: "vi", slug: "thay", name: "Thấy", description: null },
            ],
          },
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const series = await getCatalogEntity("series", id);
    expect(series.localizations.map((localization) => localization.locale)).toEqual(["vi", "en"]);
  });
});
