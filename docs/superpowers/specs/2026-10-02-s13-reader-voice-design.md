# S13 Reader Voice Design

**Status:** Approved
**Date:** 2026-10-02
**Roadmap:** PRD 3.5 reading completion (review action), 5.2 book-page evidence, P1.2 knowledge graph (reader questions as idea sources)
**Builds on:** S3 get and buy (entitlements), S4 reader completion, S5 SEO and operations (outbox, ops rules), S12 knowledge hub
**Related:** S14 paperback upsell and LLMO (shares the Book JSON-LD builder)

## 1. Goal

Two ways a reader talks back, and one way the author answers.

1. A reader who owns a book rates it and writes a short review. After moderation the review is shown
   on the book page, with the author's reply when there is one, and enters the Book structured data
   as `aggregateRating` and `review`.
2. A reader asks the author a question from a book they finished or an idea page they read. The
   editor answers the best questions by writing a new idea page. The asker is emailed when the answer
   is published. Every answered question is one more crawlable page built from a real reader question.

Nothing here is a comment thread. Reviews are one per reader per book. Questions are private until
they become an idea, and the idea never names the asker.

## 2. What S13 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| `/{locale}/library/reviews/[bookId]` | Owner of the book | Write, edit, or delete their one review (1–5 stars, up to 1,000 characters); see its moderation state and the author's reply |
| `/{locale}/library` | Owner | A "Review" link on each owned book |
| Reader completion card | Owner | "Rate this book" and "Ask the author" links |
| `/{locale}/books/[slug]` | Reader and crawler | Average rating, count, the latest published reviews with author replies, "Write a review" and "Ask the author" links |
| `/{locale}/ask` | Signed-in reader | Ask one question about a book or an idea; see their own earlier questions and the answers |
| `/{locale}/ideas/[slug]` | Reader | "Ask the author about this" link |
| `/admin/reviews` | Editor | Pending, published, rejected lists; publish, reject, reply |
| `/admin/questions` | Editor | New, answered, archived lists; archive, answer with a new idea, link to an existing idea |
| Email | Asker | `question_answered` with the idea URL, sent when the answering idea is published |
| `/admin/operations` | Operator | A `stale_reader_question` rule: questions still `new` after 7 days |

## 3. Out of Scope

- Replies to reviews from other readers, likes, threads, or any reader-to-reader surface.
- Reviews from readers who do not own the book. The sample reader cannot review.
- Star ratings without a body, and bodies without a rating. One row carries both.
- Anonymous questions. A session is the spam control, together with a per-profile cap.
- Emailing the reviewer when the author replies. The reply is visible on the book page and the
  review page. Add the email if readers say they miss it.
- An "Ask Infinity" AI answer. The author answers, a person edits, the idea is published.
- Public question lists or voting on questions.
- Importing reviews from marketplaces.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Who may review | A profile with an active entitlement for the book, checked inside the RPC with the same `exists (... status = 'active')` predicate `save_reading_progress` uses. Finishing the book is not required; owning it is. |
| One review per reader per book | `unique (book_id, profile_id)`. Submitting again edits the row, and any edit returns it to `pending`. |
| Moderation | Default `pending`. Only an admin moves it to `published` or `rejected`. A rejected review stays visible to its author with the state, not the reason. |
| Author reply | A nullable `author_reply` text on the review row, written by an admin on behalf of the author. Not a second entity. Shown as "Phản hồi từ tác giả". |
| Reviewer name | `book_reviews.reviewer_name`: a snapshot of `profiles.display_name` taken by `submit_book_review` on every save (trimmed, at most 80 characters, null when it contains tag syntax), so a moderator approves the name the public sees; the dictionary string `catalog.reviews.anonymousReader` when null. No avatar, no link to the reader. |
| Structured data | `aggregateRating` only when at least one review is published; `review` entries only for the reviews actually rendered on the page. Never an aggregate without visible reviews. |
| Where the review form lives | A dedicated authenticated page under `/library`, not the prerendered book page. The book page cannot know the viewer server-side, and `ViewerBookAction` already shows that per-viewer state must be fetched client-side. One form page keeps the entitlement gate in one server action. |
| Who may ask | Any signed-in profile. Ideas are public pages and a question from a reader who has not bought yet is still a lead. Cap: at most 5 questions in `new` per profile (`EB035`). |
| Question targets | `book_id` or `idea_id`, at least one, both allowed. The target is what the editor sees as context and what the answering idea is related to. |
| Answering | An admin either creates a new idea from the question (one RPC that creates the idea, relates it to the question's book or to the asked idea's books, links the asked idea, and marks the question `answered`), or links the question to an existing idea. Editorial writing then continues in the normal idea editor. |
| Notification | The asker is emailed when the answering idea is `published`, not when it is linked, because a draft URL would 404. A trigger on `ideas` status change inserts one `notification_outbox` row per answered, un-notified question. |
| Question privacy | Only the asker and admins read a question. The idea page shows nothing about who asked. `audit_logs` metadata stores ids, never the body. |
| Operator signal | A new ops rule follows `unreviewed_manual_transfer_claim`: a `new` question older than 7 days is a finding pointing at `/admin/questions`. |

## 5. Data Model

```
book_reviews         id uuid pk
                     book_id uuid references books(id) on delete cascade
                     profile_id uuid references profiles(id) on delete cascade
                     rating smallint not null check (rating between 1 and 5)
                     body text not null check (length(btrim(body)) between 1 and 1000)
                     locale text not null check (locale in ('vi','en'))
                     status text not null default 'pending'
                       check (status in ('pending','published','rejected'))
                     author_reply text check (author_reply is null or length(btrim(author_reply)) between 1 and 1000)
                     author_reply_at timestamptz
                     published_at timestamptz
                     created_at, updated_at
                     revision bigint not null default 1 (increments on each update)
                     unique (book_id, profile_id)
                     check ((author_reply is null) = (author_reply_at is null))

reader_questions     id uuid pk
                     profile_id uuid references profiles(id) on delete cascade
                     book_id uuid references books(id) on delete set null
                     idea_id uuid references ideas(id) on delete set null
                     body text not null check (length(btrim(body)) between 1 and 500)
                     locale text not null check (locale in ('vi','en'))
                     status text not null default 'new'
                       check (status in ('new','answered','archived'))
                     answer_idea_id uuid references ideas(id) on delete set null
                     answered_at timestamptz
                     notified_at timestamptz
                     created_at
                     check (book_id is not null or idea_id is not null)
                     check ((status = 'answered') = (answer_idea_id is not null))
```

Indexes: `book_reviews (book_id, status, published_at desc)`, `reader_questions (status, created_at)`,
`reader_questions (answer_idea_id) where notified_at is null`.

Text columns reject HTML-tag syntax with the same `/<\/?[a-z][^>]*>/i` rule S12 uses for editorial
text, enforced in Zod before the action and in a check constraint in SQL. Review bodies and replies
render as text through React; there is no rich text anywhere in S13.

RLS: a reader selects their own `book_reviews` and `reader_questions` rows; admins select all.
Public review reads go only through `catalog_book_reviews`, which omits profile id and locale and
requires the review and book to be published. Anon has no SELECT grant on `book_reviews`. No role has insert, update, or delete on either table; every write is a definer RPC.

`notification_outbox` gains `question_id uuid unique references reader_questions(id)` and the
template `question_answered`, plus a `question_delivery_started` boolean that the first worker claim
sets permanently (default false). The target check becomes exactly one of `entitlement_id`, `gift_id`,
`question_id`. `claim_notification_outbox` is redefined to return `question_id`.

`operations_alert_state` gains the rule `stale_reader_question`.

## 6. RPCs

| Function | Caller | Behavior |
| --- | --- | --- |
| `submit_book_review(p_book_id, p_rating, p_body, p_locale)` | authenticated | Refuses without an active entitlement (`EB034`). Upserts on `(book_id, profile_id)`; sets `status = 'pending'`, `published_at = null`, keeps `author_reply`. Returns the row. |
| `delete_book_review(p_book_id)` | authenticated | Deletes the caller's row. `P0002` when absent. |
| `get_my_book_review(p_book_id)` | authenticated | The caller's row or nothing. |
| `catalog_book_reviews(p_book_id, p_limit)` | anon, authenticated | Published reviews of a published book, newest `published_at` first, with `reviewerName`, `rating`, `body`, `authorReply`, `authorReplyAt`, `publishedAt`. |
| `catalog_book_page` | anon, authenticated | Gains `reviewSummary: { count, average }` over published reviews, or null when count is 0. `average` rounded to one decimal. |
| `admin_moderate_review(p_review_id, p_status, p_expected_revision)` | admin | Rejects a missing/stale revision (`EB036`); `published` sets `published_at = coalesce(published_at, now())`; `rejected` keeps `published_at`. One `audit_logs` row, `action = 'book_review.moderate'`. |
| `admin_reply_review(p_review_id, p_reply)` | admin | Sets or clears the reply and `author_reply_at`. Audit `book_review.reply`. |
| `admin_list_reviews(p_status)` | admin | Rows with book title, reviewer name snapshot and revision, for the admin list. |
| `submit_reader_question(p_book_id, p_idea_id, p_body, p_locale)` | authenticated | Needs a profile; `22023` without a target; `P0002` for a target that is not published; `EB035` when the caller already has 5 `new` questions. Returns the id. |
| `get_my_reader_questions()` | authenticated | The caller's questions newest first, with target title and, when answered, the published answer idea's localized slug for the question's locale (null while the idea is unpublished or has no localization in that locale). |
| `admin_list_questions(p_status)` | admin | Rows with asker display name, target title, answer idea id, for the admin list. |
| `admin_archive_question(p_question_id)` | admin | `new → archived`. Audit `reader_question.archive`. |
| `admin_answer_question_with_idea(p_question_id, p_locale, p_slug, p_question, p_short_answer)` | admin | Calls `admin_create_idea`, then inserts `idea_books` from the question's `book_id` or, when the target is an idea, from that idea's `idea_books`, and inserts an `idea_links` row to the asked idea; sets the question `answered` with `answer_idea_id`; returns the idea id. One audit row `reader_question.answer`, in addition to the create-idea audit row that `admin_create_idea` writes. |
| `admin_answer_question(p_question_id, p_idea_id)` | admin | Links to an existing idea, `answered`. Audit `reader_question.answer`. |

Trigger `reader_questions_notify_on_publish` on `ideas` `after update of status`: when the new status is
`published`, insert `notification_outbox (question_id, profile_id, template_key, payload)` for every
question with `answer_idea_id = new.id`, `status = 'answered'`, `notified_at is null`, and set
`notified_at`. The payload carries `{ ideaId }` only; the worker resolves the localized URL at send
time so a later slug change still produces a valid link. Linking locks the answer idea before the
question and outbox, serializing with publication. Relinking updates an unsent outbox payload;
claiming waits for the current answer to be published. The persistent `question_delivery_started` marker set on first claim
refuses a changed answer while the row is unsent with `EB037` until the worker finishes/retries. Sent rows never requeue.

## 7. Public and Reader Pages

**Book page** (`/{locale}/books/[slug]`), after the knowledge backlinks:

```
Đánh giá từ độc giả          ★ 4.6 · 12 đánh giá
[Viết đánh giá]  [Hỏi tác giả]

★★★★★  Minh Anh · 12 thg 9, 2026
Cuốn sách giúp tôi ...
   Phản hồi từ tác giả: Cảm ơn bạn ...
```

- Up to 5 reviews through `catalog_book_reviews(bookId, 5)`. The section renders only when
  `reviewSummary` is non-null; the two links render always.
- "Viết đánh giá" links to `/{locale}/library/reviews/{bookId}`. "Hỏi tác giả" links to
  `/{locale}/ask?book={bookId}`. Both pages call `requireUser`, so a signed-out reader goes through
  sign-in and returns.
- JSON-LD: `bookSchema` gains `aggregateRating { ratingValue, reviewCount, bestRating: 5, worstRating: 1 }`
  and `review[]` with `author: Person { name }`, `reviewRating { ratingValue }`, `reviewBody`,
  `datePublished`. Both are built from the same arrays the page renders.

**Review page** (`/{locale}/library/reviews/[bookId]`, account route group, noindex):

- `requireUser`, then `getMyBookReview(bookId)` and the book card. A reader without an entitlement sees
  the dictionary message `library.reviews.notOwned` with a link to the book page, no editing form.
  If they already have a review, its rating, body, state and reply remain visible with a Delete button.
- Form: five radio stars, a textarea with a 1,000-character counter, Save and Delete. Server actions
  `submitBookReviewAction(locale, bookId, state, formData)` and `deleteBookReviewAction(locale, bookId)`.
  After save: `revalidateStorefront()` so the book page picks up a re-moderated state within the
  storefront cache model, and `revalidatePath` of the review page and the library.
- Below the form: the current state (`pending`, `published`, `rejected`) and the author reply if any.

**Library** (`/{locale}/library`): each owned book row gains a "Đánh giá" link to the review page.

**Reader completion card**: two new links, `rateBook` → the review page and `askAuthor` →
`/{locale}/ask?book={bookId}`. `ReaderCompletionCopy` gains both keys; `ReaderClientProps` gains
`reviewHref` and `askHref`, computed in the reader page.

**Ask page** (`/{locale}/ask?book=…|idea=…`, account route group, noindex):

- `requireUser`. Exactly one of `book` or `idea` must be a UUID of a published entity with a
  localization in the locale, else `notFound()`.
- Shows the target title, a 500-character textarea, Send. Server action
  `submitReaderQuestionAction(locale, state, formData)` reads the hidden target fields.
- Below: "Câu hỏi của bạn", the caller's questions with target, date, state, and for answered ones a
  link to the idea when it is published in the current locale.
- `EB035` maps to `library.questions.tooManyOpen`.

**Idea page**: an "Hỏi tác giả về điều này" link to `/{locale}/ask?idea={ideaId}` after the short answer.

## 8. Admin

**`/admin/reviews`**: tabs Pending (default), Published, Rejected. Each row: book title, reviewer,
stars, body, date, state, reply if any. Row actions: Publish, Reject, Reply (inline textarea). Server
actions call `admin_moderate_review` and `admin_reply_review`, then `revalidateStorefront()` and the
admin path. Admin nav gains "Reviews" and "Questions" after "Articles".

**`/admin/questions`**: tabs New (default), Answered, Archived. Each row: date, asker display name,
target (book or idea, linked to its editor), body. Row actions on New: Archive, "Answer with a new
idea" (opens a small form: locale, slug, question prefilled from the body, short answer), "Link to
idea" (select from published and draft ideas). Answered rows link to the idea editor.

Admin dashboard (`/admin`) gains two counts: pending reviews and new questions.

## 9. Email and Operations

`lib/email/question-answered.ts` builds `buildQuestionAnsweredEmail({ locale, displayName, ideaTitle, ideaUrl })`
from `email.questionAnswered.*` dictionary keys. The worker's `buildMessage` gains the
`question_answered` branch; the recipient is the question's profile email, resolved the same way
`book_ready` resolves it. The idea URL is built from the answer idea's localization in the question's
locale, falling back to the other locale when the question's locale has none; if neither exists at send
time the row fails with `DeliveryDataError("unsupported_locale")` and is retried by the normal lease
cycle.

Ops rule `stale_reader_question`: `lib/data/operations.ts` loads `reader_questions` with
`status = 'new'` and `created_at < now() - interval '7 days'`; `lib/ops/checks.ts` emits one finding
per question with the fixed summary "A reader question has waited more than 7 days." and the path
`/admin/questions`. Migration extends `operations_alert_state_rule_name_check` and seeds the row, as
`20260922150000_operations_alert_state_manual_claims.sql` did.

## 10. Testing

| Layer | Coverage |
| --- | --- |
| Vitest | Review and question Zod schemas (length, rating range, HTML tags, target presence); `bookSchema` emits `aggregateRating` and `review` only when reviews are present and both match the inputs; the review form shows the not-owned message without a form; the ask page refuses zero or two targets; completion panel renders the two new links; email builder output for both locales; ops `stale_reader_question` finding shape; admin review and question list components; dictionary key parity |
| pgTAP | `submit_book_review` refuses without an active entitlement (`EB034`), upserts to `pending` on edit, keeps `author_reply`; a reader reads only own and published reviews; anon reads only published reviews of published books; `catalog_book_page.reviewSummary` averages only published reviews; `admin_moderate_review` sets `published_at` once and writes one audit row; `submit_reader_question` enforces the target check, the 5-open cap (`EB035`), and refuses unpublished targets; a reader cannot read another reader's question; `admin_answer_question_with_idea` creates the idea, relates the book, links the asked idea, and marks the question answered; publishing the idea inserts exactly one outbox row per question and sets `notified_at`; republishing inserts none; `claim_notification_outbox` returns `question_id`; privilege checks for every new function |
| Playwright | Reader buys (simulator) → finishes → completion card → review page → submits → admin publishes → book page shows the review and JSON-LD has `aggregateRating`; reader asks from an idea page → admin answers with a new idea → publishes → Mailpit receives `question_answered` with the idea URL → the ask page links to the idea |
| Runbook | `docs/runbooks/reader-voice.md`: moderating reviews, writing a reply, choosing between a new idea and an existing one, what the asker is told and when, the stale-question alert |

## 11. Exit Criteria

- A reader without an entitlement cannot create a review through the UI or the RPC.
- A published review appears on the book page within the storefront cache window, with
  `aggregateRating` and `review` in JSON-LD that validate and match the visible content.
- An edited review disappears from the book page until re-moderated.
- A question is visible only to its asker and admins; the answering idea page contains no asker data.
- Publishing an answering idea sends exactly one email per answered question, with a URL that resolves.
- A question left `new` for 7 days produces one operations finding and one operator email.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
