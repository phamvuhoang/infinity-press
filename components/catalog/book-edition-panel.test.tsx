import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookEditionPanel } from "@/components/catalog/book-edition-panel";
import type { CatalogEditionOption } from "@/lib/catalog/public-types";
import en from "@/lib/i18n/dictionaries/en.json";
import viDictionary from "@/lib/i18n/dictionaries/vi.json";

const search = vi.hoisted(() => ({ value: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => search.value }));

const viewer = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/catalog/viewer-book-action", () => ({
  ViewerBookAction: (props: Record<string, unknown>) => {
    viewer.props = props;
    return <p data-testid="viewer-action">{String(props.editionId)}:{String(props.publicAction)}</p>;
  },
}));

const english: CatalogEditionOption = {
  editionId: "e-en",
  languageCode: "en",
  epubLanguage: "en",
  isDefault: true,
  offer: { offerId: "o-en", priceMinor: 129000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
  hasSample: false,
  record: null,
};
const japanese: CatalogEditionOption = {
  editionId: "e-ja",
  languageCode: "ja",
  epubLanguage: "ja",
  isDefault: false,
  offer: { offerId: "o-ja", priceMinor: 150000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
  hasSample: false,
  record: null,
};
const unpriced: CatalogEditionOption = { ...japanese, offer: null };

const buyAction = vi.fn(async () => undefined);
const getFreeAction = vi.fn(async () => undefined);
const props = {
  bookId: "book-1",
  bookPath: "/en/books/a-book",
  bookSlug: "a-book",
  locale: "en" as const,
  copy: en.catalog,
  paymentsEnabled: true,
  buyAction,
  getFreeAction,
  fallbackNotice: false,
  selectable: true,
};

beforeEach(() => {
  search.value = new URLSearchParams();
  viewer.props = null;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("BookEditionPanel", () => {
  it("shows the edition record, listing only the fields that have a value", () => {
    const record = { textSourceNote: "1912 edition", translationSource: null, rightsNote: null, territoryNote: null, textKind: "literal" as const, reviewScope: "full" as const, reviewedAt: null, versionNote: "Fixed chapter 3." };
    render(<BookEditionPanel {...props} copy={viDictionary.catalog} editions={[{ ...english, record }]} locale="vi" />);
    expect(screen.getByText("Về bản này")).toBeInTheDocument();
    expect(screen.getByText("Phạm vi review:").parentElement).toHaveTextContent("Phạm vi review: Toàn bộ");
    expect(screen.getByText("Loại văn bản:").parentElement).toHaveTextContent("Loại văn bản: Dịch sát");
    expect(screen.getByText("Ghi chú phiên bản:").parentElement).toHaveTextContent("Fixed chapter 3.");
    expect(screen.queryByText("Nguồn bản dịch:")).toBeNull();
  });

  it("has no edition record block when the edition states nothing", () => {
    render(<BookEditionPanel {...props} editions={[english]} />);
    expect(screen.queryByText("About this edition")).toBeNull();
  });

  it("shows the default edition, its price and its language", () => {
    render(<BookEditionPanel {...props} editions={[english, japanese]} />);
    expect(screen.getByTestId("viewer-action")).toHaveTextContent("e-en:buy");
    expect(screen.getAllByText(/129,000/).length).toBeGreaterThan(0);
    expect(screen.getByText("Ebook · English")).toBeInTheDocument();
  });

  it("lists the editions as links that change `?edition=` only, the default being the bare URL", () => {
    render(<BookEditionPanel {...props} editions={[english, japanese]} />);
    const nav = screen.getByRole("navigation", { name: "Language editions" });
    const links = [...nav.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/en/books/a-book", "/en/books/a-book?edition=e-ja"]);
    expect(links[0]).toHaveAttribute("aria-current", "true");
  });

  it("switches to the requested edition without touching the interface language", () => {
    search.value = new URLSearchParams({ edition: "e-ja" });
    render(<BookEditionPanel {...props} editions={[english, japanese]} />);
    expect(screen.getByTestId("viewer-action")).toHaveTextContent("e-ja:buy");
    expect(screen.getByText("Ebook · 日本語")).toBeInTheDocument();
    expect(viewer.props).toMatchObject({ locale: "en", editionId: "e-ja" });
  });

  it("binds the purchase to the edition, offer and price on screen", () => {
    search.value = new URLSearchParams({ edition: "e-ja" });
    render(<BookEditionPanel {...props} editions={[english, japanese]} />);
    (viewer.props!.buyAction as () => void)();
    (viewer.props!.getFreeAction as () => void)();
    expect(buyAction).toHaveBeenCalledWith("e-ja", "o-ja", 150000);
    expect(getFreeAction).toHaveBeenCalledWith("e-ja");
  });

  // The whole point: a stale or forged link must not put the default edition behind the button.
  it("offers no action at all for an edition the work does not list", () => {
    search.value = new URLSearchParams({ edition: "e-forged" });
    render(<BookEditionPanel {...props} editions={[english, japanese]} />);
    expect(screen.queryByTestId("viewer-action")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("That edition is not available");
    expect(screen.getByRole("navigation", { name: "Language editions" })).toBeInTheDocument();
  });

  it("says an edition without an offer is not on sale, and offers nothing to buy", () => {
    search.value = new URLSearchParams({ edition: "e-ja" });
    render(<BookEditionPanel {...props} editions={[english, unpriced]} />);
    expect(screen.getAllByText("Not on sale yet").length).toBeGreaterThan(0);
    expect(screen.getByTestId("viewer-action")).toHaveTextContent("e-ja:unavailable");
  });

  it("has no selector for a work with one edition", () => {
    render(<BookEditionPanel {...props} editions={[english]} />);
    expect(screen.queryByRole("navigation", { name: "Language editions" })).not.toBeInTheDocument();
  });

  it("ignores `?edition=` where one fixed edition is sold", () => {
    search.value = new URLSearchParams({ edition: "e-ja" });
    render(<BookEditionPanel {...props} editions={[english]} selectable={false} />);
    expect(screen.getByTestId("viewer-action")).toHaveTextContent("e-en:buy");
  });

  it("explains a fallback edition", () => {
    render(<BookEditionPanel {...props} editions={[english]} fallbackNotice locale="ja" />);
    expect(screen.getByText("There is no 日本語 edition yet. This is the English edition.")).toBeInTheDocument();
  });

  // The sample is per edition: the link names the edition on screen, so the Japanese sample opens
  // for the Japanese edition rather than the default's.
  it("links the sample of the edition on screen, and none where it has no sample", () => {
    search.value = new URLSearchParams({ edition: "e-ja" });
    render(<BookEditionPanel {...props} editions={[english, { ...japanese, hasSample: true }]} />);
    expect(screen.getByRole("link", { name: "Read a sample" })).toHaveAttribute("href", "/en/read-sample/a-book?edition=e-ja");
    cleanup();
    render(<BookEditionPanel {...props} editions={[english, japanese]} />);
    expect(screen.queryByRole("link", { name: "Read a sample" })).not.toBeInTheDocument();
  });

  it("shows coming soon while payments are off", () => {
    render(<BookEditionPanel {...props} editions={[english]} paymentsEnabled={false} />);
    expect(screen.getByTestId("viewer-action")).toHaveTextContent("e-en:coming_soon");
  });
});
