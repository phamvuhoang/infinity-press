# Runbook: reader voice

This runbook covers what S13 adds: reader reviews with moderation and an author reply in
`/admin/reviews`, reader questions answered with ideas in `/admin/questions`, the `question_answered`
email, and the `stale_reader_question` operations rule.

> **One database.** The cloud Supabase project is also production's database. Never run Playwright
> fixtures, `supabase db reset`, pgTAP, or seeded writes against it. Section 7 is local-only. On the
> hosted project, moderate and answer only through the admin pages.

Related: [knowledge hub](knowledge-hub.md) for writing, relating, and publishing the idea that
answers a question, [SEO and operations](seo-and-operations.md) for the worker that sends the email
and for `/admin/operations`, and [storefront caching](storefront-caching.md) for when the book page
shows a moderation change.

## 1. What readers can do

| Action | Who | Where |
| --- | --- | --- |
| Rate and review a book | A reader with an **active** entitlement for it. Finishing the book is not required. | `/{locale}/library/reviews/<book-id>`, linked as **Đánh giá / Review** from the library, as **Viết đánh giá / Write a review** from the book page, and from the reader's completion card. |
| Ask the editors | Any signed-in reader, owner or not. **Off by default for authors** (Press publishes classics; see below). | `/{locale}/ask?book=<book-id>` from the book page and the completion card, or `/{locale}/ask?idea=<idea-id>` from **Ask the editors about this** on an idea page. |

- **One review per reader per edition.** A review says which translation was read; a reader who holds English and Japanese can review each, and one who holds a single edition need not say which. A work's rating is the roll-up of its editions' published reviews, and every public review is labelled with its language.
- **(old rule, now per edition)** One review per reader per book. It carries both a 1–5 star rating and a plain-text body of up
  to 1,000 characters; neither can be sent alone. Saving again edits the same review. The reader can
  delete it from the same page, including after their entitlement is revoked.
- **Questions are capped at 5 open.** A reader who already has 5 questions in `new` is refused
  (`EB035`) and told to wait for an answer; answered and archived questions do not count. A question
  is plain text, up to 500 characters, about one published book or one published idea in the
  reader's locale.
- HTML-tag syntax is refused in reviews, replies, and questions, in the form and in the database.
  Everything renders as text.

## 2. Moderating reviews

Open `/admin/reviews`. The tabs are **Pending** (the default), **Published**, and **Rejected**; each
shows the 200 newest reviews in that state with the book, reviewer, stars, body, and date. A pending
review shows **Publish** and **Reject**, a published one **Reject**, a rejected one **Publish**.

| State | What the reviewer sees on their review page | Book page |
| --- | --- | --- |
| `pending` | *Đang chờ duyệt / Awaiting review* | Not shown. |
| `published` | *Đã đăng / Published* | Shown (the 5 most recently published), counted in the average, and emitted in the Book JSON-LD as `aggregateRating` and `review`. |
| `rejected` | *Không được đăng / Not published* - the state only, never a reason. | Not shown. |

- **Any edit returns the review to `pending`** and takes it off the book page until it is moderated
  again. The author reply is kept. The first publication date is cleared by the edit, so a
  re-published review gets a new date.
- **The reviewer name is a snapshot.** The name shown in `/admin/reviews` and on the book page is
  the reader's profile display name as it was when they saved the review, not their current one. It
  is re-taken on every edit (which also returns the review to `pending`), trimmed and cut to 80
  characters; a name containing HTML-tag syntax is stored as no name and shows as the anonymous
  label (*Độc giả / Reader*). A moderator therefore approves exactly the name the public sees, and a
  later profile rename does not reach a published review.
- Publishing, rejecting, and replying revalidate the storefront, so the book page reflects the change
  within the storefront cache model ([storefront caching](storefront-caching.md)).
- The JSON-LD never carries a rating without visible reviews: `aggregateRating` and `review` appear
  only when the page renders at least one published review, and `review` lists exactly the reviews
  rendered.
- **Stale moderation is refused (`EB036`).** If a reader or another moderator changes the row after
  you open it, Publish/Reject refreshes the list and asks you to read the changed review first.
- **Revoked entitlement.** The review keeps its current state; a published review stays public.
  Its author can still see the rating, body, moderation state and reply, and delete it from its
  review page. Saving changes requires an active entitlement.


## 3. Replying as the author

In a review's row, choose **Reply**, write the reply, and **Save reply**. Save it blank to remove the
reply. A reply can be written in any state, and it is kept when the reviewer edits the review.

- The reply is **public**: it appears under the review on the book page as *Phản hồi từ ban biên tập /
  Reply from the editors*, and on the reviewer's own review page.
- Plain text, up to 1,000 characters. It is written by an admin as the editors; there is no
  separate author account, and it is never presented as the author's own words.
- The reviewer **is emailed** once per distinct reply text, but only while the review is
  **published**: a reply saved on a pending review is mailed when the review is published, and a
  reply changed before the worker runs replaces the pending email rather than adding one. Clearing
  a reply sends nothing. The Published tab shows *Emailed {date}* under the reply once it went out.
- Delivery uses the same outbox and worker as the other emails. A row that fails four times shows
  up under **Stuck book-ready emails** on `/admin/operations` with the summary "Review reply email
  has failed…" and links to the Published tab.

## 4. Answering questions

Open `/admin/questions`. The tabs are **New** (the default), **Answered**, and **Archived**; each
shows the 200 oldest questions in that state with the asker's display name, the target (linked to its
editor), and the body. A new question has three actions:

- **Answer with a new idea** - enter the locale, slug, question (prefilled from the reader's text;
  rewrite it as a proper idea question), and short answer, then **Create idea**. This creates a
  **draft** idea, relates it to the question's book (or to the asked idea's books), links the asked
  idea, marks the question answered, and opens the idea editor. Add the body there and publish it as
  in [knowledge hub](knowledge-hub.md) section 6.
- **Link to idea** - choose an existing idea (published or draft). Use this when the answer already
  exists.
- **Archive** - for a question that will not be answered. Only a new question can be archived.

Choose a new idea when the question is a real question other readers will have; that is how answered
questions become crawlable pages. Choose an existing idea when one already answers it.

### What the asker is emailed, and when

- The asker gets one `question_answered` email when the answering idea is **published**, never when
  it is only linked to a draft (a draft URL would 404). Linking to an idea that is already published
  queues the email at once.
- It goes to the asker's **oldest verified email** (the same identity `book_ready` uses), and it is
  sent by the operations worker on its next run ([SEO and operations](seo-and-operations.md)).
- The link is built **at send time** from the idea's localization in the locale the question was
  asked in, falling back to the idea's other locale when that one is missing. The message copy
  follows the locale of the link.
- **One email per question, ever.** Relinking a question that was already emailed to another idea
  never emails again; the asker's question list on the ask page always shows the current answer.
- **Relinking before delivery.** The existing unsent row is updated to the new answer. A draft
  replacement waits for publication without consuming retry attempts. The first worker claim
  permanently marks delivery as started; an unsent marked row refuses relinking (`EB037`). Let the
  worker finish/recover delivery, then retry. Resetting retry counters does not clear this marker.
  This protects the payload already claimed by the worker; it does not create a second email.
- **Concurrent linking and publishing.** Both lock the answering idea before updating the question,
  so either transaction order queues the notification.
- **Unpublishing does not retract.** An email that was sent stays sent; unpublishing and republishing
  the idea sends nothing new.
- The asker also sees the answer on the ask page: their question shows *Đã trả lời / Answered* and a
  *Đọc câu trả lời / Read the answer* link once the idea is published with a localization in the locale the question was asked in.

### Delivery failures

A failed send is retried by the worker 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours after
each failure, and stops after the sixth. The row's `last_error_code` is one of:

| Code | Cause | Fix |
| --- | --- | --- |
| `recipient_unverified` | The asker has no verified email. | The asker signs in once with a magic link. |
| `unsupported_locale` | At send time the answering idea is unpublished, or has no localization in either locale. | Publish the idea (or add its localization); the next retry sends it. |
| `question_payload_invalid` | The row's payload does not name a valid idea id. | A defect: keep the outbox id and the request id. |
| `question_not_found` | The question was deleted between the claim and the send. Deleting a question (or its profile) also deletes its outbox row, so this is rare. | Nothing: there is nobody to email. |
| `unsupported_template` | The row is missing its question, profile, or payload. | A defect: keep the outbox id and the request id. |
| `profile_not_found` | The asker's profile was deleted between the claim and the send. | Nothing. |
| Resend codes, `delivery_data_unavailable`, `provider_error` | As in [SEO and operations](seo-and-operations.md) section 6. | Same. |

Find a question's row (the payload holds only `{ ideaId }`):

```sql
select id, template_key, attempt_count, last_error_code, available_at, sent_at, provider_message_id
from public.notification_outbox
where question_id = '<question-id>';
```

After fixing the cause of a row that stopped after six failures, make it claimable again with
[SEO and operations](seo-and-operations.md) section 7. The Resend idempotency key is
`question-answered/<outbox-id>`.

## 5. Alerts

- **`stale_reader_question`** - a question still `new` more than 7 days after it was asked is one
  finding on `/admin/operations` (*Unanswered reader questions*, summary "A reader question has
  waited more than 7 days.", review link `/admin/questions`), and the operator alert email follows
  the usual rules. It clears when the question is answered or archived. The finding carries the
  question id and date only.
- **Known gap - stuck `question_answered` email.** The `stuck_notification` rule reports stuck
  `book_ready`, `gift_claim` and `review_replied` rows only. A `question_answered` row that keeps failing raises **no**
  finding and no alert. Check for them with:

  ```sql
  select id, question_id, attempt_count, last_error_code, available_at
  from public.notification_outbox
  where template_key = 'question_answered' and sent_at is null and attempt_count >= 4;
  ```

## 6. Privacy

- A question is readable only by the reader who asked it and by admins. No public page lists
  questions, and the answering idea never names or quotes the asker - rewrite the prefilled question
  before publishing if it is personal.
- A review is public only once published, and only with the snapshot of the reviewer's display name
  taken when they saved it (or *Độc giả / Reader* when they had none, see section 2). No avatar, email, or link to the reader. Public access uses `catalog_book_reviews` only; raw
  rows (including profile id and locale) are readable only by their owner and admins.
- `audit_logs` rows hold ids, never text: `book_review.moderate` records the new status,
  `book_review.reply` whether the reply was cleared, `reader_question.answer` the idea id, and
  `reader_question.archive` nothing beyond the question id. Neither a review body, a reply, nor a
  question body enters an audit row or a worker log.

## 7. Testing (local stack only)

Run these only against a local Supabase stack that this checkout owns. Read
[testing environments](testing-environments.md) first, including its port-ownership warning, its
`--workdir` commands for a scratch stack, and the variables to export before Playwright.

```bash
npm run db:reset                                   # default 543xx stack only
npm run db:test                                    # pgTAP: 059-065 cover S13
npx vitest run lib/reviews lib/questions lib/email lib/ops components/account components/admin/reviews components/admin/questions
npm run test:e2e -- e2e/reader-voice.spec.ts      # after exporting the test variables
```

`e2e/reader-voice.spec.ts` runs three concurrency interleavings with held SQL transactions and both journeys: an owner's review through moderation and a reply onto
the book page and its JSON-LD, then revocation and deletion, and a question from an idea page answered with a new idea whose
publication delivers exactly one `question_answered` email and links the answer on the ask page.
Playwright sends mail through the no-network adapter (`EMAIL_PROVIDER=test`), so the email is
asserted on its outbox row (`provider_message_id` `test/question-answered/<outbox-id>`), not in
Mailpit. The spec creates users and admins with no teardown; **never** point it at the cloud project.

## Reader questions are an editorial channel

Press publishes classic works and their translations. `authors.accepts_questions` defaults to **off**;
turn it on in **Admin > Authors** only when the editors (or a rights holder who has agreed) will
answer. The reader sees "Ask the editors", the answer is attributed to the editors, and the emails
say so. Never switch it on to imply a deceased author is replying. Translation errors are reported
through the same channel until the dedicated report form exists (Task 9).
