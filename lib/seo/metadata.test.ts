import { describe, expect, it } from "vitest";

import { absoluteUrl, buildPageMetadata, DEFAULT_OG_IMAGE, fixedPaths, localePaths } from "@/lib/seo/metadata";

const siteUrl = "https://books.example";

describe("absoluteUrl", () => {
  it("joins the site origin and a path", () => {
    expect(absoluteUrl(siteUrl, "/vi/books")).toBe("https://books.example/vi/books");
  });

  it("drops query strings and fragments so filters, searches, and errors never reach a canonical", () => {
    expect(absoluteUrl(siteUrl, "/en/books?topic=poetry&sort=title")).toBe("https://books.example/en/books");
    expect(absoluteUrl(siteUrl, "/en/search?q=harbour")).toBe("https://books.example/en/search");
    expect(absoluteUrl(siteUrl, "/vi/books/a?action-error=x#top")).toBe("https://books.example/vi/books/a");
  });

  it("ignores any path already on the site URL", () => {
    expect(absoluteUrl("https://books.example/", "/vi")).toBe("https://books.example/vi");
  });
});

describe("localePaths", () => {
  it("keeps only the current locale when the entity has no other localization", () => {
    expect(localePaths("vi", "/vi/books/a", {})).toEqual({ vi: "/vi/books/a" });
  });

  it("adds every other locale that has a localization", () => {
    expect(localePaths("en", "/en/books/a", { vi: "/vi/books/b", ja: "/ja/books/c" })).toEqual({
      en: "/en/books/a",
      vi: "/vi/books/b",
      ja: "/ja/books/c",
    });
  });

  it("never lets an alternate replace the current locale's own path", () => {
    expect(localePaths("en", "/en/x", { en: "/en/other" })).toEqual({ en: "/en/x" });
  });
});

describe("fixedPaths", () => {
  it("names the same page in every registered locale", () => {
    expect(fixedPaths((locale) => `/${locale}/books`)).toEqual({ vi: "/vi/books", en: "/en/books", ja: "/ja/books" });
  });
});

describe("buildPageMetadata for a page whose copy is in another locale", () => {
  // A Japanese URL that shows the English copy (no Japanese translation exists) is not a Japanese
  // translation: its canonical is the English page, and it does not claim an hreflang of its own.
  const paths = { en: "/en/books/a", vi: "/vi/books/b" };

  it("canonicalizes to the page the copy belongs to", () => {
    const metadata = buildPageMetadata({ siteUrl, locale: "ja", paths, copyFrom: "en", title: "A" });
    expect(metadata.alternates?.canonical).toBe("https://books.example/en/books/a");
    expect(metadata.openGraph).toMatchObject({ url: "https://books.example/en/books/a", locale: "ja_JP" });
  });

  it("lists only the locales that really have the page, never the fallback locale", () => {
    const metadata = buildPageMetadata({ siteUrl, locale: "ja", paths, copyFrom: "en", title: "A" });
    expect(metadata.alternates?.languages).toEqual({
      en: "https://books.example/en/books/a",
      vi: "https://books.example/vi/books/b",
      "x-default": "https://books.example/en/books/a",
    });
  });

  it("refuses a fallback that names a locale with no page", () => {
    expect(() => buildPageMetadata({ siteUrl, locale: "ja", paths, copyFrom: "ja" })).toThrow();
  });
});

describe("buildPageMetadata", () => {
  it("sets an absolute canonical and every locale alternate for a fixed page", () => {
    const metadata = buildPageMetadata({
      siteUrl,
      locale: "vi",
      paths: { vi: "/vi/books", en: "/en/books", ja: "/ja/books" },
      title: "Sách",
    });
    expect(metadata.alternates).toEqual({
      canonical: "https://books.example/vi/books",
      languages: {
        vi: "https://books.example/vi/books",
        en: "https://books.example/en/books",
        ja: "https://books.example/ja/books",
        "x-default": "https://books.example/en/books",
      },
    });
    expect(metadata.title).toBe("Sách");
    expect(metadata.robots).toBeUndefined();
  });

  it("links only the existing localization of an entity page", () => {
    const metadata = buildPageMetadata({ siteUrl, locale: "en", paths: { en: "/en/authors/mai-tran" } });
    expect(metadata.alternates?.languages).toEqual({
      en: "https://books.example/en/authors/mai-tran",
      "x-default": "https://books.example/en/authors/mai-tran",
    });
  });

  it("points x-default at the default locale, falling back to the only page that exists", () => {
    const both = buildPageMetadata({ siteUrl, locale: "ja", paths: { en: "/en/books", vi: "/vi/books", ja: "/ja/books" } });
    const jaOnly = buildPageMetadata({ siteUrl, locale: "ja", paths: { ja: "/ja/books/a" } });
    expect(both.alternates?.languages?.["x-default"]).toBe("https://books.example/en/books");
    expect(jaOnly.alternates?.languages?.["x-default"]).toBe("https://books.example/ja/books/a");
  });

  it("uses the branded default Open Graph image when there is no cover", () => {
    const metadata = buildPageMetadata({ siteUrl, locale: "en", paths: { en: "/en" }, description: "Hello" });
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      siteName: "Infinity Books Press",
      locale: "en_US",
      url: "https://books.example/en",
      images: [{ ...DEFAULT_OG_IMAGE, url: "https://books.example/opengraph-image" }],
    });
    expect(metadata.description).toBe("Hello");
  });

  it("uses a book cover when one is given", () => {
    const metadata = buildPageMetadata({
      siteUrl,
      locale: "vi",
      paths: { vi: "/vi/books/a" },
      image: { url: "https://cdn.example/covers/a.png", alt: "Bìa sách" },
    });
    expect(metadata.openGraph?.images).toEqual([{ url: "https://cdn.example/covers/a.png", alt: "Bìa sách" }]);
    expect(metadata.openGraph).toMatchObject({ locale: "vi_VN" });
  });

  it("announces the other locale to Open Graph only when it exists", () => {
    const both = buildPageMetadata({ siteUrl, locale: "vi", paths: { vi: "/vi", en: "/en" } });
    const one = buildPageMetadata({ siteUrl, locale: "vi", paths: { vi: "/vi/books/a" } });
    expect(both.openGraph).toMatchObject({ alternateLocale: ["en_US"] });
    expect(one.openGraph).not.toHaveProperty("alternateLocale");
  });

  it("maps the index rules", () => {
    const base = { siteUrl, locale: "en" as const, paths: { en: "/en/search" } };
    expect(buildPageMetadata({ ...base, index: "noindex-follow" }).robots).toEqual({ index: false, follow: true });
    expect(buildPageMetadata({ ...base, index: "noindex-nofollow" }).robots).toEqual({ index: false, follow: false });
  });

  it("never lets a query string into the canonical, the alternates, or the Open Graph URL", () => {
    const metadata = buildPageMetadata({
      siteUrl,
      locale: "en",
      paths: { en: "/en/books?topic=x", vi: "/vi/books?sort=title" },
    });
    expect(JSON.stringify(metadata)).not.toContain("?");
  });
});
