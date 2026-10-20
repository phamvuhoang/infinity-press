import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

import ReadBookPage from "@/app/[lang]/(reader)/read/[bookId]/page";
import { requireUser } from "@/lib/auth/session";
import { getReadableBook } from "@/lib/data/library";

vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/library", () => ({ getReadableBook: vi.fn() }));
vi.mock("@/lib/i18n/dictionary", () => ({ getDictionary: vi.fn().mockResolvedValue({ reader: {} }) }));
vi.mock("@/components/reader/reader-mount", () => ({
  ReaderMount: (props: Record<string, unknown>) => <output>{JSON.stringify(props)}</output>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as never);
  vi.mocked(getReadableBook).mockResolvedValue({
    acceptsQuestions: true,
    bookId: "book-id",
    title: "Reader title",
    publicationId: "publication-id",
    initialLocator: null,
    authorName: "Author",
    canonicalBookUrl: "https://books.example/en/books/reader-title",
    relatedBooks: [
      {
        title: "Related",
        authorName: "Other",
        href: "/en/books/related",
        coverUrl: null,
        publicationId: "related-publication-must-not-cross",
      },
    ],
    storageKey: "source-storage-key-must-not-cross",
  } as never);
});

it("authorizes independently and supplies only reader presentation attribution across the mount boundary", async () => {
  const html = renderToStaticMarkup(
    await ReadBookPage({ params: Promise.resolve({ lang: "en", bookId: "book-id" }) }),
  );

  expect(requireUser).toHaveBeenCalledWith("en", "/en/read/book-id");
  const props = html.replaceAll("&quot;", '"');
  expect(props).toContain('"authorName":"Author"');
  expect(props).toContain('"canonicalBookUrl":"https://books.example/en/books/reader-title"');
  expect(props).toContain('"relatedBooks":[{"title":"Related","authorName":"Other","href":"/en/books/related","coverUrl":null}]');
  expect(props).not.toContain("source-storage-key-must-not-cross");
  expect(props).not.toContain("related-publication-must-not-cross");
});
