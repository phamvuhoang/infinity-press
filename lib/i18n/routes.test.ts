import { describe, expect, it } from "vitest";

import { getCatalogRoutes, getCommerceRoutes, getKnowledgeRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

describe("localized route graph", () => {
  it("keeps primary navigation in the selected locale", () => {
    expect(getLocaleRoutes("en")).toEqual({
      account: "/en/account",
      books: "/en/books",
      home: "/en",
      library: "/en/library",
      myQuotes: "/en/library/quotes",
      orders: "/en/account/orders",
      search: "/en/search",
      signIn: "/en/sign-in",
    });
  });

  it("builds catalog URLs under the locale", () => {
    const routes = getCatalogRoutes("vi");
    expect(routes.book("dac-nhan-tam")).toBe("/vi/books/dac-nhan-tam");
    expect(routes.entity("author", "nguyen-nhat-anh")).toBe("/vi/authors/nguyen-nhat-anh");
    expect(routes.entity("series", "harbour")).toBe("/vi/series/harbour");
    expect(routes.entity("topic", "habits")).toBe("/vi/topics/habits");
    expect(routes.sample("dac-nhan-tam")).toBe("/vi/read-sample/dac-nhan-tam");
    expect(routes.read("30000000-0000-4000-8000-000000000001")).toBe("/vi/read/30000000-0000-4000-8000-000000000001");
    expect(routes.readEdition("40000000-0000-4000-8000-000000000002")).toBe("/vi/read/editions/40000000-0000-4000-8000-000000000002");
    expect(routes.signInFor("/vi/books/dac-nhan-tam")).toBe("/vi/sign-in?next=%2Fvi%2Fbooks%2Fdac-nhan-tam");
    expect(routes.bundle("goi-khoi-dau")).toBe("/vi/bundles/goi-khoi-dau");
  });

  it("builds the review and ask-the-author routes", () => {
    expect(getCatalogRoutes("vi").review("b1")).toBe("/vi/library/reviews/b1");
    expect(getCatalogRoutes("en").ask({ book: "b1" })).toBe("/en/ask?book=b1");
    expect(getCatalogRoutes("en").ask({ idea: "i1" })).toBe("/en/ask?idea=i1");
  });

  it("builds checkout and order routes", () => {
    const routes = getCommerceRoutes("vi");
    const orderId = "70000000-0000-4000-8000-000000000001";
    expect(routes.checkout(orderId)).toBe(`/vi/checkout/${orderId}`);
    expect(routes.checkoutSimulate(orderId)).toBe(`/vi/checkout/${orderId}/simulate`);
    expect(routes.checkoutStatus(orderId)).toBe(`/vi/checkout/${orderId}/status`);
    expect(routes.order(orderId)).toBe(`/vi/account/orders/${orderId}`);
    expect(routes.bookActionError("mot-cuon-sach", "not-purchasable")).toBe("/vi/books/mot-cuon-sach?action-error=not-purchasable");
    expect(routes.bundleActionError("goi-khoi-dau", "not-purchasable")).toBe(
      "/vi/bundles/goi-khoi-dau?action-error=not-purchasable",
    );
  });

  it("builds the localized gift claim path", () => {
    expect(getCommerceRoutes("vi").giftClaim("Zm9vLWJhcl9iYXo")).toBe("/vi/gifts/claim/Zm9vLWJhcl9iYXo");
    expect(getCommerceRoutes("en").giftClaim("Zm9vLWJhcl9iYXo")).toBe("/en/gifts/claim/Zm9vLWJhcl9iYXo");
    // base64url never produces these, but a token is a credential: nothing in it may be read as
    // path structure.
    expect(getCommerceRoutes("vi").giftClaim("a/b?c")).toBe("/vi/gifts/claim/a%2Fb%3Fc");
  });

  it("builds the manual transfer path under the locale", () => {
    expect(getCommerceRoutes("vi").checkoutTransfer("abc")).toBe("/vi/checkout/abc/transfer");
  });

  it("builds knowledge hub routes under the locale", () => {
    expect(getKnowledgeRoutes("vi")).toEqual({
      ideas: "/vi/ideas",
      idea: expect.any(Function),
      articles: "/vi/articles",
      article: expect.any(Function),
    });
    expect(getKnowledgeRoutes("vi").idea("song-tinh-thuc")).toBe("/vi/ideas/song-tinh-thuc");
    expect(getKnowledgeRoutes("vi").article("doc-cham")).toBe("/vi/articles/doc-cham");
    expect(getKnowledgeRoutes("en").ideas).toBe("/en/ideas");
    expect(getKnowledgeRoutes("en").idea("living-awake")).toBe("/en/ideas/living-awake");
    expect(getKnowledgeRoutes("en").articles).toBe("/en/articles");
    expect(getKnowledgeRoutes("en").article("reading-slowly")).toBe("/en/articles/reading-slowly");
  });
});
