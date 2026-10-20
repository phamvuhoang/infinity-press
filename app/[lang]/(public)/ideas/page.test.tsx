import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import IdeasPage, { generateMetadata } from "@/app/[lang]/(public)/ideas/page";
import { getServerEnv } from "@/lib/config/server-env";
import { getIdeaIndex } from "@/lib/data/knowledge";
import type { KnowledgeIdeaSummary } from "@/lib/knowledge/public-types";

const header = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/site-header", () => ({
  SiteHeader: (props: Record<string, unknown>) => {
    header.props = props;
    return null;
  },
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/config/build-environment", () => ({ deferPrerenderWithoutServerEnv: vi.fn(async () => {}) }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/knowledge", () => ({ getIdeaIndex: vi.fn() }));

function idea(slug: string, question: string): KnowledgeIdeaSummary {
  return {
    ideaId: `id-${slug}`,
    slug,
    question,
    shortAnswer: `Answer to ${question}`,
    createdAt: "2026-09-01T00:00:00+00:00",
    updatedAt: "2026-09-02T00:00:00+00:00",
    alternateSlugs: {},
    topics: [],
  };
}

const params = Promise.resolve({ lang: "en" });

beforeEach(() => {
  vi.clearAllMocks();
  header.props = null;
  vi.mocked(getServerEnv).mockReturnValue({ siteUrl: "https://books.example" } as ReturnType<typeof getServerEnv>);
  vi.mocked(getIdeaIndex).mockResolvedValue([
    { topic: { slug: "habits", name: "Habits" }, ideas: [idea("streaks", "Do streaks help?")] },
    { topic: null, ideas: [idea("loose", "A loose question?")] },
  ]);
});

afterEach(cleanup);

describe("IdeasPage", () => {
  it("404s on an unsupported locale without reading anything", async () => {
    await expect(IdeasPage({ params: Promise.resolve({ lang: "fr" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getIdeaIndex).not.toHaveBeenCalled();
  });

  it("renders one heading and the ideas grouped by topic, with the localized Other group", async () => {
    render(await IdeasPage({ params: Promise.resolve({ lang: "vi" }) }));

    expect(getIdeaIndex).toHaveBeenCalledWith("vi");
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["Ý tưởng"]);
    expect(within(screen.getByRole("region", { name: "Habits" })).getByRole("link", { name: "Do streaks help?" })).toHaveAttribute(
      "href",
      "/vi/ideas/streaks",
    );
    expect(within(screen.getByRole("region", { name: "Khác" })).getByRole("link", { name: "A loose question?" })).toHaveAttribute(
      "href",
      "/vi/ideas/loose",
    );
  });

  it("marks Ideas current and switches language to the other locale's idea index", async () => {
    render(await IdeasPage({ params }));

    expect(header.props).toMatchObject({ locale: "en", current: "ideas", alternates: { vi: "/vi/ideas" } });
  });

  it("shows the empty state when nothing is published", async () => {
    vi.mocked(getIdeaIndex).mockResolvedValue([]);
    render(await IdeasPage({ params }));

    expect(screen.getByText("No ideas have been published yet.")).toBeInTheDocument();
  });
});

describe("generateMetadata", () => {
  it("uses the fixed index copy and every locale path", async () => {
    const metadata = await generateMetadata({ params });

    expect(metadata.title).toBe("Ideas");
    expect(metadata.description).toMatch(/Short answers/);
    expect(metadata.alternates).toEqual({
      canonical: "https://books.example/en/ideas",
      languages: {
        vi: "https://books.example/vi/ideas",
        en: "https://books.example/en/ideas",
        ja: "https://books.example/ja/ideas",
        "x-default": "https://books.example/en/ideas",
      },
    });
  });

  it("is empty for an unsupported locale", async () => {
    await expect(generateMetadata({ params: Promise.resolve({ lang: "fr" }) })).resolves.toEqual({});
  });
});
