import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ReadBookPage from "./page";
import { requireUser } from "@/lib/auth/session";
import { getOwnedEditionsOfBook } from "@/lib/data/library";

vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/library", () => ({ getOwnedEditionsOfBook: vi.fn() }));
vi.mock("@/lib/i18n/dictionary", async () => ({
  getDictionary: async () => (await import("@/lib/i18n/dictionaries/en.json")).default,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

const bookId = "30000000-0000-0000-0000-000000000001";
const props = (lang: string) => ({ params: Promise.resolve({ lang, bookId }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
});

describe("the legacy /read/{bookId} deep link", () => {
  it("authorizes before resolving anything", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT /en/sign-in"));
    await expect(ReadBookPage(props("en"))).rejects.toThrow("NEXT_REDIRECT /en/sign-in");
    expect(getOwnedEditionsOfBook).not.toHaveBeenCalled();
  });

  it("sends a reader who owns one edition straight to it, whatever the interface language", async () => {
    vi.mocked(getOwnedEditionsOfBook).mockResolvedValue([{ editionId: "ed-1", languageCode: "ja", title: "Book" }]);
    await expect(ReadBookPage(props("vi"))).rejects.toThrow("NEXT_REDIRECT /vi/read/editions/ed-1");
  });

  it("asks which edition when the reader owns several, never choosing by interface language", async () => {
    vi.mocked(getOwnedEditionsOfBook).mockResolvedValue([
      { editionId: "ed-en", languageCode: "en", title: "Book" },
      { editionId: "ed-ja", languageCode: "ja", title: "Book" },
    ]);
    render(await ReadBookPage(props("en")));

    expect(screen.getByRole("heading", { level: 1, name: "Choose an edition to read" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /English/ })).toHaveAttribute("href", "/en/read/editions/ed-en");
    expect(screen.getByRole("link", { name: /Japanese/ })).toHaveAttribute("href", "/en/read/editions/ed-ja");
  });

  it("is a 404 for a reader who owns none, so a stranger cannot tell the work exists", async () => {
    vi.mocked(getOwnedEditionsOfBook).mockResolvedValue([]);
    await expect(ReadBookPage(props("en"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is a 404 for an unsupported locale", async () => {
    await expect(ReadBookPage(props("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
