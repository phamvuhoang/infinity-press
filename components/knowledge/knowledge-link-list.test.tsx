import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ideaLinkItems, KnowledgeLinkList } from "@/components/knowledge/knowledge-link-list";

afterEach(cleanup);

describe("KnowledgeLinkList", () => {
  it("links each idea and article to its localized canonical path, in the given order", () => {
    render(
      <KnowledgeLinkList
        items={[
          { kind: "idea", slug: "vi-sao-doc", title: "Vì sao nên đọc?", excerpt: "Để nghĩ chậm lại.", publishedAt: null },
          { kind: "article", slug: "mua-thu", title: "Mùa thu đọc sách", excerpt: "Một danh sách.", publishedAt: null },
        ]}
        locale="vi"
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Vì sao nên đọc?", "/vi/ideas/vi-sao-doc"],
      ["Mùa thu đọc sách", "/vi/articles/mua-thu"],
    ]);
    expect(screen.getByText("Để nghĩ chậm lại.")).toBeInTheDocument();
    expect(screen.getByText("Một danh sách.")).toBeInTheDocument();
  });

  it("shows a publication date only where there is one", () => {
    const { container } = render(
      <KnowledgeLinkList
        items={[
          { kind: "article", slug: "autumn", title: "Autumn reading", excerpt: "A list.", publishedAt: "2026-09-20T03:00:00+00:00" },
          { kind: "idea", slug: "why-read", title: "Why read?", excerpt: "To slow down.", publishedAt: null },
        ]}
        locale="en"
      />,
    );

    const times = container.querySelectorAll("time");
    expect(times).toHaveLength(1);
    expect(times[0]).toHaveAttribute("dateTime", "2026-09-20T03:00:00+00:00");
    expect(times[0]).toHaveTextContent("Sep 20, 2026");
  });

  it("labels each item's kind when the list mixes ideas and articles", () => {
    render(
      <KnowledgeLinkList
        items={[
          { kind: "idea", slug: "why-read", title: "Why read?", excerpt: "To slow down.", publishedAt: null },
          { kind: "article", slug: "autumn", title: "Autumn reading", excerpt: "A list.", publishedAt: null },
        ]}
        kindLabels={{ idea: "Idea", article: "Article" }}
        locale="en"
      />,
    );

    const [idea, article] = screen.getAllByRole("listitem");
    expect(within(idea).getByText("Idea")).toBeInTheDocument();
    expect(within(article).getByText("Article")).toBeInTheDocument();
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<KnowledgeLinkList items={[]} locale="en" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ideaLinkItems", () => {
  it("uses the question as the link text and the short answer as the excerpt", () => {
    expect(
      ideaLinkItems([{ ideaId: "i-1", slug: "why-read", question: "Why read?", shortAnswer: "To slow down." }]),
    ).toEqual([{ kind: "idea", slug: "why-read", title: "Why read?", excerpt: "To slow down.", publishedAt: null }]);
  });
});
