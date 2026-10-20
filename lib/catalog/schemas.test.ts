import { describe, expect, it } from "vitest";
import {
  articleCreateSchema,
  articleDetailsSchema,
  articleLocalizationSchema,
  articleRelationsSchema,
  bookLocalizationSchema,
  bookRelationsSchema,
  bundleCoverAltTextSchema,
  bundleLocalizationSchema,
  bundleMembersSchema,
  bundleOfferSchema,
  coverUploadSchema,
  createBookSchema,
  createBundleSchema,
  couponSchema,
  editionSchema,
  entityLocalizationSchema,
  ideaCreateSchema,
  ideaLocalizationSchema,
  ideaRelationsSchema,
  knowledgeImageUploadSchema,
  knowledgeSeoSchema,
  merchandisingSchema,
  offerSchema,
  relatedBooksSchema,
} from "@/lib/catalog/schemas";

describe("createBookSchema", () => {
  it("keeps language, locale, market, and currency independent", () => {
    const result = createBookSchema.parse({
      canonicalKey: "the-golden-book",
      authorName: "Jane Austen",
      locale: "vi",
      language: "en",
      title: "The Golden Book",
      slug: "cuon-sach-vang",
      market: "VN",
      currency: "VND",
      priceMinor: 0,
    });
    expect(result.language).toBe("en");
    expect(result.locale).toBe("vi");
  });

  it("accepts either an existing author ID or a new author name", () => {
    const base = {
      canonicalKey: "the-golden-book",
      locale: "vi",
      language: "en",
      title: "The Golden Book",
      slug: "cuon-sach-vang",
      market: "VN",
      currency: "VND",
      priceMinor: 0,
    };

    expect(createBookSchema.safeParse({ ...base, authorId: "4a1b2c3d-0000-4000-8000-000000000001", authorName: "" }).success).toBe(true);
    expect(createBookSchema.safeParse({ ...base, authorId: null, authorName: "Jane Austen" }).success).toBe(true);
    expect(createBookSchema.safeParse({ ...base, authorId: null, authorName: "" }).success).toBe(false);
  });
});

describe("admin catalog schemas", () => {
  it("requires a series position only when a series is chosen", () => {
    expect(bookRelationsSchema.safeParse({ topicIds: [], seriesId: null, seriesPosition: null }).success).toBe(true);
    const missing = bookRelationsSchema.safeParse({
      topicIds: [],
      seriesId: "c4000000-0000-4000-8000-000000000001",
      seriesPosition: null,
    });
    expect(missing.success).toBe(false);
  });

  it("limits the featured slot to one book and rejects duplicates", () => {
    const id = "c3000000-0000-4000-8000-000000000001";
    expect(merchandisingSchema.safeParse({ slotKey: "home_featured", bookIds: [id, "c3000000-0000-4000-8000-000000000002"] }).success).toBe(false);
    expect(merchandisingSchema.safeParse({ slotKey: "home_shelf", bookIds: [id, id] }).success).toBe(false);
    expect(merchandisingSchema.safeParse({ slotKey: "home_shelf", bookIds: [id] }).success).toBe(true);
  });

  it("keeps the submitted pin order and refuses a repeated or malformed related book", () => {
    const first = "c5000000-0000-4000-8000-000000000001";
    const second = "c5000000-0000-4000-8000-000000000002";
    expect(relatedBooksSchema.safeParse({ relatedBookIds: [] }).success).toBe(true);
    expect(relatedBooksSchema.parse({ relatedBookIds: [second, first] }).relatedBookIds).toEqual([second, first]);
    expect(relatedBooksSchema.safeParse({ relatedBookIds: ["not-a-uuid"] }).success).toBe(false);
    const duplicate = relatedBooksSchema.safeParse({ relatedBookIds: [first, first] });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["relatedBookIds"], message: "Each related book can appear once." }),
    );
  });

  it("accepts ISBN-10 and ISBN-13 without dashes", () => {
    const base = { languageCode: "vi", editionNumber: 1, publicationDate: null };
    expect(editionSchema.safeParse({ ...base, isbn: "9786041234567" }).success).toBe(true);
    expect(editionSchema.safeParse({ ...base, isbn: "604123456X" }).success).toBe(true);
    expect(editionSchema.safeParse({ ...base, isbn: "978-604" }).success).toBe(false);
    expect(editionSchema.safeParse({ ...base, isbn: null }).success).toBe(true);
  });

  it("rejects oversized or non-image covers", () => {
    expect(coverUploadSchema.safeParse({ fileName: "c.png", mimeType: "image/png", sizeBytes: 1024 }).success).toBe(true);
    expect(coverUploadSchema.safeParse({ fileName: "c.gif", mimeType: "image/gif", sizeBytes: 1024 }).success).toBe(false);
    expect(coverUploadSchema.safeParse({ fileName: "c.png", mimeType: "image/png", sizeBytes: 6 * 1024 * 1024 }).success).toBe(false);
  });

  it("validates localized copy and offers", () => {
    expect(entityLocalizationSchema.safeParse({ locale: "vi", slug: "jane-austen", name: "Jane Austen", description: null }).success).toBe(true);
    expect(entityLocalizationSchema.safeParse({ locale: "fr", slug: "x", name: "X", description: null }).success).toBe(false);
    expect(
      bookLocalizationSchema.safeParse({
        locale: "vi",
        slug: "quan-sat",
        title: "Quan sát",
        subtitle: null,
        shortDescription: null,
        description: "Mô tả",
        audience: null,
        keyIdeas: [{ title: "Ý", summary: "" }],
        faq: [],
        seoTitle: "x".repeat(71),
        seoDescription: null,
      }).success,
    ).toBe(false);
    expect(offerSchema.safeParse({ marketCode: "VN", currency: "VND", priceMinor: -1, active: true }).success).toBe(false);
  });

  // S19: the sale fields mirror the offers_sale_* CHECK constraints.
  const sale = { marketCode: "VN", currency: "VND", priceMinor: 129000, active: true, salePercentOff: null, saleAmountOffMinor: null, saleStartsAt: null, saleEndsAt: null };
  it.each([
    ["a free book", { ...sale, priceMinor: 0, saleKind: "percent", salePercentOff: 10 }, "saleKind"],
    ["a percent sale with no percentage", { ...sale, saleKind: "percent" }, "salePercentOff"],
    ["a 100% sale", { ...sale, saleKind: "percent", salePercentOff: 100 }, "salePercentOff"],
    ["a fixed sale at the price", { ...sale, saleKind: "fixed", saleAmountOffMinor: 129000 }, "saleAmountOffMinor"],
    ["a window that ends before it starts", { ...sale, saleKind: "percent", salePercentOff: 10, saleStartsAt: "2026-11-02T00:00", saleEndsAt: "2026-11-01T00:00" }, "saleEndsAt"],
    ["a malformed date", { ...sale, saleKind: "percent", salePercentOff: 10, saleEndsAt: "tomorrow" }, "saleEndsAt"],
  ])("refuses %s", (_name, input, path) => {
    const result = offerSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(path);
  });

  it("accepts a fixed sale below the price", () => {
    expect(offerSchema.parse({ ...sale, saleKind: "fixed", saleAmountOffMinor: 40000 }).sale).toEqual({
      kind: "fixed", percentOff: null, amountOffMinor: 40000, startsAt: null, endsAt: null,
    });
  });

  // Review fix: a value left over from another kind must not block the save.
  it("clears every sale field when no sale is chosen, whatever stale values were posted", () => {
    const result = offerSchema.parse({ ...sale, saleKind: "none", salePercentOff: 100, saleAmountOffMinor: 999999, saleEndsAt: "tomorrow" });
    expect(result.sale).toBeNull();
  });

  it("ignores a stale percentage when the sale is a fixed amount, and the reverse", () => {
    expect(offerSchema.parse({ ...sale, saleKind: "fixed", salePercentOff: 100, saleAmountOffMinor: 40000 }).sale).toMatchObject({ percentOff: null, amountOffMinor: 40000 });
    expect(offerSchema.parse({ ...sale, saleKind: "percent", salePercentOff: 30, saleAmountOffMinor: 999999 }).sale).toMatchObject({ percentOff: 30, amountOffMinor: null });
  });
});

// S9: the bundle editor (spec 6.4). A Server Action is a public POST endpoint, so the bundle
// forms are shaped here before anything reaches the definer RPCs.
describe("bundle schemas", () => {
  const bookId = "c4000000-0000-4000-8000-000000000001";
  const otherBookId = "c4000000-0000-4000-8000-000000000002";

  it("requires a locale, a kebab-case slug, and a title to create a bundle", () => {
    expect(createBundleSchema.safeParse({ locale: "vi", slug: "goi-sach-tinh-thuc", title: "Gói sách" }).success).toBe(true);
    expect(createBundleSchema.safeParse({ locale: "fr", slug: "coffret", title: "Coffret" }).success).toBe(false);
    expect(createBundleSchema.safeParse({ locale: "vi", slug: "Gói Sách", title: "Gói sách" }).success).toBe(false);
    expect(createBundleSchema.safeParse({ locale: "vi", slug: "goi-sach", title: "   " }).success).toBe(false);
  });

  it("accepts a bundle localization with optional subtitle and description", () => {
    const base = { locale: "en", slug: "mindfulness-bundle", title: "Mindfulness bundle" };
    expect(bundleLocalizationSchema.safeParse({ ...base, subtitle: null, description: null }).success).toBe(true);
    expect(bundleLocalizationSchema.safeParse({ ...base, subtitle: "Two books", description: "Both books." }).success).toBe(true);
    expect(bundleLocalizationSchema.safeParse({ ...base, slug: "not a slug", subtitle: null, description: null }).success).toBe(false);
    expect(bundleLocalizationSchema.safeParse({ ...base, title: "", subtitle: null, description: null }).success).toBe(false);
  });

  it("takes the member order from the submitted list and refuses a repeated book", () => {
    expect(bundleMembersSchema.parse({ bookIds: [otherBookId, bookId] }).bookIds).toEqual([otherBookId, bookId]);
    expect(bundleMembersSchema.safeParse({ bookIds: [bookId, bookId] }).success).toBe(false);
    expect(bundleMembersSchema.safeParse({ bookIds: [] }).success).toBe(false);
    expect(bundleMembersSchema.safeParse({ bookIds: ["not-a-uuid"] }).success).toBe(false);
  });

  it("prices a bundle through the same offer shape a sku offer uses", () => {
    expect(bundleOfferSchema.safeParse({ marketCode: "VN", currency: "VND", priceMinor: 199000, active: true }).success).toBe(true);
    expect(bundleOfferSchema.safeParse({ marketCode: "vn", currency: "VND", priceMinor: 199000, active: true }).success).toBe(false);
    // The one rule a bundle offer has that a book offer does not: a book may be given away, a
    // bundle may not - create_bundle_order sells only a price above 0, so an active free bundle
    // offer publishes a bundle nobody can buy.
    expect(bundleOfferSchema.safeParse({ marketCode: "VN", currency: "VND", priceMinor: 0, active: true }).success).toBe(false);
    expect(bundleOfferSchema.safeParse({ marketCode: "VN", currency: "VND", priceMinor: 0, active: false }).success).toBe(true);
    expect(bundleOfferSchema.safeParse({ marketCode: "VN", currency: "VND", priceMinor: -1, active: true }).success).toBe(false);
  });

  it("requires alt text for a bundle cover", () => {
    expect(bundleCoverAltTextSchema.safeParse("Two books side by side").success).toBe(true);
    expect(bundleCoverAltTextSchema.safeParse("   ").success).toBe(false);
    expect(bundleCoverAltTextSchema.safeParse("x".repeat(301)).success).toBe(false);
  });
});

describe("couponSchema", () => {
  const bookId = "4a1b2c3d-0000-4000-8000-0000000000b1";
  const bundleId = "4a1b2c3d-0000-4000-8000-0000000000c1";
  const base = {
    code: "LAUNCH20",
    kind: "percent" as const,
    percentOff: 20,
    amountOffMinor: null,
    currency: null,
    startsAt: null,
    endsAt: null,
    active: true,
    maxRedemptions: null,
    maxRedemptionsPerProfile: 1,
    note: null,
  };

  // S9 spec 8: book scope and bundle scope are two independent sets. A coupon that names a book
  // must come out with an EMPTY bundle scope, however many bundles contain that book - widening it
  // here would discount every bundle a promoted book happens to sit in.
  it("carries book scope and bundle scope as two separate sets", () => {
    const parsed = couponSchema.parse({ ...base, bookIds: [bookId], bundleIds: [] });
    expect(parsed.bookIds).toEqual([bookId]);
    expect(parsed.bundleIds).toEqual([]);

    expect(couponSchema.parse({ ...base, bookIds: [], bundleIds: [bundleId] }).bundleIds).toEqual([bundleId]);
    expect(couponSchema.parse({ ...base, bookIds: [bookId], bundleIds: [bundleId] }).bundleIds).toEqual([bundleId]);
  });

  it("requires both scopes to be present and to hold UUIDs", () => {
    expect(couponSchema.safeParse({ ...base, bookIds: [] }).success).toBe(false);
    expect(couponSchema.safeParse({ ...base, bookIds: [], bundleIds: ["not-a-uuid"] }).success).toBe(false);
  });
});

describe("S12 knowledge schemas", () => {
  const ideaId = "5a1b2c3d-0000-4000-8000-000000000001";
  const otherIdea = "5a1b2c3d-0000-4000-8000-000000000002";
  const bookId = "5a1b2c3d-0000-4000-8000-0000000000b1";
  const topicId = "5a1b2c3d-0000-4000-8000-0000000000c1";
  const authorId = "5a1b2c3d-0000-4000-8000-0000000000a1";
  const paragraph = [{ type: "paragraph", content: [{ text: "Đọc chậm lại." }] }];

  it("creates an idea from its first localization and trims its copy", () => {
    expect(
      ideaCreateSchema.parse({ locale: "vi", slug: "doc-cham", question: " Vì sao nên đọc chậm? ", shortAnswer: "Để nhớ lâu." }),
    ).toEqual({ locale: "vi", slug: "doc-cham", question: "Vì sao nên đọc chậm?", shortAnswer: "Để nhớ lâu." });
    expect(ideaCreateSchema.safeParse({ locale: "fr", slug: "x", question: "Q", shortAnswer: "A" }).success).toBe(false);
    expect(ideaCreateSchema.safeParse({ locale: "vi", slug: "Not Kebab", question: "Q", shortAnswer: "A" }).success).toBe(false);
    expect(ideaCreateSchema.safeParse({ locale: "vi", slug: "q", question: "  ", shortAnswer: "A" }).success).toBe(false);
  });

  it("creates an article with an author", () => {
    const base = { locale: "en", slug: "slow-reading", title: "Slow reading", excerpt: "Why it works." };
    expect(articleCreateSchema.safeParse({ ...base, authorId }).success).toBe(true);
    const missing = articleCreateSchema.safeParse({ ...base, authorId: "" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(["authorId"]);
    expect(articleDetailsSchema.safeParse({ authorId }).success).toBe(true);
    expect(articleDetailsSchema.safeParse({ authorId: "nope" }).success).toBe(false);
  });

  it("rejects HTML-tag syntax in every editorial text field but keeps ordinary angle brackets", () => {
    expect(ideaCreateSchema.safeParse({ locale: "vi", slug: "a", question: "<b>Q</b>", shortAnswer: "A" }).success).toBe(false);
    expect(ideaCreateSchema.safeParse({ locale: "vi", slug: "a", question: "Q", shortAnswer: "<script>x</script>" }).success).toBe(false);
    expect(
      articleCreateSchema.safeParse({ authorId, locale: "vi", slug: "a", title: "<img src=x>", excerpt: "E" }).success,
    ).toBe(false);
    expect(knowledgeSeoSchema.safeParse({ locale: "vi", seoTitle: "<em>t</em>", seoDescription: null }).success).toBe(false);
    expect(ideaCreateSchema.safeParse({ locale: "vi", slug: "a", question: "Is 2 < 3?", shortAnswer: "Yes, 3 > 2." }).success).toBe(true);
  });

  it("parses body blocks from a JSON string through the block schema", () => {
    const parsed = ideaLocalizationSchema.parse({
      locale: "vi",
      slug: "doc-cham",
      question: "Vì sao?",
      shortAnswer: "Vì vậy.",
      bodyBlocks: JSON.stringify(paragraph),
    });
    expect(parsed.bodyBlocks).toEqual(paragraph);
    const article = articleLocalizationSchema.parse({
      locale: "en",
      slug: "slow",
      title: "Slow",
      excerpt: "Excerpt",
      bodyBlocks: "[]",
    });
    expect(article.bodyBlocks).toEqual([]);
  });

  it("reports malformed JSON, stored HTML, and invalid blocks on the bodyBlocks field", () => {
    const base = { locale: "vi", slug: "a", question: "Q", shortAnswer: "A" };
    const malformed = ideaLocalizationSchema.safeParse({ ...base, bodyBlocks: "{not json" });
    expect(malformed.success).toBe(false);
    expect(malformed.error?.issues[0]?.path).toEqual(["bodyBlocks"]);

    const html = ideaLocalizationSchema.safeParse({ ...base, bodyBlocks: "<p>Hello</p>" });
    expect(html.success).toBe(false);

    const object = ideaLocalizationSchema.safeParse({ ...base, bodyBlocks: JSON.stringify({ type: "paragraph" }) });
    expect(object.success).toBe(false);

    const tagged = ideaLocalizationSchema.safeParse({
      ...base,
      bodyBlocks: JSON.stringify([{ type: "paragraph", content: [{ text: "<b>x</b>" }] }]),
    });
    expect(tagged.success).toBe(false);
    expect(tagged.error?.issues[0]?.path).toEqual(["bodyBlocks", 0, "content", 0, "text"]);

    const unknown = ideaLocalizationSchema.safeParse({ ...base, bodyBlocks: JSON.stringify([{ type: "html", html: "x" }]) });
    expect(unknown.success).toBe(false);
  });

  it("keeps SEO copy optional and short", () => {
    expect(knowledgeSeoSchema.parse({ locale: "en", seoTitle: null, seoDescription: null })).toEqual({
      locale: "en",
      seoTitle: null,
      seoDescription: null,
    });
    expect(knowledgeSeoSchema.safeParse({ locale: "en", seoTitle: "x".repeat(71), seoDescription: null }).success).toBe(false);
    expect(knowledgeSeoSchema.safeParse({ locale: "en", seoTitle: null, seoDescription: "x".repeat(161) }).success).toBe(false);
  });

  it("keeps relation order and refuses repeated ids", () => {
    expect(
      ideaRelationsSchema.parse({ bookIds: [bookId], topicIds: [topicId], relatedIdeaIds: [otherIdea, ideaId] }).relatedIdeaIds,
    ).toEqual([otherIdea, ideaId]);
    const repeated = ideaRelationsSchema.safeParse({ bookIds: [], topicIds: [], relatedIdeaIds: [otherIdea, otherIdea] });
    expect(repeated.success).toBe(false);
    expect(repeated.error?.issues[0]?.path).toEqual(["relatedIdeaIds"]);
    expect(ideaRelationsSchema.safeParse({ bookIds: ["x"], topicIds: [], relatedIdeaIds: [] }).success).toBe(false);
    expect(articleRelationsSchema.safeParse({ bookIds: [bookId], ideaIds: [ideaId], topicIds: [topicId] }).success).toBe(true);
    expect(articleRelationsSchema.safeParse({ bookIds: [bookId, bookId], ideaIds: [], topicIds: [] }).success).toBe(false);
  });

  it("accepts only JPEG, PNG, or WebP knowledge images up to 5 MB", () => {
    expect(knowledgeImageUploadSchema.safeParse({ mimeType: "image/png", sizeBytes: 5 * 1024 * 1024 }).success).toBe(true);
    expect(knowledgeImageUploadSchema.safeParse({ mimeType: "image/gif", sizeBytes: 10 }).success).toBe(false);
    expect(knowledgeImageUploadSchema.safeParse({ mimeType: "image/png", sizeBytes: 5 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(knowledgeImageUploadSchema.safeParse({ mimeType: "image/png", sizeBytes: 0 }).success).toBe(false);
  });
});
