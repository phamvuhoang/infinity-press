// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  saveBookLocalizationAction,
  saveRetailLinksAction,
  setBookRelationsAction,
  setRelatedBooksAction,
  updateOfferAction,
  updateBookDetailsAction,
  updateEditionAction,
} from "@/app/admin/books/[bookId]/editor-actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { revalidatePath } from "next/cache";
import { BookNotFoundError, DuplicateCanonicalKeyError, updateBookDetails, updateEdition } from "@/lib/data/books";
import { DuplicateSlugError, saveBookLocalization, SeriesPositionTakenError, setBookRelations, setBookRetailLinks, setRelatedBooks, updateOffer } from "@/lib/data/books";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/books", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/books")>();
  return { ...original, saveBookLocalization: vi.fn(), setBookRelations: vi.fn(), setBookRetailLinks: vi.fn(), setRelatedBooks: vi.fn(), updateOffer: vi.fn(), updateBookDetails: vi.fn(), updateEdition: vi.fn() };
});

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
const offerId = "8a1b2c3d-0000-4000-8000-000000000001";
const relatedA = "b1000000-0000-4000-8000-000000000001";
const relatedB = "b1000000-0000-4000-8000-000000000002";

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("book editor actions", () => {
  const cases = [
    { name: "details", run: (data: FormData) => updateBookDetailsAction(bookId, initialAdminFormState, data), write: updateBookDetails, entries: [["canonicalKey", "new-key"], ["originalLanguage", "vi"], ["primaryAuthorId", bookId]], payload: { canonicalKey: "new-key", originalLanguage: "vi", primaryAuthorId: bookId }, target: bookId, field: "canonicalKey", error: new DuplicateCanonicalKeyError() },
    { name: "localization", run: (data: FormData) => saveBookLocalizationAction(bookId, "en", initialAdminFormState, data), write: saveBookLocalization, entries: [["slug", "new-slug"], ["title", "New title"]], payload: expect.objectContaining({ locale: "en", slug: "new-slug", title: "New title" }), target: bookId, field: "slug", error: new DuplicateSlugError() },
    { name: "edition", run: (data: FormData) => updateEditionAction(bookId, offerId, initialAdminFormState, data), write: updateEdition, entries: [["languageCode", "en"], ["editionNumber", "2"], ["publicationDate", "2026-09-14"]], payload: { languageCode: "en", isbn: null, editionNumber: 2, publicationDate: "2026-09-14" }, target: offerId, field: "editionNumber", error: new BookNotFoundError() },
    { name: "offer", run: (data: FormData) => updateOfferAction(bookId, offerId, initialAdminFormState, data), write: updateOffer, entries: [["marketCode", "VN"], ["currency", "VND"], ["priceMinor", "2500"], ["active", "on"]], payload: { marketCode: "VN", currency: "VND", priceMinor: 2500, active: true, sale: null }, target: offerId, field: "priceMinor", error: new BookNotFoundError() },
    { name: "relations", run: (data: FormData) => setBookRelationsAction(bookId, initialAdminFormState, data), write: setBookRelations, entries: [["topicIds", bookId], ["topicIds", offerId], ["seriesId", ""], ["seriesPosition", "99"]], payload: { topicIds: [bookId, offerId], seriesId: null, seriesPosition: null }, target: bookId, field: "topicIds", error: new SeriesPositionTakenError() },
    { name: "related books", run: (data: FormData) => setRelatedBooksAction(bookId, initialAdminFormState, data), write: setRelatedBooks, entries: [["relatedBookIds", relatedB], ["relatedBookIds", relatedA]], payload: [relatedB, relatedA], target: bookId, field: "relatedBookIds", error: new BookNotFoundError() },
  ];
  it.each(cases)("$name authorizes before parsing or writing", async ({ run, write }) => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));
    await expect(run(new FormData())).rejects.toThrow("Forbidden");
    expect(write).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it.each(cases)("$name saves normalized values and refreshes both admin pages", async ({ run, write, entries, payload, target }) => {
    const result = await run(form(entries as [string, string][]));
    expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/books/${bookId}` });
    expect(write).toHaveBeenCalledWith(target, payload);
    expect(result).toEqual({ fieldErrors: {}, formError: null, savedAt: expect.any(Number) });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/books");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/books/${bookId}`);
  });
  it.each(cases)("$name rejects invalid input without writes or revalidation", async ({ run, write, field }) => {
    const result = await run(form([[field, "!"]]));
    expect(Object.keys(result.fieldErrors).length).toBeGreaterThan(0);
    expect(result.savedAt).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it.each(cases)("$name hides unknown database messages", async ({ run, write, entries }) => {
    vi.mocked(write).mockRejectedValue(new Error("private database detail 42501"));
    expect(await run(form(entries as [string, string][]))).toEqual({ fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it.each(cases)("$name exposes safe known failures", async ({ run, write, entries, error }) => {
    vi.mocked(write).mockRejectedValue(error);
    const result = await run(form(entries as [string, string][]));
    expect(result.savedAt).toBeNull();
    expect(JSON.stringify(result)).toContain(error.message);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it("parses key ideas and FAQ text before saving a localization", async () => {
    const result = await saveBookLocalizationAction(
      bookId,
      "vi",
      initialAdminFormState,
      form([
        ["slug", "quan-sat"],
        ["title", "Quan sát"],
        ["description", "Mô tả"],
        ["keyIdeas", "Quan sát | Nhìn mà không phán xét\nTự do"],
        ["faq", "Q: Đọc ở đâu?\nA: Trên web."],
      ]),
    );

    expect(result.savedAt).not.toBeNull();
    expect(saveBookLocalization).toHaveBeenCalledWith(bookId, expect.objectContaining({
      locale: "vi",
      subtitle: null,
      keyIdeas: [{ title: "Quan sát", summary: "Nhìn mà không phán xét" }, { title: "Tự do", summary: "" }],
      faq: [{ question: "Đọc ở đâu?", answer: "Trên web." }],
    }));
  });

  it("puts a slug collision on the slug field", async () => {
    vi.mocked(saveBookLocalization).mockRejectedValue(new DuplicateSlugError());
    const result = await saveBookLocalizationAction(bookId, "vi", initialAdminFormState, form([["slug", "taken"], ["title", "T"]]));
    expect(result.fieldErrors.slug).toBe("A book with this locale and slug already exists.");
  });

  it("reads an unchecked active box as false", async () => {
    await updateOfferAction(bookId, offerId, initialAdminFormState, form([["marketCode", "VN"], ["currency", "VND"], ["priceMinor", "0"]]));
    expect(updateOffer).toHaveBeenCalledWith(offerId, { marketCode: "VN", currency: "VND", priceMinor: 0, active: false, sale: null });
  });

  it("saves a windowed percent sale as UTC and clears every sale field when the kind is none", async () => {
    const base: [string, string][] = [["marketCode", "VN"], ["currency", "VND"], ["priceMinor", "129000"], ["active", "on"]];
    await updateOfferAction(bookId, offerId, initialAdminFormState, form([...base, ["saleKind", "percent"], ["salePercentOff", "30"], ["saleAmountOffMinor", "5000"], ["saleStartsAt", ""], ["saleEndsAt", "2026-11-01T00:00"]]));
    expect(updateOffer).toHaveBeenLastCalledWith(offerId, {
      marketCode: "VN", currency: "VND", priceMinor: 129000, active: true,
      sale: { kind: "percent", percentOff: 30, amountOffMinor: null, startsAt: null, endsAt: "2026-11-01T00:00:00Z" },
    });
    await updateOfferAction(bookId, offerId, initialAdminFormState, form([...base, ["saleKind", "none"], ["salePercentOff", "30"], ["saleEndsAt", "2026-11-01T00:00"]]));
    expect(updateOffer).toHaveBeenLastCalledWith(offerId, { marketCode: "VN", currency: "VND", priceMinor: 129000, active: true, sale: null });
  });

  it("refuses a fixed sale at or above the price as a field error", async () => {
    const state = await updateOfferAction(bookId, offerId, initialAdminFormState, form([["marketCode", "VN"], ["currency", "VND"], ["priceMinor", "129000"], ["saleKind", "fixed"], ["saleAmountOffMinor", "129000"]]));
    expect(state.fieldErrors.saleAmountOffMinor).toBe("Enter an amount below the price.");
  });

  // The shared authorization row above posts an EMPTY form. For every other action that is invalid
  // input, so an action that parsed first would return a form state and the row would go red. This
  // schema accepts an empty pin list, so that row cannot see the ordering: it needs a payload the
  // schema REJECTS. A duplicate pin is one, and a parse-first action returns invalid() for it
  // instead of ever reaching requireAdmin().
  it("related books authorizes before parsing a payload the schema would reject", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));

    await expect(
      setRelatedBooksAction(bookId, initialAdminFormState, form([["relatedBookIds", relatedA], ["relatedBookIds", relatedA]])),
    ).rejects.toThrow("Forbidden");
    expect(setRelatedBooks).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps the submitted pin order and refreshes the storefront", async () => {
    const result = await setRelatedBooksAction(bookId, initialAdminFormState, form([["relatedBookIds", relatedB], ["relatedBookIds", relatedA]]));

    expect(result.savedAt).not.toBeNull();
    expect(setRelatedBooks).toHaveBeenCalledWith(bookId, [relatedB, relatedA]);
    expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/sitemap.xml");
  });

  it("clears every pin when the picker posts an empty list", async () => {
    const result = await setRelatedBooksAction(bookId, initialAdminFormState, new FormData());

    expect(result.savedAt).not.toBeNull();
    expect(setRelatedBooks).toHaveBeenCalledWith(bookId, []);
  });

  it("refuses a repeated pin without writing or revalidating", async () => {
    const result = await setRelatedBooksAction(bookId, initialAdminFormState, form([["relatedBookIds", relatedA], ["relatedBookIds", relatedA]]));

    expect(result.fieldErrors.relatedBookIds).toBe("Each related book can appear once.");
    expect(setRelatedBooks).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("requires a position when a series is chosen and maps a taken position", async () => {
    const seriesId = "aa1b2c3d-0000-4000-8000-000000000001";
    const missing = await setBookRelationsAction(bookId, initialAdminFormState, form([["seriesId", seriesId]]));
    expect(missing.fieldErrors.seriesPosition).toBe("Enter the book's position in the series.");
    expect(setBookRelations).not.toHaveBeenCalled();

    vi.mocked(setBookRelations).mockRejectedValue(new SeriesPositionTakenError());
    const taken = await setBookRelationsAction(bookId, initialAdminFormState, form([["seriesId", seriesId], ["seriesPosition", "1"]]));
    expect(taken.fieldErrors.seriesPosition).toBe("Another book already holds this position in the series.");
  });
});

describe("saveRetailLinksAction", () => {
  it("authorizes before parsing or writing", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));
    await expect(saveRetailLinksAction(bookId, initialAdminFormState, new FormData())).rejects.toThrow("Forbidden");
    expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/books/${bookId}` });
    expect(setBookRetailLinks).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("parses indexed rows in order and replaces the set", async () => {
    const data = form([
      ["linkCount", "2"],
      ["links[0].retailer", "tiki"],
      ["links[0].url", "https://tiki.vn/x"],
      ["links[0].active", "on"],
      ["links[1].retailer", "other"],
      ["links[1].label", "ABC"],
      ["links[1].url", "https://abc.example/x"],
      ["links[1].priceMinor", "129000"],
      ["links[1].currency", "VND"],
    ]);
    const state = await saveRetailLinksAction(bookId, initialAdminFormState, data);
    expect(state.formError).toBeNull();
    expect(state.savedAt).not.toBeNull();
    expect(setBookRetailLinks).toHaveBeenCalledWith(bookId, [
      { retailer: "tiki", label: null, url: "https://tiki.vn/x", priceMinor: null, currency: null, active: true },
      { retailer: "other", label: "ABC", url: "https://abc.example/x", priceMinor: 129000, currency: "VND", active: false },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/books/${bookId}`);
  });

  it("clears the set when the form posts no rows", async () => {
    const state = await saveRetailLinksAction(bookId, initialAdminFormState, form([["linkCount", "0"]]));
    expect(state.savedAt).not.toBeNull();
    expect(setBookRetailLinks).toHaveBeenCalledWith(bookId, []);
  });

  it("reports a field error on a bad url without calling the DAL", async () => {
    const data = form([["linkCount", "1"], ["links[0].retailer", "shopee"], ["links[0].url", "http://shopee.vn/x"], ["links[0].active", "on"]]);
    const state = await saveRetailLinksAction(bookId, initialAdminFormState, data);
    expect(state.fieldErrors["links.0.url"]).toBeDefined();
    expect(setBookRetailLinks).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses more than ten rows instead of truncating the set", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => [
      [`links[${i}].retailer`, "shopee"],
      [`links[${i}].url`, `https://shopee.vn/${i}`],
    ]).flat() as [string, string][];
    const state = await saveRetailLinksAction(bookId, initialAdminFormState, form([["linkCount", "11"], ...rows]));
    expect(state.formError).toBe("At most 10 retailer links per book.");
    expect(setBookRetailLinks).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("surfaces a database rejection as the generic form error", async () => {
    vi.mocked(setBookRetailLinks).mockRejectedValue(new Error("setBookRetailLinks failed."));
    const data = form([["linkCount", "1"], ["links[0].retailer", "shopee"], ["links[0].url", "https://shopee.vn/x"]]);
    expect(await saveRetailLinksAction(bookId, initialAdminFormState, data)).toEqual({ fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("drops the pre-filled currency when the row has no price", async () => {
    const data = form([["linkCount", "1"], ["links[0].retailer", "shopee"], ["links[0].url", "https://shopee.vn/x"], ["links[0].currency", "VND"], ["links[0].active", "on"]]);
    const state = await saveRetailLinksAction(bookId, initialAdminFormState, data);
    expect(state.savedAt).not.toBeNull();
    expect(setBookRetailLinks).toHaveBeenCalledWith(bookId, [
      { retailer: "shopee", label: null, url: "https://shopee.vn/x", priceMinor: null, currency: null, active: true },
    ]);
  });

  it("still rejects a price with a cleared currency", async () => {
    const data = form([["linkCount", "1"], ["links[0].retailer", "shopee"], ["links[0].url", "https://shopee.vn/x"], ["links[0].priceMinor", "129000"], ["links[0].currency", ""]]);
    const state = await saveRetailLinksAction(bookId, initialAdminFormState, data);
    expect(Object.keys(state.fieldErrors).length).toBeGreaterThan(0);
    expect(setBookRetailLinks).not.toHaveBeenCalled();
  });

  it.each([["absent", []], ["non-numeric", [["linkCount", "abc"]]], ["negative", [["linkCount", "-1"]]], ["fractional", [["linkCount", "1.5"]]]] as [string, [string, string][]][])(
    "refuses a %s linkCount instead of clearing the set",
    async (_name, entries) => {
      const state = await saveRetailLinksAction(bookId, initialAdminFormState, form(entries));
      expect(state).toEqual({ fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null });
      expect(setBookRetailLinks).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});
