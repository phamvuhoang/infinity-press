import { expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import {
  createKnowledgeAdmin,
  knowledgeAuditActions,
  seedPublishedIdea,
  signInKnowledgeAdmin,
  storedIdeaBody,
} from "./support/knowledge";
import { revalidateStorefront } from "./support/revalidate";

// S12 acceptance (spec 10). Three journeys: a reader finds an idea by typing a Vietnamese question
// without diacritics and reaches its book and back; an admin creates, relates, and publishes an idea
// through the editor with one audit row per mutation and no stored or rendered markup; and a locale
// without a localization is a 404 whose language switch points at that locale's home.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("a reader searches a question without diacritics, reads the idea, and follows its book back", async ({ page, request }) => {
  test.setTimeout(90_000);
  const run = unique();
  const bookTitle = `Sách đọc chậm ${run}`;
  const book = await seedCatalogBook({ suffix: `kh-search-${run}`, localizations: { vi: { slug: `sach-doc-cham-${run}`, title: bookTitle } } });

  // Diacritics throughout, including đ, which unaccent must fold to d.
  const question = `Vì sao đọc chậm giúp ta nhớ lâu hơn ${run}?`;
  const shortAnswer = `Vì chậm lại cho trí nhớ thời gian nối ý mới với điều đã biết ${run}.`;
  const body = `Đoạn thân bài giải thích chi tiết ${run}.`;
  const slug = `vi-sao-doc-cham-${run}`;
  const admin = await signInKnowledgeAdmin(await createKnowledgeAdmin());
  await seedPublishedIdea(admin, { locale: "vi", slug, question, shortAnswer, body, bookIds: [book.bookId] });
  // The RPCs bypass the Server Actions that revalidate the storefront; do what they would.
  await revalidateStorefront(request);

  await page.goto("/vi/search");
  await page.getByLabel("Tìm sách, tác giả, ý tưởng, bài viết, bộ sách và chủ đề").fill(`vi sao doc cham giup ta nho lau hon ${run}`);
  await page.getByRole("button", { name: "Tìm", exact: true }).click();
  await page.getByRole("region", { name: "Ý tưởng", exact: true }).getByRole("link", { name: question }).click();
  await expect(page).toHaveURL(new RegExp(`/vi/ideas/${slug}$`));

  // The question and its short answer open the page, above the body.
  const heading = page.getByRole("heading", { level: 1, name: question });
  const answer = page.getByText(shortAnswer, { exact: true });
  const paragraph = page.getByText(body, { exact: true });
  await expect(heading).toBeVisible();
  await expect(answer).toBeVisible();
  await expect(paragraph).toBeVisible();
  const [headingBox, answerBox, paragraphBox] = await Promise.all([heading.boundingBox(), answer.boundingBox(), paragraph.boundingBox()]);
  expect(headingBox!.y).toBeLessThan(answerBox!.y);
  expect(answerBox!.y).toBeLessThan(paragraphBox!.y);

  await page.getByRole("region", { name: "Sách liên quan", exact: true }).getByRole("link", { name: bookTitle }).click();
  await expect(page).toHaveURL(new RegExp(`/vi/books/sach-doc-cham-${run}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(bookTitle);
  const backlink = page
    .getByRole("region", { name: "Ý tưởng và bài viết về cuốn sách này", exact: true })
    .getByRole("link", { name: question });
  await expect(backlink).toHaveAttribute("href", `/vi/ideas/${slug}`);
});

test("an admin creates, relates, and publishes an idea with one audit row per mutation and no stored markup", async ({ page }) => {
  test.setTimeout(120_000);
  const run = unique();
  const bookTitle = `Harbour Notes ${run}`;
  const book = await seedCatalogBook({ suffix: `kh-admin-${run}`, localizations: { en: { slug: `harbour-notes-${run}`, title: bookTitle } } });

  const admin = await createKnowledgeAdmin();
  // An already-published idea to relate to, created through the same admin RPCs.
  const relatedQuestion = `Why keep a reading log ${run}?`;
  await seedPublishedIdea(await signInKnowledgeAdmin(admin), {
    locale: "en",
    slug: `why-keep-a-reading-log-${run}`,
    question: relatedQuestion,
    shortAnswer: `Because memory edits what it keeps ${run}.`,
    body: `A log is a second memory ${run}.`,
    bookIds: [book.bookId],
  });

  // The real staff sign-in form, not a minted session.
  await page.goto(`/internal/en/sign-in?next=${encodeURIComponent("/admin/ideas/new")}`);
  await page.getByLabel("Email").fill(admin.email);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/admin\/ideas\/new$/);

  const question = `How does slow reading change memory ${run}?`;
  const shortAnswer = `It gives new ideas time to attach to old ones ${run}.`;
  const slug = `how-slow-reading-changes-memory-${run}`;
  await page.getByLabel("Locale").selectOption("en");
  await page.getByLabel("Question", { exact: true }).fill(question);
  await page.getByLabel("Short answer", { exact: true }).fill(shortAnswer);
  await page.getByLabel("Slug", { exact: true }).fill(slug);
  await page.getByRole("button", { name: "Create idea" }).click();
  await expect(page).toHaveURL(/\/admin\/ideas\/[0-9a-f-]{36}$/);
  const ideaId = page.url().split("/").at(-1)!;

  // One paragraph in the typed editor. An HTML value is refused before any write.
  const content = page.locator("form").filter({ has: page.getByRole("button", { name: "Save en content" }) });
  await expect(content.getByLabel("Question (en)")).toHaveValue(question);
  await content.getByLabel("New block type").selectOption("paragraph");
  await content.getByRole("button", { name: "Add block" }).click();
  const text = content.getByLabel("Text", { exact: true });
  await text.fill(`<script>window.__s12Injected = 1</script><b>Bold claim ${run}</b>`);
  await content.getByRole("button", { name: "Save en content" }).click();
  await expect(content.getByText("HTML is not allowed. Use plain text.")).toBeVisible();
  await expect(content.getByTestId("form-saved")).toHaveCount(0);

  // An ordinary angle character that is not a tag is plain text, escaped by React on render.
  const paragraph = `Slow reading keeps 2 < 3 ideas in view ${run}.`;
  await text.fill(paragraph);
  await content.getByRole("button", { name: "Save en content" }).click();
  await expect(content.getByTestId("form-saved")).toHaveCount(1);

  const relations = page.locator("form").filter({ has: page.getByRole("button", { name: "Save relations" }) });
  await relations.getByLabel("Add a book").selectOption({ label: bookTitle });
  await relations.getByRole("button", { name: "Add book", exact: true }).click();
  await relations.getByLabel("Add an idea").selectOption({ label: relatedQuestion });
  await relations.getByRole("button", { name: "Add idea", exact: true }).click();
  await relations.getByRole("checkbox", { name: book.topicName, exact: true }).check();
  await relations.getByRole("button", { name: "Save relations" }).click();
  await expect(relations.getByTestId("form-saved")).toHaveCount(1);

  const seo = page.locator("form").filter({ has: page.getByRole("button", { name: "Save en SEO" }) });
  const seoTitle = `Slow reading and memory ${run}`;
  await seo.getByLabel("SEO title (en)").fill(seoTitle);
  await seo.getByLabel("SEO description (en)").fill(`Why reading slowly helps you remember ${run}.`);
  await seo.getByRole("button", { name: "Save en SEO" }).click();
  await expect(seo.getByTestId("form-saved")).toHaveCount(1);

  // Readiness is clean once the saves above refresh the editor; publishing asks for confirmation.
  const publish = page.getByRole("button", { name: "Publish idea" });
  await expect(publish).toBeEnabled();
  page.once("dialog", (dialog) => void dialog.accept());
  await publish.click();
  await expect(page.getByTestId("knowledge-publish-message")).toHaveText("Idea published.");

  // Exactly one audit row per submitted mutation, all by this admin. The refused HTML save wrote none.
  const audits = await knowledgeAuditActions(ideaId);
  expect(audits.map((row) => row.action)).toEqual([
    "create_idea",
    "save_idea_localization",
    "set_idea_relations",
    "save_idea_seo",
    "publish_idea",
  ]);
  expect(audits.every((row) => row.actorProfileId === admin.profileId)).toBe(true);
  const stored = await storedIdeaBody(ideaId, "en");
  expect(stored).not.toMatch(/<\/?[a-z][^>]*>/i);
  expect(stored).toContain("2 < 3");

  const response = await page.goto(`/en/ideas/${slug}`);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(new RegExp(seoTitle));
  await expect(page.getByRole("heading", { level: 1, name: question })).toBeVisible();
  await expect(page.getByText(shortAnswer, { exact: true })).toBeVisible();
  await expect(page.getByText(paragraph, { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Related books", exact: true }).getByRole("link", { name: bookTitle })).toBeVisible();
  await expect(page.getByRole("region", { name: "Related ideas", exact: true }).getByRole("link", { name: relatedQuestion })).toBeVisible();
  await expect(page.getByRole("region", { name: "Topics", exact: true }).getByRole("link", { name: book.topicName })).toBeVisible();
  // Nothing from the refused value exists in the page, as markup or as text, and nothing ran.
  expect(await page.evaluate(() => (window as unknown as { __s12Injected?: number }).__s12Injected)).toBeUndefined();
  const main = page.locator("main");
  await expect(main.locator("b, script")).toHaveCount(0);
  await expect(main).not.toContainText("__s12Injected");
  await expect(main).not.toContainText(`Bold claim ${run}`);

  // The FAQ structured data mirrors the visible question and short answer.
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  const faq = scripts
    .flatMap((script) => [JSON.parse(script)].flat() as Record<string, unknown>[])
    .find((node) => node["@type"] === "FAQPage");
  expect(faq).toMatchObject({
    mainEntity: [{ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: shortAnswer } }],
  });
});

test("an idea without a Vietnamese localization is shown there under its English copy, canonical to the English page", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const run = unique();
  const book = await seedCatalogBook({ suffix: `kh-locale-${run}`, localizations: { en: { slug: `lighthouse-${run}`, title: `Lighthouse ${run}` } } });
  const slug = `what-does-a-lighthouse-keep-${run}`;
  const question = `What does a lighthouse keep ${run}?`;
  const admin = await signInKnowledgeAdmin(await createKnowledgeAdmin());
  await seedPublishedIdea(admin, {
    locale: "en",
    slug,
    question,
    shortAnswer: `A promise to the dark ${run}.`,
    body: `Keepers kept logs ${run}.`,
    bookIds: [book.bookId],
  });
  await revalidateStorefront(request);

  const found = await page.goto(`/en/ideas/${slug}`);
  expect(found?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: question })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const self = `${origin}/en/ideas/${slug}`;
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", self);
  await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute("href", self);
  // No Vietnamese alternate is fabricated in metadata, and the header switch goes to /vi.
  await expect(page.locator('link[rel="alternate"][hreflang="vi"]')).toHaveCount(0);
  const switcher = page.locator('header a[hreflang="vi"]');
  await expect(switcher).toHaveAttribute("href", "/vi");
  await switcher.click();
  await expect(page).toHaveURL(`${origin}/vi`);

  // Metadata fallback (spec section 5): under /vi the idea is shown whole in its English copy, under
  // its English slug, says so, and is canonical to the English page rather than claiming to be a
  // Vietnamese one. A Vietnamese slug that does not exist is still a 404.
  const fallback = await page.goto(`/vi/ideas/${slug}`);
  expect(fallback?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: question })).toBeVisible();
  await expect(page.getByText("Tiêu đề và mô tả hiển thị bằng English.")).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", self);
  await expect(page.locator('link[rel="alternate"][hreflang="vi"]')).toHaveCount(0);
  expect((await page.goto(`/vi/ideas/${slug}-khong-co`))?.status()).toBe(404);

  let sitemap = "";
  await expect
    .poll(
      async () => {
        const response = await request.get("/sitemap.xml");
        expect(response.status()).toBe(200);
        sitemap = await response.text();
        return sitemap.includes(`<loc>${self}</loc>`);
      },
      { message: "the published English idea reaches the sitemap", timeout: 30_000 },
    )
    .toBe(true);
  expect(sitemap).not.toContain(`/vi/ideas/${slug}`);
});
