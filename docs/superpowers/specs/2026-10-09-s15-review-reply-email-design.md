# S15 Review Reply Email Design

**Status:** Approved
**Date:** 2026-10-09
**Roadmap:** PRD 3.5 reading completion (review action), reader–author interaction
**Builds on:** S13 reader voice (reviews, author reply), S5 SEO and operations (outbox, worker, ops rules), S9 (outbox target pattern)
**Related:** S16 shareable quote cards, S17 wishlist

## 1. Goal

S13 left one line open: "Emailing the reviewer when the author replies. Add the email if readers say
they miss it." A reader who wrote a review has no way to know the author answered unless they revisit
the book page. The reply is the one reader–author touchpoint the platform already produces, and it
currently reaches nobody.

S15 closes the loop: when an admin writes or changes the author reply on a published review, the
reviewer gets one email with the reply and a link back to their review page. Nothing else about
reviews changes.

## 2. What S15 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| `notification_outbox` | Worker | A new `review_replied` row per (review, reply revision), claimed and sent by the existing worker |
| Reviewer's inbox | Reviewer | "Tác giả đã phản hồi đánh giá của bạn" with the book title, the reply text, and a link to `/{locale}/library/reviews/[bookId]` |
| `/{locale}/library/reviews/[bookId]` | Reviewer | Unchanged page. It is the landing page of the email |
| `/admin/reviews` | Admin | The reply form shows "The reviewer will be emailed" under the field; a row shows "Emailed" once `sent_at` is set |
| `/admin/operations` | Operator | `review_replied` rows share the existing stuck-outbox rule; no new rule |

## 3. Out of Scope

- Emailing on moderation (approve or reject). A rejected review stays silent, as S13 decided.
- Emailing other readers, the author, or a digest. One email, to one reviewer, per reply.
- A reply thread. The reply stays a single nullable text on the review row.
- Unsubscribe preferences. The email is transactional and tied to an action the reader took.
- Push or in-app notifications.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Trigger point | A database trigger on `book_reviews` after update of `author_reply_at`, not the server action. S13's `question_answered` is a trigger; S5's `book_ready` is a trigger. The mail is a consequence of the row changing, whoever changes it. |
| When to mail | When `author_reply` goes from null to text, or changes to different text, **and** the review is `published`. A reply written on a `pending` or `rejected` review is not mailed, because the reader cannot see it on the book page. It is mailed when the review is later published with a reply present (see §6). |
| Clearing the reply | No email. A cleared reply is an editorial retraction; mailing "the reply was removed" invites a conversation the platform does not host. |
| Edits | Each distinct reply text mails once. Re-saving identical text is a no-op. The row carries `author_reply_notified_text`, the exact reply text last queued; the trigger compares against it. Each new text replaces every waiting row the worker does not currently hold (never claimed, failed, or exhausted) with one fresh row, so two quick edits mail once, a failed row does not retry under an old idempotency key, and an exhausted row does not leave a stuck finding behind. A leased row may be mid-send with the old text, so it is left alone and the fresh row carries the edit. The replacing `DELETE` row-locks and re-checks the lease, which serializes it against the claim's `skip locked`. Replies that existed before S15 are backfilled as already notified. |
| Outbox target | A fourth nullable target column `review_id` with the same "exactly one target" check. `review_id` is **not** unique, because one review can legitimately be mailed again after an edit that lands after delivery. The existing `delivery_generation` column is not reused. |
| Payload | `{ "bookId": uuid }`. The worker reads the current reply text and book title at send time, the same way `question_answered` resolves the idea URL at send time. It never mails a stale reply. |
| Recipient | The reviewer's oldest verified address, via the same lookup `question_answered` uses. |
| Locale | `book_reviews.locale`, which the reviewer chose when writing. |
| Claim rule | `claim_notification_outbox` hands over a review row only while the review is `published`, `author_reply is not null`, and the book is `published` with a localization (the review page 404s otherwise), as it already hands over a question row only while its idea is published. A row for a review that went back to `pending` waits, uncharged, until the review is visible again. The worker re-checks at send time and fails with `review_not_visible` only in the race between claim and send. |

## 5. Data Model

```
book_reviews         + author_reply_notified_text text
                       -- the reply text that was last queued for email; null when never queued

notification_outbox  + review_id uuid references book_reviews(id) on delete cascade
                     template_key check gains 'review_replied'
                     target check: exactly one of entitlement_id, gift_id, question_id, review_id
```

Index: `notification_outbox (review_id) where review_id is not null`.

`claim_notification_outbox` is dropped and recreated to return `review_id`, exactly as S13 did for
`question_id`. Its eligibility predicate gains `or (o.review_id is not null)`. The body is otherwise
the live definition verbatim.

RLS is unchanged: the outbox is admin-select only. The reviewer never reads outbox rows; the admin
list reads `sent_at` through the existing admin policy.

## 6. Trigger

```sql
create function public.book_reviews_notify_on_reply() returns trigger ...
  -- fires BEFORE update of author_reply, author_reply_at, status on book_reviews
  if new.status = 'published'
     and new.author_reply is not null
     and new.author_reply is distinct from new.author_reply_notified_text then
    new.author_reply_notified_text := new.author_reply;
    delete from notification_outbox where review_id = new.id and sent_at is null and lease_token is null;
    insert into notification_outbox (review_id, profile_id, template_key, payload)
    values (new.id, new.profile_id, 'review_replied', jsonb_build_object('bookId', new.book_id));
  end if;
  return new;
```

Because the trigger also watches `status`, the publish path covers the "reply written while
pending, then approved" case with no change to `admin_moderate_review`. `submit_book_review` sets the
row back to `pending` on every reader edit (S13); the author's reply survives that, and the reader
is not mailed again on re-publish because the text matches `author_reply_notified_text`.

It is a `before` trigger on purpose: `book_reviews_revision` bumps `revision` on every update, and a
second, nested update would bump it twice and make the admin's open moderation form stale.
Setting the column on `new` rides the same row write.

## 7. Email

Template `review_replied` in `lib/email/review-replied.ts`, built like `question-answered.ts`:

- Subject (vi): `Tác giả đã phản hồi đánh giá của bạn về "{title}"`
- Subject (en): `The author replied to your review of "{title}"`
- Body: the reviewer's own star count and first 120 characters of their review for context, the
  full reply, and one button to `/{locale}/library/reviews/[bookId]`.
- Plain text through the existing `text.ts` helpers. No HTML from the database reaches the email:
  the reply is plain text by S13's check constraint and is escaped again at render.

The worker branch in `lib/email/outbox.ts` narrows the row, loads the review and the localized book
title with the service-role client, applies the claim rule's re-check from §4, and sends. The link and
copy use the review's locale when the book has a published localization there, else the other
locale's; with none, the row fails with `book_not_visible` rather than mailing a link that 404s.

## 8. Admin

`/admin/reviews`: the reply form adds one sentence under the textarea, from the dictionary, "The
reviewer will be emailed when you save." The list gains an "Emailed" marker read from the latest
outbox row's `sent_at` for that review. No new action; `admin_reply_review` is unchanged.

## 9. Operations

`review_replied` rows enter the existing `stuck_notification` finding without a new rule or
`operations_alert_state` row. The snapshot loader reads the outbox in one branch per target, so it
gains a review branch (joined to a published review with a reply, like the claim) whose finding
links to `/admin/reviews?status=published`.

Logs follow the outbox contract: request ID, outbox row ID, error code. Never the reply text, never
the address.

## 10. Testing

| Layer | Coverage |
| --- | --- |
| pgTAP `066_s15_review_reply_outbox.sql` | Reply on a published review inserts one row; same text again inserts none; changed text before delivery reuses the unsent row; reply on a pending review inserts none until the review is published; a reader edit back to pending makes the row unclaimable; republishing an already-mailed reply inserts none; clearing the reply inserts none; `claim_notification_outbox` returns `review_id`; the admin list carries `replyEmailedAt`; a cascade-deleted review removes its rows; the target check rejects two targets |
| Vitest `lib/email/review-replied.test.ts` | Both locales, subject and link, escaping of `<` in the reply, the 120-grapheme context cut on a grapheme boundary |
| Vitest `lib/email/outbox.test.ts` | The `review_replied` branch sends the reply as read at send time, fails `review_not_visible` for an unpublished review or a cleared reply, and `recipient_unverified` without stopping the batch |
| Vitest `lib/ops/checks.test.ts`, `lib/data/operations.test.ts` | A review row past the attempt floor is a `stuck_notification` finding linking to the published reviews tab |
| Playwright `reader-voice.spec.ts` (extend) | Reader reviews, admin publishes and replies, worker runs, Mailpit holds one mail with the link, the link opens the review page signed in |

## 11. Exit Criteria

- A reply on a published review produces exactly one email per distinct reply text.
- No email is sent for a review the reader cannot see on the book page.
- The email body is plain text from the database rendered through the existing escaping path.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
- `lib/supabase/database.types.ts` reflects the new column and the recreated function signature.
