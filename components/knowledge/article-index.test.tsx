import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ArticleIndex } from "@/components/knowledge/article-index";
import type { KnowledgeArticleSummary } from "@/lib/knowledge/public-types";

afterEach(cleanup);

function article(slug: string, title: string, publishedAt: string, author = { name: "Mai Tran", slug: "mai-tran" as string | null }) {
  return {
    articleId: `id-${slug}`,
    slug,
    title,
    excerpt: `About ${title}`,
    publishedAt,
    updatedAt: publishedAt,
    alternateSlug: null,
    author,
  } satisfies KnowledgeArticleSummary;
}

const copy = { empty: "No articles have been published yet.", by: "By", published: "Published" };

describe("ArticleIndex", () => {
  it("lists articles newest first", () => {
    render(
      <ArticleIndex
        articles={[
          article("older", "Older piece", "2026-08-01T00:00:00+00:00"),
          article("newest", "Newest piece", "2026-09-20T00:00:00+00:00"),
          article("middle", "Middle piece", "2026-09-01T00:00:00+00:00"),
        ]}
        copy={copy}
        locale="en"
      />,
    );

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Newest piece",
      "Middle piece",
      "Older piece",
    ]);
  });

  it("shows each article's linked title, excerpt, author and published date", () => {
    render(
      <ArticleIndex
        articles={[
          article("mua-thu", "Mùa thu đọc sách", "2026-09-20T03:00:00+00:00", { name: "Mai Trần", slug: "mai-tran" }),
          article("khach", "Bài của khách", "2026-09-10T03:00:00+00:00", { name: "Khách mời", slug: null }),
        ]}
        copy={{ empty: "Chưa có bài viết nào được xuất bản.", by: "Tác giả", published: "Ngày xuất bản" }}
        locale="vi"
      />,
    );

    const [first, second] = screen.getAllByRole("listitem");
    expect(within(first).getByRole("link", { name: "Mùa thu đọc sách" })).toHaveAttribute("href", "/vi/articles/mua-thu");
    expect(within(first).getByText("About Mùa thu đọc sách")).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: "Mai Trần" })).toHaveAttribute("href", "/vi/authors/mai-tran");
    expect(first.querySelector("time")).toHaveAttribute("dateTime", "2026-09-20T03:00:00+00:00");
    expect(first.querySelector("time")).toHaveTextContent("2026");

    // An author without a public page in this locale is a plain byline, not a broken link.
    expect(within(second).getByText(/Khách mời/)).toBeInTheDocument();
    expect(within(second).queryByRole("link", { name: "Khách mời" })).not.toBeInTheDocument();
  });

  it("says so when nothing is published", () => {
    render(<ArticleIndex articles={[]} copy={copy} locale="en" />);

    expect(screen.getByText("No articles have been published yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
