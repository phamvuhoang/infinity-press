// @vitest-environment node
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createArticleAction,
  createIdeaAction,
  publishKnowledgeAction,
  saveArticleLocalizationAction,
  saveIdeaLocalizationAction,
  saveKnowledgeSeoAction,
  setArticleRelationsAction,
  setIdeaRelationsAction,
  unpublishKnowledgeAction,
  updateArticleDetailsAction,
} from "@/app/admin/knowledge/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import {
  createArticle,
  createIdea,
  DuplicateKnowledgeSlugError,
  KnowledgeLocalizationMissingError,
  KnowledgeNotFoundError,
  KnowledgeNotReadyError,
  KnowledgeReferenceNotFoundError,
  publishKnowledge,
  saveArticleLocalization,
  saveIdeaLocalization,
  saveKnowledgeSeo,
  setArticleRelations,
  setIdeaRelations,
  unpublishKnowledge,
  updateArticleDetails,
} from "@/lib/data/admin-knowledge";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/data/admin-knowledge", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/admin-knowledge")>();
  return {
    ...original,
    createIdea: vi.fn(),
    createArticle: vi.fn(),
    updateArticleDetails: vi.fn(),
    saveIdeaLocalization: vi.fn(),
    saveArticleLocalization: vi.fn(),
    saveKnowledgeSeo: vi.fn(),
    setIdeaRelations: vi.fn(),
    setArticleRelations: vi.fn(),
    publishKnowledge: vi.fn(),
    unpublishKnowledge: vi.fn(),
  };
});

const ideaId = "5a1b2c3d-0000-4000-8000-000000000001";
const otherIdea = "5a1b2c3d-0000-4000-8000-000000000002";
const articleId = "5a1b2c3d-0000-4000-8000-0000000000a0";
const authorId = "5a1b2c3d-0000-4000-8000-0000000000a1";
const bookA = "5a1b2c3d-0000-4000-8000-0000000000b1";
const bookB = "5a1b2c3d-0000-4000-8000-0000000000b2";
const topicA = "5a1b2c3d-0000-4000-8000-0000000000c1";
const ideaPath = `/admin/ideas/${ideaId}`;
const articlePath = `/admin/articles/${articleId}`;
const paragraph = { type: "paragraph", content: [{ text: "Đọc chậm lại." }] };

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

function expectHubRevalidated(detail: string) {
  expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
  expect(revalidatePath).toHaveBeenCalledWith("/sitemap.xml");
  expect(revalidatePath).toHaveBeenCalledWith("/admin/ideas");
  expect(revalidatePath).toHaveBeenCalledWith("/admin/articles");
  expect(revalidatePath).toHaveBeenCalledWith(detail);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("every action authorizes before parsing or writing", () => {
  const denied = new Error("NEXT_FORBIDDEN");
  const cases: [string, string, () => Promise<unknown>, () => unknown][] = [
    ["createIdeaAction", "/admin/ideas/new", () => createIdeaAction(initialAdminFormState, form({})), () => createIdea],
    ["createArticleAction", "/admin/articles/new", () => createArticleAction(initialAdminFormState, form({})), () => createArticle],
    [
      "updateArticleDetailsAction",
      articlePath,
      () => updateArticleDetailsAction(articleId, initialAdminFormState, form({ authorId })),
      () => updateArticleDetails,
    ],
    [
      "saveIdeaLocalizationAction",
      ideaPath,
      () => saveIdeaLocalizationAction(ideaId, "vi", initialAdminFormState, form({})),
      () => saveIdeaLocalization,
    ],
    [
      "saveArticleLocalizationAction",
      articlePath,
      () => saveArticleLocalizationAction(articleId, "vi", initialAdminFormState, form({})),
      () => saveArticleLocalization,
    ],
    [
      "saveKnowledgeSeoAction",
      ideaPath,
      () => saveKnowledgeSeoAction("idea", ideaId, "vi", initialAdminFormState, form({})),
      () => saveKnowledgeSeo,
    ],
    ["setIdeaRelationsAction", ideaPath, () => setIdeaRelationsAction(ideaId, initialAdminFormState, form({})), () => setIdeaRelations],
    [
      "setArticleRelationsAction",
      articlePath,
      () => setArticleRelationsAction(articleId, initialAdminFormState, form({})),
      () => setArticleRelations,
    ],
    ["publishKnowledgeAction", articlePath, () => publishKnowledgeAction("article", articleId), () => publishKnowledge],
    ["unpublishKnowledgeAction", ideaPath, () => unpublishKnowledgeAction("idea", ideaId), () => unpublishKnowledge],
  ];

  it.each(cases)("%s", async (_name, next, call, write) => {
    vi.mocked(requireAdmin).mockRejectedValue(denied);

    await expect(call()).rejects.toBe(denied);

    expect(requireAdmin).toHaveBeenCalledWith({ next });
    expect(write()).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("create actions", () => {
  it("creates an idea, revalidates, then redirects to its editor", async () => {
    vi.mocked(createIdea).mockResolvedValue({ id: ideaId });

    await expect(
      createIdeaAction(
        initialAdminFormState,
        form({ locale: "vi", slug: "doc-cham", question: "Vì sao?", shortAnswer: "Vì vậy." }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(createIdea).toHaveBeenCalledWith({ locale: "vi", slug: "doc-cham", question: "Vì sao?", shortAnswer: "Vì vậy." });
    expectHubRevalidated(ideaPath);
    expect(redirect).toHaveBeenCalledWith(ideaPath);
    // Revalidation happens before the redirect throws.
    expect(vi.mocked(revalidatePath).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(redirect).mock.invocationCallOrder[0]);
  });

  it("creates an article with its author", async () => {
    vi.mocked(createArticle).mockResolvedValue({ id: articleId });

    await expect(
      createArticleAction(
        initialAdminFormState,
        form({ authorId, locale: "en", slug: "slow", title: "Slow", excerpt: "Why." }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(createArticle).toHaveBeenCalledWith({ authorId, locale: "en", slug: "slow", title: "Slow", excerpt: "Why." });
    expect(redirect).toHaveBeenCalledWith(articlePath);
  });

  it.each([
    ["an invalid locale", { locale: "fr" }, "locale"],
    ["a malformed slug", { slug: "Vì sao" }, "slug"],
    ["HTML in the question", { question: "<b>Q</b>" }, "question"],
  ])("rejects %s without a write or redirect", async (_label, override, field) => {
    const result = await createIdeaAction(
      initialAdminFormState,
      form({ locale: "vi", slug: "doc-cham", question: "Q", shortAnswer: "A", ...override }),
    );

    expect(result.fieldErrors[field]).toBeTruthy();
    expect(createIdea).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("puts a duplicate slug on the slug field", async () => {
    vi.mocked(createIdea).mockRejectedValue(new DuplicateKnowledgeSlugError());

    const result = await createIdeaAction(initialAdminFormState, form({ locale: "vi", slug: "taken", question: "Q", shortAnswer: "A" }));

    expect(result).toEqual({ fieldErrors: { slug: "This slug is already used in this language." }, formError: null, savedAt: null });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("puts a missing author on the author field", async () => {
    vi.mocked(createArticle).mockRejectedValue(new KnowledgeReferenceNotFoundError());

    const result = await createArticleAction(
      initialAdminFormState,
      form({ authorId, locale: "en", slug: "slow", title: "Slow", excerpt: "Why." }),
    );

    expect(result.fieldErrors.authorId).toBeTruthy();
  });

  it("hides unknown database text", async () => {
    vi.mocked(createIdea).mockRejectedValue(new Error("relation ideas does not exist"));

    const result = await createIdeaAction(initialAdminFormState, form({ locale: "vi", slug: "a", question: "Q", shortAnswer: "A" }));

    expect(result).toEqual({ fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null });
  });
});

describe("localization actions", () => {
  const ideaForm = (overrides: Record<string, string> = {}) =>
    form({ slug: "doc-cham", question: "Vì sao?", shortAnswer: "Vì vậy.", bodyBlocks: JSON.stringify([paragraph]), ...overrides });

  it("saves the locale bound by the server with parsed typed blocks", async () => {
    const result = await saveIdeaLocalizationAction(ideaId, "en", initialAdminFormState, ideaForm({ locale: "vi" }));

    expect(saveIdeaLocalization).toHaveBeenCalledWith(ideaId, {
      locale: "en",
      slug: "doc-cham",
      question: "Vì sao?",
      shortAnswer: "Vì vậy.",
      bodyBlocks: [paragraph],
    });
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(redirect).not.toHaveBeenCalled();
    expectHubRevalidated(ideaPath);
  });

  it("saves an article localization", async () => {
    await saveArticleLocalizationAction(
      articleId,
      "vi",
      initialAdminFormState,
      form({ slug: "doc-cham", title: "Đọc chậm", excerpt: "Tóm tắt.", bodyBlocks: "[]" }),
    );

    expect(saveArticleLocalization).toHaveBeenCalledWith(articleId, {
      locale: "vi",
      slug: "doc-cham",
      title: "Đọc chậm",
      excerpt: "Tóm tắt.",
      bodyBlocks: [],
    });
    expectHubRevalidated(articlePath);
  });

  it.each([
    ["malformed JSON", "{", "bodyBlocks"],
    ["an HTML string", "<p>x</p>", "bodyBlocks"],
    ["an HTML run", JSON.stringify([{ type: "paragraph", content: [{ text: "<i>x</i>" }] }]), "bodyBlocks.0.content.0.text"],
    ["an unknown block", JSON.stringify([{ type: "embed", src: "x" }]), "bodyBlocks.0.type"],
  ])("rejects %s without a write", async (_label, bodyBlocks, key) => {
    const result = await saveIdeaLocalizationAction(ideaId, "vi", initialAdminFormState, ideaForm({ bodyBlocks }));

    expect(Object.keys(result.fieldErrors)).toContain(key);
    expect(saveIdeaLocalization).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // Regression: the block schema only checks an image key's shape, so a crafted post could attach
  // an image uploaded for another idea or article. The key must sit under this entity's own prefix.
  describe("image ownership", () => {
    const imageId = "5a1b2c3d-0000-4000-8000-0000000000e1";
    const image = (storageKey: string) => ({ type: "image", storageKey, alt: "Ảnh", width: 800, height: 600 });
    const own = (kind: "ideas" | "articles", id: string) => `knowledge/${kind}/${id}/${imageId}.png`;
    const articleForm = (bodyBlocks: unknown[]) =>
      form({ slug: "doc-cham", title: "Đọc chậm", excerpt: "Tóm tắt.", bodyBlocks: JSON.stringify(bodyBlocks) });

    it.each([
      ["another idea", own("ideas", otherIdea)],
      ["an article with the same id", own("articles", ideaId)],
    ])("refuses an idea image uploaded for %s without a write", async (_label, storageKey) => {
      const result = await saveIdeaLocalizationAction(
        ideaId,
        "vi",
        initialAdminFormState,
        ideaForm({ bodyBlocks: JSON.stringify([paragraph, image(storageKey)]) }),
      );

      expect(result).toEqual({
        fieldErrors: { "bodyBlocks.1.storageKey": "Upload the image through this editor." },
        formError: null,
        savedAt: null,
      });
      expect(saveIdeaLocalization).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("refuses an article image uploaded for another entity without a write", async () => {
      const result = await saveArticleLocalizationAction(
        articleId,
        "vi",
        initialAdminFormState,
        articleForm([image(own("articles", articleId)), image(own("ideas", articleId))]),
      );

      expect(result.fieldErrors).toEqual({ "bodyBlocks.1.storageKey": "Upload the image through this editor." });
      expect(saveArticleLocalization).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("accepts images under the edited entity's own prefix, whatever the bound id's case", async () => {
      await saveIdeaLocalizationAction(
        ideaId.toUpperCase(),
        "vi",
        initialAdminFormState,
        ideaForm({ bodyBlocks: JSON.stringify([image(own("ideas", ideaId))]) }),
      );
      expect(saveIdeaLocalization).toHaveBeenCalledTimes(1);

      await saveArticleLocalizationAction(articleId, "en", initialAdminFormState, articleForm([image(own("articles", articleId))]));
      expect(saveArticleLocalization).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a locale the server did not bind to a supported language", async () => {
    const result = await saveIdeaLocalizationAction(ideaId, "fr" as "vi", initialAdminFormState, ideaForm());

    expect(result.fieldErrors.locale).toBeTruthy();
    expect(saveIdeaLocalization).not.toHaveBeenCalled();
  });

  it("maps a duplicate slug to the slug field and a missing entry to a form error", async () => {
    vi.mocked(saveIdeaLocalization).mockRejectedValueOnce(new DuplicateKnowledgeSlugError());
    expect((await saveIdeaLocalizationAction(ideaId, "vi", initialAdminFormState, ideaForm())).fieldErrors.slug).toBe(
      "This slug is already used in this language.",
    );

    vi.mocked(saveIdeaLocalization).mockRejectedValueOnce(new KnowledgeNotFoundError());
    expect(await saveIdeaLocalizationAction(ideaId, "vi", initialAdminFormState, ideaForm())).toEqual({
      fieldErrors: {},
      formError: "This entry no longer exists.",
      savedAt: null,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("details and SEO actions", () => {
  it("changes an article's author", async () => {
    await updateArticleDetailsAction(articleId, initialAdminFormState, form({ authorId }));

    expect(updateArticleDetails).toHaveBeenCalledWith(articleId, { authorId });
    expectHubRevalidated(articlePath);
  });

  it("rejects a malformed author id", async () => {
    const result = await updateArticleDetailsAction(articleId, initialAdminFormState, form({ authorId: "x" }));

    expect(result.fieldErrors.authorId).toBeTruthy();
    expect(updateArticleDetails).not.toHaveBeenCalled();
  });

  it("saves blank SEO fields as null for the bound locale", async () => {
    await saveKnowledgeSeoAction("article", articleId, "en", initialAdminFormState, form({ seoTitle: " ", seoDescription: "Desc" }));

    expect(saveKnowledgeSeo).toHaveBeenCalledWith("article", articleId, { locale: "en", seoTitle: null, seoDescription: "Desc" });
    expectHubRevalidated(articlePath);
  });

  it("explains SEO saved before its localization exists", async () => {
    vi.mocked(saveKnowledgeSeo).mockRejectedValue(new KnowledgeLocalizationMissingError());

    const result = await saveKnowledgeSeoAction("idea", ideaId, "en", initialAdminFormState, form({ seoTitle: "T" }));

    expect(result.formError).toBe("Save this language's content before its SEO.");
  });

  it("refuses an unknown kind without a write", async () => {
    const result = await saveKnowledgeSeoAction("book" as "idea", ideaId, "vi", initialAdminFormState, form({ seoTitle: "T" }));

    expect(result.formError).toBeTruthy();
    expect(saveKnowledgeSeo).not.toHaveBeenCalled();
  });
});

describe("relation actions", () => {
  it("posts idea relations in the submitted order", async () => {
    await setIdeaRelationsAction(
      ideaId,
      initialAdminFormState,
      form({ bookIds: [bookB, bookA], topicIds: [topicA], relatedIdeaIds: [otherIdea] }),
    );

    expect(setIdeaRelations).toHaveBeenCalledWith(ideaId, { bookIds: [bookB, bookA], topicIds: [topicA], relatedIdeaIds: [otherIdea] });
    expectHubRevalidated(ideaPath);
  });

  it("posts article relations in the submitted order", async () => {
    await setArticleRelationsAction(articleId, initialAdminFormState, form({ bookIds: [bookA], ideaIds: [otherIdea, ideaId] }));

    expect(setArticleRelations).toHaveBeenCalledWith(articleId, { bookIds: [bookA], ideaIds: [otherIdea, ideaId], topicIds: [] });
  });

  it.each([
    ["a repeated book", { bookIds: [bookA, bookA] }, "bookIds"],
    ["a malformed topic", { topicIds: ["nope"] }, "topicIds.0"],
    ["a link to itself", { relatedIdeaIds: [ideaId] }, "relatedIdeaIds"],
  ])("rejects %s without a write", async (_label, entries, key) => {
    const result = await setIdeaRelationsAction(ideaId, initialAdminFormState, form(entries));

    expect(result.fieldErrors[key]).toBeTruthy();
    expect(setIdeaRelations).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a relation target that disappeared", async () => {
    vi.mocked(setArticleRelations).mockRejectedValue(new KnowledgeReferenceNotFoundError());

    const result = await setArticleRelationsAction(articleId, initialAdminFormState, form({ bookIds: [bookA] }));

    expect(result.formError).toBe("A selected author, book, topic, or idea no longer exists. Reload and try again.");
  });
});

describe("publish actions", () => {
  it("publishes and revalidates", async () => {
    await expect(publishKnowledgeAction("idea", ideaId)).resolves.toEqual({ ok: true, message: "Idea published." });

    expect(publishKnowledge).toHaveBeenCalledWith("idea", ideaId);
    expectHubRevalidated(ideaPath);
  });

  it("unpublishes an article", async () => {
    await expect(unpublishKnowledgeAction("article", articleId)).resolves.toEqual({ ok: true, message: "Article unpublished." });
    expect(unpublishKnowledge).toHaveBeenCalledWith("article", articleId);
  });

  it("returns readiness issues from the database gate", async () => {
    vi.mocked(publishKnowledge).mockRejectedValue(new KnowledgeNotReadyError(["missing_related_book"]));

    await expect(publishKnowledgeAction("idea", ideaId)).resolves.toEqual({
      ok: false,
      error: "This entry is not ready to publish.",
      issues: ["missing_related_book"],
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides unknown failures", async () => {
    vi.mocked(unpublishKnowledge).mockRejectedValue(new Error("internals"));

    await expect(unpublishKnowledgeAction("idea", ideaId)).resolves.toEqual({
      ok: false,
      error: "Something went wrong. Try again.",
      issues: [],
    });
  });

  it("refuses an unknown kind", async () => {
    await expect(publishKnowledgeAction("book" as "idea", ideaId)).resolves.toMatchObject({ ok: false });
    expect(publishKnowledge).not.toHaveBeenCalled();
  });
});
