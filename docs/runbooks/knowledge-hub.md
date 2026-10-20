# Runbook: knowledge hub

This runbook covers what S12 adds: ideas in `/admin/ideas`, articles in `/admin/articles`, and their
public pages under `/{locale}/ideas` and `/{locale}/articles`, with backlinks from book and topic
pages, search results, structured data, and sitemap entries.

> **One database.** The cloud Supabase project is also production's database. Never run Playwright
> fixtures, `supabase db reset`, pgTAP, or seeded admin writes against it. Section 9 is local-only.
> On the hosted project, create and publish knowledge only through the admin editor.

Related: [catalog admin](catalog-admin.md) for the books, authors, and topics an idea or article
relates to, [storefront](storefront.md) for when a public page shows at all,
[storefront caching](storefront-caching.md) for what a publish invalidates, and
[SEO and operations](seo-and-operations.md) for canonical URLs, redirects, and the sitemap.

## 1. Idea or article?

Both are editorial content in the same typed blocks. Choose by the question the page answers.

| Use | When | What the page leads with |
| --- | --- | --- |
| **Idea** | One answerable life question, such as "Why does reading slowly help memory?" A reader should get the answer in two sentences. | The question as the heading, then the **short answer**, then the body. |
| **Article** | Broader editorial writing: an essay, a reading guide, a piece about an author. No single question. | The title and excerpt, the author byline, and the first publication date. |

An idea **must** relate to at least one published book. It exists to lead a reader to a book, and
publishing refuses an idea without one. An article may relate to books, ideas, and topics, but needs
none of them.

The idea's question and short answer also become the page's `FAQPage` structured data. Write the
short answer as the real answer, not a teaser: it is shown to every reader and to search engines.
The FAQ data is never built from body blocks.

## 2. Create and localize

1. **Create.** `/admin/ideas` → **New idea**, or `/admin/articles` → **New article**. Choose the
   locale and enter the question and short answer (idea) or the title and excerpt (article), plus
   the slug. An article also needs an author from the existing authors list. The slug must be
   lowercase words joined by hyphens. It is unique per locale among ideas, and separately among
   articles, because `/ideas/x` and `/articles/x` are different URLs.
2. **Add the other language.** The editor's **Localizations** section has one form per locale.
   Fill the empty one and **Save vi content** or **Save en content**. Each language is a separate
   public page. A missing language is not an error; see section 7.
3. **Details (articles only).** Change the author under **Details**. The first publication date is
   shown here once the article has been published.

Every successful create, details edit, localization save, SEO save, relation save, publish, and
unpublish writes exactly one `audit_logs` row. A save refused by validation writes nothing.

## 3. Write the body

The body is a list of typed blocks, edited through ordinary form fields. There is no rich-text
surface and no HTML. **Any text that looks like an HTML tag (`<b>`, `<script>`, `</p>`) is refused
with "HTML is not allowed. Use plain text."** An ordinary angle bracket that is not a tag, such as
`2 < 3`, is fine and shows as written.

Add a block with **New block type** → **Add block**. Reorder with **Move up** / **Move down**, or
drag the handle. Remove with **Remove**. Nothing is saved until you press the localization's save
button; if a save fails, your unsaved blocks stay in the editor with the error beside the block.

| Block | What to fill | Notes |
| --- | --- | --- |
| Paragraph | One or more text runs | Each run can be emphasized, strong, and/or a link. |
| Heading | Level 2 or 3, text | Do not skip levels. The page title is level 1. |
| List | Bulleted or numbered items, each made of runs | At most 50 items. |
| Quote | Text, attributed to **either** a person (free text) **or** a book | Never both. A book-attributed quote follows the book-quote rules in section 5. |
| Book quote | A book, the quoted text, an optional locator | See section 5. |
| Image | An uploaded file and its alt text | See section 4. |
| Book card | A book | Shows the book's cover, title, author, and price. |
| Idea card | An idea | Links to another idea. |

Limits: at most **100 blocks** per language, and each text run at most 5,000 characters and not
blank.

**Links.** A run's link is either:

- **Internal:** choose what it links to (book, idea, article, author, series, topic) and enter that
  item's slug **in the same language** as the page. The URL is built when the page renders, so if
  that slug is later renamed, the stored old slug still works through the redirect map.
- **External:** an **absolute** `https://` or `http://` URL. Relative paths, `//host` links,
  `mailto:`, `javascript:`, and `data:` URLs are refused.

## 4. Images

1. Add an **Image** block and choose the file under **Image file**. JPEG, PNG, or WebP, up to 5 MB.
   The editor reads its width and height, uploads it directly to the public `covers` bucket under
   `knowledge/ideas/<idea-id>/…` or `knowledge/articles/<article-id>/…`, and shows a preview.
2. Write **Alt text** that says what the image shows and why it matters here, in the page's
   language: "A reader's margin notes beside the chapter on memory", not "image" or the file name.
   Alt text is required.
3. Save the localization. An image uploaded to one idea cannot be used on another; upload it again.

Storage keys are minted by the server. The block stores only the key, alt text, width, and height.

## 5. Quoting a book

Use a **Book quote** block, or a **Quote** attributed to a book. Both follow the rule that governs
reader quotes:

- **At most 300 characters as a reader sees them** (Unicode grapheme clusters). A Vietnamese letter
  with its tone mark counts as one character even when typed as a base letter plus combining marks,
  and an emoji such as 👨‍👩‍👧 counts as one. The editor's counter uses the same count as the server.
- **The book is required.** The published page always shows the quote with the book's localized
  title, its author, and a link to the book page. You cannot write a book quote without a book.
- **Locator (optional)**, on a book quote only: a short label such as "Chapter 3" or "p. 42".
- If the quoted book is later unpublished or has no page in this language, the whole quote block is
  hidden on that page rather than shown without its source. The same applies to book and idea
  cards whose target is not visible.

## 6. Relate, check readiness, and publish

1. **Relations.** In **Relations**, use **Add a book** / **Add book** and **Add an idea** /
   **Add idea**, reorder with **Move up** / **Move down**, tick **Topics**, then **Save relations**.
   Books and ideas are ordered: the public page lists them in this order. Topics are a set. An idea
   never relates to itself. An idea appears under every published topic it has on the ideas index,
   and once under "Other" / "Khác" when it has none.
2. **SEO (optional).** **SEO title** (up to 70 characters) and **SEO description** (up to 160) per
   language. Blank means the page uses the question or title and the short answer or excerpt.
3. **Readiness.** The **Publish** section lists what is missing. Each item links to the section that
   fixes it:

   | Message | Fix |
   | --- | --- |
   | Add a localization with a slug, question, and short answer. (idea) | Section 2. |
   | Add a localization with a slug, title, and excerpt. (article) | Section 2. |
   | Add at least one content block to a complete localization. | Section 3. |
   | Relate at least one published book. (idea) | Step 1, and publish the book. |

4. **Publish.** **Publish idea** / **Publish article**, and confirm. The database repeats the same
   check, so a stale editor cannot publish something that no longer qualifies. An article's first
   publish sets its publication date. Unpublishing and republishing keep that date, so the
   article archive does not reorder.
5. **Unpublish** removes the pages, backlinks, search results, and sitemap entries in every
   language. The content is kept as a draft.
6. **Verify both locales**, signed out: `/vi/ideas/<vi-slug>` and `/en/ideas/<en-slug>` (or
   `/articles/…`). Check that the related books are listed, that each related book's page links
   back under "Ideas and articles about this book" / "Ý tưởng và bài viết về cuốn sách này", and
   that each related topic's page does the same.

## 7. Slugs, missing languages, search, and SEO checks

**Renaming a slug.** Saving a *published* localization with a new slug records a redirect from the
old URL to the new one and collapses any existing chain, so `a → b → c` becomes `a → c`. A draft's
old slug was never public and gets no redirect.

**A missing translation is a 404.** `/vi/ideas/<english-slug>` is not found; the site never shows
English content under a Vietnamese URL, or the other way round. On a one-language page the
language switch goes to the other language's home page, and the page has no `hreflang` alternate
for that language. Both are correct. Add the translation if you want the pair linked.

**Search.** `/{locale}/search` groups results as books, authors, ideas, articles, series, topics.
Ideas match on the question and short answer; articles on the title and excerpt. Vietnamese
matching ignores diacritics, so "vi sao doc cham" finds "Vì sao đọc chậm". **Body blocks are not
searched**, so put the words readers will type into the question, short answer, title, or excerpt.

**Caching.** Every editor save, publish, and unpublish refreshes the storefront and
`/sitemap.xml` immediately (`revalidateKnowledgeHub()`). A change made any other way, such as a
direct database edit, appears within five minutes; see [storefront caching](storefront-caching.md)
for forcing it sooner.

**SEO checks after publishing**, on the public page:

- `<link rel="canonical">` is the page's own URL.
- `hreflang` alternates exist only for languages that have this idea or article.
- Structured data: an `Article` for both kinds, plus a `FAQPage` on an idea whose one question and
  answer match the visible question and short answer, plus breadcrumbs.
- `/sitemap.xml` lists `/{locale}/ideas` and `/{locale}/articles` for both locales, and every
  published idea and article URL in each language it exists in, never a draft.

## 8. When a page does not appear

| Symptom | Check |
| --- | --- |
| Publish button disabled | The readiness list in **Publish**. For an idea, the related book must itself be published. |
| 404 in one language | That language has no localization. Section 7. |
| Page missing from search | The words are only in the body, or the item is a draft. Section 7. |
| A quote or card missing from the page | Its book or idea is not published in this language. Section 5. |
| Old URL still shows old text | Wait for, or force, revalidation. Section 7. |

## 9. Testing (local stack only)

Run these only against a local Supabase stack that this checkout owns. Read
[testing environments](testing-environments.md) first, including its port-ownership warning, its
`--workdir` commands for a scratch stack, and the variables to export before Playwright.

```bash
npm run db:reset                                   # default 543xx stack only
npm run db:test                                    # pgTAP: 054, 055, 056 cover S12
npx vitest run lib/knowledge components/knowledge components/admin/knowledge app/admin/knowledge
npm run test:e2e -- e2e/knowledge-hub.spec.ts     # after exporting the test variables
```

`e2e/knowledge-hub.spec.ts` creates confirmed admin users and publishes ideas through the real
admin RPCs as a signed-in admin (`e2e/support/knowledge.ts`), with no teardown. Its clients refuse
any non-loopback Supabase URL. **Never** point it, `supabase db reset`, pgTAP, or any fixture at
the cloud project. After an E2E run, reset the local stack before trusting a pgTAP failure.
