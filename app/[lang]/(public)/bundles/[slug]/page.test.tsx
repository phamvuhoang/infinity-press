import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BundlePage, { generateMetadata } from "@/app/[lang]/(public)/bundles/[slug]/page";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getServerEnv } from "@/lib/config/server-env";
import { getPublicBundle, type PublicBundleDTO } from "@/lib/data/public-bundles";

// The header reaches for a Supabase session and has nothing to do with what this page shows.
vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
// ViewerBundleAction's useViewerAction also reaches for a Supabase session, to refetch on sign-in/
// sign-out - give it a client that never fires an event, rather than mocking the component away, so
// these tests still exercise the real anonymous-action rendering path.
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({
    auth: { onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
  })),
}));
const searchParams = { value: new URLSearchParams() };
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useSearchParams: () => searchParams.value,
}));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
// publicBundleAction is a pure function (no session, no I/O) - kept real here rather than mocked,
// so these tests exercise the same anonymous-action rule the page actually renders with.
vi.mock("@/lib/data/public-bundles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/public-bundles")>();
  return { ...actual, getPublicBundle: vi.fn() };
});

const BUNDLE_ID = "40000000-0000-4000-8000-000000000001";

function card(bookId: string, slug: string, title: string): CatalogBookCard {
  return {
    bookId,
    slug,
    title,
    subtitle: null,
    shortDescription: null,
    author: { name: "Mai Tran", slug: "mai-tran" },
    cover: null,
    offer: { priceMinor: 129000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
    hasActivePublication: true,
    hasSample: false, editionId: "edition-1", languageCode: "en", isLanguageFallback: false, metadataLocale: "en",
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

const bundle: PublicBundleDTO = {
  bundleId: BUNDLE_ID,
  slug: "starter-bundle",
  alternateSlugs: { vi: "goi-khoi-dau" },
  metadataLocale: "en",
  title: "Starter Bundle",
  subtitle: "Two books to begin with",
  description: "A set of two.",
  cover: null,
  offer: { priceMinor: 199000, currency: "VND" },
  members: [
    { ...card("book-1", "book-one", "Book One"), editionId: "edition-1", languageCode: "en", languageLabel: "English" },
    { ...card("book-2", "book-two", "Book Two"), editionId: "edition-2", languageCode: "en", languageLabel: "English" },
  ],
};

const params = Promise.resolve({ lang: "en", slug: "starter-bundle" });

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.value = new URLSearchParams();
  vi.mocked(getServerEnv).mockReturnValue({
    siteUrl: "https://books.example",
    paymentProvider: "simulator",
  } as unknown as ReturnType<typeof getServerEnv>);
  vi.mocked(getPublicBundle).mockResolvedValue(bundle);
  // The action control is a client island (ViewerBundleAction) that fetches its own state; this
  // page test is about what the server renders, so the fetch is left pending and the page's own
  // anonymous action - what BundlePage computes without a session - is what stays on screen.
  // ViewerBundleAction's own tests cover what happens once the fetch resolves.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BundlePage", () => {
  it("404s on an unsupported locale without reading anything", async () => {
    await expect(BundlePage({ params: Promise.resolve({ lang: "fr", slug: "starter-bundle" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(getPublicBundle).not.toHaveBeenCalled();
  });

  it("404s when there is no published bundle at this slug", async () => {
    vi.mocked(getPublicBundle).mockResolvedValue(null);
    await expect(BundlePage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows the title, subtitle, description and the one price", async () => {
    render(await BundlePage({ params }));

    expect(screen.getByRole("heading", { level: 1, name: "Starter Bundle" })).toBeInTheDocument();
    expect(screen.getByText("Two books to begin with")).toBeInTheDocument();
    expect(screen.getByText("A set of two.")).toBeInTheDocument();
    expect(screen.getByText("₫199,000")).toBeInTheDocument();
    expect(screen.getByText(/One price for the whole bundle/)).toBeInTheDocument();
  });

  it("lists the members in position order, each linking to its own book page", async () => {
    render(await BundlePage({ params }));

    const section = screen.getByRole("region", { name: "In this bundle" });
    const links = within(section).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/en/books/book-one", "/en/books/book-two"]);
  });

  // The page can no longer tell a signed-in reader from an anonymous one while rendering - that is
  // the point of the split - so what it renders by default is the anonymous action: a sign-in link
  // rather than a Buy form. ViewerBundleAction's own tests cover the signed-in and owned-bundle
  // swaps once its fetch resolves.
  it("renders the anonymous Buy action - a sign-in link, not a form - so the page can be prerendered", async () => {
    render(await BundlePage({ params }));

    expect(screen.queryByRole("button", { name: "Buy bundle" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy bundle" })).toHaveAttribute(
      "href",
      "/en/sign-in?next=%2Fen%2Fbundles%2Fstarter-bundle",
    );
  });

  // Readiness is a publish-time gate, so a published bundle can end up with nothing to show. It has
  // to render, without a price it cannot honour and without a Buy button.
  it("renders a published bundle that has fallen below its readiness bar", async () => {
    vi.mocked(getPublicBundle).mockResolvedValue({ ...bundle, members: [], offer: null });
    render(await BundlePage({ params }));

    expect(screen.getByRole("heading", { level: 1, name: "Starter Bundle" })).toBeInTheDocument();
    expect(screen.getByText("This bundle has no editions to show right now.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "In this bundle" })).queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByText(/₫/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buy bundle" })).not.toBeInTheDocument();
  });

  it("shows the action error the Buy redirect carried back", async () => {
    searchParams.value = new URLSearchParams({ "action-error": "not-purchasable" });
    render(await BundlePage({ params }));

    expect(screen.getByRole("alert")).toHaveTextContent("This book cannot be bought right now.");
  });

  it("emits Product JSON-LD naming the member books", async () => {
    const { container } = render(await BundlePage({ params }));

    const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')].map((node) => node.textContent ?? "");
    const product = scripts.map((text) => JSON.parse(text)).flat().find((entry) => entry["@type"] === "Product");
    expect(product).toMatchObject({ name: "Starter Bundle", offers: { price: 199000, priceCurrency: "VND" } });
    expect(product.isRelatedTo).toHaveLength(2);
  });
});

describe("generateMetadata", () => {
  it("canonicalizes the bundle and links the alternate locale", async () => {
    const metadata = await generateMetadata({ params });

    expect(metadata.alternates).toEqual({
      canonical: "https://books.example/en/bundles/starter-bundle",
      languages: {
        en: "https://books.example/en/bundles/starter-bundle",
        vi: "https://books.example/vi/bundles/goi-khoi-dau",
        "x-default": "https://books.example/en/bundles/starter-bundle",
      },
    });
  });

  it("names no alternate for a bundle localized in one locale only", async () => {
    vi.mocked(getPublicBundle).mockResolvedValue({ ...bundle, alternateSlugs: {} });

    const metadata = await generateMetadata({ params });

    expect(metadata.alternates?.languages).toEqual({
      en: "https://books.example/en/bundles/starter-bundle",
      "x-default": "https://books.example/en/bundles/starter-bundle",
    });
  });

  it("is empty for an unknown bundle or an unsupported locale", async () => {
    vi.mocked(getPublicBundle).mockResolvedValue(null);
    await expect(generateMetadata({ params })).resolves.toEqual({});

    vi.mocked(getPublicBundle).mockResolvedValue(bundle);
    await expect(
      generateMetadata({ params: Promise.resolve({ lang: "fr", slug: "starter-bundle" }) }),
    ).resolves.toEqual({});
  });
});
