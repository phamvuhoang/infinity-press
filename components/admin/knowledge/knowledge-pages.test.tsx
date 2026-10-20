import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdminArticlePage from "@/app/admin/articles/[articleId]/page";
import NewArticlePage from "@/app/admin/articles/new/page";
import AdminArticlesPage from "@/app/admin/articles/page";
import AdminIdeaPage from "@/app/admin/ideas/[ideaId]/page";
import NewIdeaPage from "@/app/admin/ideas/new/page";
import AdminIdeasPage from "@/app/admin/ideas/page";
import { KnowledgeEditPage, KnowledgeListPage } from "@/components/admin/knowledge/knowledge-pages";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminKnowledge, listAdminKnowledge, type AdminKnowledgeDTO } from "@/lib/data/admin-knowledge";
import { listAdminBooks } from "@/lib/data/books";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/admin-knowledge", () => ({ getAdminKnowledge: vi.fn(), listAdminKnowledge: vi.fn() }));
vi.mock("@/lib/data/books", () => ({ listAdminBooks: vi.fn() }));
vi.mock("@/lib/data/catalog-entities", () => ({ listCatalogEntityOptions: vi.fn() }));
vi.mock("@/app/admin/knowledge/actions", () => ({
  createIdeaAction: vi.fn(),
  createArticleAction: vi.fn(),
  updateArticleDetailsAction: vi.fn(),
  saveIdeaLocalizationAction: vi.fn(),
  saveArticleLocalizationAction: vi.fn(),
  saveKnowledgeSeoAction: vi.fn(),
  setIdeaRelationsAction: vi.fn(),
  setArticleRelationsAction: vi.fn(),
  publishKnowledgeAction: vi.fn(),
  unpublishKnowledgeAction: vi.fn(),
}));
vi.mock("@/app/admin/knowledge/image-actions", () => ({ createKnowledgeImageUploadAction: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));

const ideaId = "5a1b2c3d-0000-4000-8000-000000000001";
const otherIdea = "5a1b2c3d-0000-4000-8000-000000000002";
const thirdIdea = "5a1b2c3d-0000-4000-8000-000000000003";
const articleId = "5a1b2c3d-0000-4000-8000-0000000000a0";
const authorId = "5a1b2c3d-0000-4000-8000-0000000000a1";
const bookA = "5a1b2c3d-0000-4000-8000-0000000000b1";
const bookB = "5a1b2c3d-0000-4000-8000-0000000000b2";

const idea: AdminKnowledgeDTO = {
  kind: "idea",
  id: ideaId,
  status: "draft",
  localizations: [
    {
      id: "loc-vi",
      locale: "vi",
      slug: "doc-cham",
      question: "Vì sao nên đọc chậm?",
      shortAnswer: "Để nhớ lâu.",
      bodyBlocks: [],
      storedBlocksReadable: true,
      seoTitle: "Đọc chậm",
      seoDescription: null,
      updatedAt: "2026-09-02T00:00:00Z",
    },
  ],
  bookIds: [bookB, bookA],
  topicIds: ["topic-b"],
  relatedIdeaIds: [thirdIdea, otherIdea],
  readinessIssues: ["missing_blocks"],
};

const article: AdminKnowledgeDTO = {
  kind: "article",
  id: articleId,
  status: "published",
  authorId,
  publishedAt: "2026-09-03T00:00:00Z",
  localizations: [],
  bookIds: [bookA],
  ideaIds: [otherIdea, ideaId],
  topicIds: [],
  readinessIssues: [],
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(listAdminBooks).mockResolvedValue([
    { id: bookA, canonicalKey: "a", title: "Sách một", authorName: "A", status: "published", hasActivePublication: true, readinessIssues: [] },
    { id: bookB, canonicalKey: "b", title: "Sách hai", authorName: "B", status: "draft", hasActivePublication: false, readinessIssues: [] },
  ]);
  vi.mocked(listCatalogEntityOptions).mockImplementation(async (type) =>
    type === "author"
      ? [{ id: authorId, name: "Tác giả", canonicalSlug: "tac-gia" }]
      : [
          { id: "topic-a", name: "Thói quen", canonicalSlug: "thoi-quen" },
          { id: "topic-b", name: "Trí nhớ", canonicalSlug: "tri-nho" },
        ],
  );
  vi.mocked(listAdminKnowledge).mockResolvedValue([
    { kind: "idea", id: ideaId, title: "Vì sao nên đọc chậm?", status: "draft", locales: ["vi"], readinessIssues: ["missing_blocks"] },
    { kind: "idea", id: otherIdea, title: "Vì sao nên ghi chép?", status: "published", locales: ["vi", "en"], readinessIssues: [] },
    { kind: "idea", id: thirdIdea, title: "Đọc lại có ích không?", status: "draft", locales: [], readinessIssues: [] },
  ]);
});

describe("route files", () => {
  const routes: [string, () => Promise<unknown>][] = [
    ["/admin/ideas", () => AdminIdeasPage()],
    ["/admin/ideas/new", () => NewIdeaPage()],
    [`/admin/ideas/${ideaId}`, () => AdminIdeaPage({ params: Promise.resolve({ ideaId }) })],
    ["/admin/articles", () => AdminArticlesPage()],
    ["/admin/articles/new", () => NewArticlePage()],
    [`/admin/articles/${articleId}`, () => AdminArticlePage({ params: Promise.resolve({ articleId }) })],
  ];

  it.each(routes)("%s authorizes at the page boundary before any shared renderer reads data", async (path, page) => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(page()).rejects.toThrow("NEXT_FORBIDDEN");

    expect(requireAdmin).toHaveBeenCalledWith({ next: path });
    expect(getAdminKnowledge).not.toHaveBeenCalled();
    expect(listAdminKnowledge).not.toHaveBeenCalled();
    expect(listAdminBooks).not.toHaveBeenCalled();
    expect(listCatalogEntityOptions).not.toHaveBeenCalled();
  });

  it.each([
    ["idea", () => AdminIdeaPage({ params: Promise.resolve({ ideaId }) }), ideaId],
    ["article", () => AdminArticlePage({ params: Promise.resolve({ articleId }) }), articleId],
  ] as const)("hands an authorized %s route to the shared editor with its kind and id", async (kind, page, id) => {
    const element = (await page()) as ReactElement<{ kind: string; id: string }>;

    expect(element.type).toBe(KnowledgeEditPage);
    expect(element.props).toEqual({ kind, id });
  });
});

describe("KnowledgeListPage", () => {
  it("lists ideas with status, locale coverage, and readiness", async () => {
    render(await KnowledgeListPage({ kind: "idea" }));

    expect(listAdminKnowledge).toHaveBeenCalledWith("idea");
    expect(screen.getByRole("link", { name: "New idea" })).toHaveAttribute("href", "/admin/ideas/new");
    const row = screen.getByRole("row", { name: /Vì sao nên ghi chép/ });
    expect(within(row).getByRole("link")).toHaveAttribute("href", `/admin/ideas/${otherIdea}`);
    expect(row).toHaveTextContent("published");
    expect(row).toHaveTextContent("vi, en");
    expect(row).toHaveTextContent("Ready to publish");
    const draft = screen.getByRole("row", { name: /Vì sao nên đọc chậm/ });
    expect(within(draft).getByText("1 to fix")).toHaveAttribute("title", "Add at least one content block to a complete localization.");
    expect(screen.getByRole("row", { name: /Đọc lại/ })).toHaveTextContent("—");
  });

  it("links articles under /admin/articles", async () => {
    vi.mocked(listAdminKnowledge).mockResolvedValue([
      { kind: "article", id: articleId, title: "Đọc chậm", status: "draft", locales: ["vi"], readinessIssues: [] },
    ]);

    render(await KnowledgeListPage({ kind: "article" }));

    expect(screen.getByRole("link", { name: "Đọc chậm" })).toHaveAttribute("href", `/admin/articles/${articleId}`);
    expect(screen.getByRole("columnheader", { name: "Title" })).toBeInTheDocument();
  });
});

describe("KnowledgeEditPage", () => {
  it("exposes anchored Details, Localizations, Relations, SEO, and Publish sections for an idea", async () => {
    vi.mocked(getAdminKnowledge).mockResolvedValue(idea);

    const { container } = render(await KnowledgeEditPage({ kind: "idea", id: ideaId }));

    for (const id of ["details", "localizations", "relations", "seo", "publish"]) {
      expect(container.querySelector(`section#${id}`)).not.toBeNull();
      expect(container.querySelector(`nav a[href='#${id}']`)).not.toBeNull();
    }
    // Details are immutable for an idea: its id and status, no author.
    const details = within(container.querySelector<HTMLElement>("section#details")!);
    expect(details.getByText(ideaId)).toBeInTheDocument();
    expect(details.queryByLabelText("Author")).not.toBeInTheDocument();
    for (const label of ["Question (vi)", "Short answer (vi)", "Slug (vi)", "Question (en)", "SEO title (vi)", "SEO description (en)"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("SEO title (vi)")).toHaveValue("Đọc chậm");
    for (const name of ["Save vi content", "Save en content", "Save relations", "Save vi SEO", "Save en SEO"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Publish idea" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Add at least one content block to a complete localization." })).toHaveAttribute(
      "href",
      "#localizations",
    );
  });

  it("keeps the idea's ordered books and related ideas, and never offers the idea itself", async () => {
    vi.mocked(getAdminKnowledge).mockResolvedValue(idea);

    const { container } = render(await KnowledgeEditPage({ kind: "idea", id: ideaId }));

    const values = (name: string) =>
      [...container.querySelectorAll<HTMLInputElement>(`input[type='hidden'][name='${name}']`)].map((input) => input.value);
    expect(values("bookIds")).toEqual([bookB, bookA]);
    expect(values("relatedIdeaIds")).toEqual([thirdIdea, otherIdea]);
    expect(screen.getByLabelText("Trí nhớ")).toBeChecked();
    expect(screen.getByLabelText("Thói quen")).not.toBeChecked();
    const relations = within(container.querySelector<HTMLElement>("section#relations")!);
    const ideaChoices = Array.from(relations.getByLabelText<HTMLSelectElement>("Add an idea").options).map((option) => option.value);
    expect(ideaChoices).not.toContain(ideaId);
    expect(listAdminKnowledge).toHaveBeenCalledWith("idea");
    // Authors are only loaded for articles.
    expect(listCatalogEntityOptions).not.toHaveBeenCalledWith("author");
  });

  it("gives an article an author selection and its own relation fields", async () => {
    vi.mocked(getAdminKnowledge).mockResolvedValue(article);

    const { container } = render(await KnowledgeEditPage({ kind: "article", id: articleId }));

    expect(screen.getByLabelText("Author")).toHaveValue(authorId);
    expect(screen.getByRole("button", { name: "Save details" })).toBeInTheDocument();
    expect(screen.getByText("2026-09-03T00:00:00Z")).toBeInTheDocument();
    expect(screen.getByLabelText("Title (vi)")).toBeInTheDocument();
    expect(screen.getByLabelText("Excerpt (en)")).toBeInTheDocument();
    const ideaIds = [...container.querySelectorAll<HTMLInputElement>("input[type='hidden'][name='ideaIds']")].map((input) => input.value);
    expect(ideaIds).toEqual([otherIdea, ideaId]);
    expect(screen.getByRole("button", { name: "Unpublish article" })).toBeEnabled();
    expect(screen.getAllByText(/Save the (vi|en) content first/)).toHaveLength(2);
  });
});
