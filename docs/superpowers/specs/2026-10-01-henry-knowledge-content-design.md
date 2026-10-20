# Henry Knowledge Hub Content Design

**Date:** 2026-10-01  
**Source:** *Tại Sao Phải Đọc Khi AI Biết Mọi Thứ?* by Henry  
**Target:** Production Knowledge Hub, draft status only

## Goal

Create a small Vietnamese editorial collection derived from the book's core arguments. The collection
should help readers discover the book through focused questions and practical essays without replacing
the book with chapter summaries.

## Scope

Create four ideas and two articles. Each item has only a Vietnamese localization, remains a draft, and
is related to *Tại Sao Phải Đọc Khi AI Biết Mọi Thứ?*. Henry is the author of both articles. Ideas do
not have an author relation in the current data model, so their connection to Henry is through the book.

Do not upload images, publish any item, or assign a topic unless an existing production topic is an
unambiguous fit. Do not create new books, authors, or topics.

## Content Set

### Ideas

1. **Tại sao vẫn phải đọc khi AI có thể tóm tắt mọi thứ?**  
   Slug: `tai-sao-van-phai-doc-khi-ai-co-the-tom-tat-moi-thu`
2. **Biết nhiều có đồng nghĩa với hiểu sâu không?**  
   Slug: `biet-nhieu-co-dong-nghia-voi-hieu-sau-khong`
3. **Vì sao nên quan sát trước khi hỏi AI?**  
   Slug: `vi-sao-nen-quan-sat-truoc-khi-hoi-ai`
4. **Nên đọc ít hơn trong thời đại AI?**  
   Slug: `nen-doc-it-hon-trong-thoi-dai-ai`

Each idea has a direct one- or two-sentence short answer and three to five typed content blocks. The
body explains one argument, gives the reader a practical distinction or action, and avoids merely
restating a chapter.

### Articles

1. **Từ thói quen đọc đến một hệ thống học cùng AI**  
   Slug: `tu-thoi-quen-doc-den-he-thong-hoc-cung-ai`
2. **Khi tri thức trở nên vô hạn, điều gì vẫn còn khan hiếm?**  
   Slug: `khi-tri-thuc-tro-nen-vo-han-dieu-gi-van-con-khan-hiem`

Each article has a concise excerpt and six to eight typed content blocks. The first article turns the
book's observe–explore–think–act loop into a practical learning workflow. The second develops the
book's argument that attention, experience, capability, judgment, and purpose remain scarce even when
information becomes abundant.

## Editorial Rules

- Paraphrase the source rather than copying long passages.
- Preserve the book's position that AI should reduce unnecessary information work without replacing
  observation, judgment, or responsibility.
- Use plain Vietnamese. Keep necessary terms such as AI; translate other English terminology where it
  improves clarity.
- Use paragraphs, headings, and lists. Do not add external links, images, HTML, or unsupported blocks.
- Do not invent biographical facts about Henry beyond the supplied manuscript.
- Keep the content useful as a standalone page while making the related book the natural next step.

## Production Workflow and Verification

1. Confirm the existing production book and Henry author records by title/name before writing.
2. Create each entity through the production admin UI and save its Vietnamese localization.
3. Relate all six items to the existing book; select Henry as article author.
4. Leave every entity in `draft` status and verify the admin readiness panel reflects that state.
5. Reopen each draft and verify title/question, slug, body blocks, relation order, author, and status.
6. Confirm signed-out public routes, search, and sitemap do not expose the drafts.

If the required book or author is missing or ambiguous, stop without creating substitute records.

