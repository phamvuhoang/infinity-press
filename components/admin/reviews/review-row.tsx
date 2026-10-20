"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { moderateReviewAction, replyReviewAction } from "@/app/admin/reviews/actions";
import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState } from "@/lib/catalog/form";
import type { AdminReviewDTO } from "@/lib/data/admin-reviews";
import { formatDate } from "@/lib/i18n/format";

const stars = (rating: number) => "★".repeat(rating) + "☆".repeat(Math.max(0, 5 - rating));

function ModerateButton({ id, revision, to, label, pending }: { id: string; revision: number; to: "published" | "rejected"; label: string; pending: string }) {
  const [state, action] = useActionState(moderateReviewAction.bind(null, id, to, revision), initialAdminFormState);
  return (
    <form action={action}>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11" pendingLabel={pending} size="sm" variant={to === "rejected" ? "outline" : "default"}>
        {label}
      </SubmitButton>
    </form>
  );
}

function ReplyForm({ review }: { review: AdminReviewDTO }) {
  const [state, formAction] = useActionState(replyReviewAction.bind(null, review.id), initialAdminFormState);
  const fieldId = `reply-${review.id}`;
  return (
    <form action={formAction} className="mt-3 w-full max-w-md space-y-2">
      <Label htmlFor={fieldId}>Reply</Label>
      <Textarea
        aria-describedby={state.fieldErrors.reply ? `${fieldId}-error` : undefined}
        aria-invalid={Boolean(state.fieldErrors.reply)}
        defaultValue={review.authorReply ?? ""}
        id={fieldId}
        maxLength={1000}
        name="reply"
        rows={3}
      />
      <p className="text-[0.8125rem] text-sage-text">Plain text. Leave blank and save to remove the reply.</p>
      <p className="text-[0.8125rem] text-sage-text">The reviewer is emailed once the review is published and the reply is saved.</p>
      <FieldError id={`${fieldId}-error`} message={state.fieldErrors.reply} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11" pendingLabel="Saving…" size="sm">
        Save reply
      </SubmitButton>
    </form>
  );
}

// One moderation row. The reply disclosure lives inside the row so the row, found by its book
// title, holds every control for that review.
export function ReviewRow({ review }: { review: AdminReviewDTO }) {
  const [replyOpen, setReplyOpen] = useState(false);
  const panelId = `reply-panel-${review.id}`;

  return (
    <tr className="border-b border-sand align-top">
      <th className="py-3 pr-3 font-normal" scope="row">
        <Link
          className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
          href={`/admin/books/${review.bookId}`}
        >
          {review.bookTitle}
          {review.languageCode ? ` (${review.languageCode})` : ""}
        </Link>
      </th>
      <td className="py-3 pr-3">{review.reviewerName ?? "Reader"}</td>
      <td className="py-3 pr-3 whitespace-nowrap">
        <span aria-label={`${review.rating} out of 5`} role="img">{stars(review.rating)}</span>
      </td>
      <td className="max-w-[28rem] py-3 pr-3">
        <p className="whitespace-pre-wrap">{review.body}</p>
        {review.authorReply ? (
          <p className="mt-2 border-l-2 border-sand pl-3 whitespace-pre-wrap text-ink-soft">
            <span className="font-medium">Author reply: </span>
            {review.authorReply}
            {review.replyEmailedAt ? (
              <span className="mt-1 block text-[0.8125rem] text-sage-text">{`Emailed ${formatDate(review.replyEmailedAt, "en")}`}</span>
            ) : null}
          </p>
        ) : null}
      </td>
      <td className="py-3 pr-3 whitespace-nowrap">{formatDate(review.createdAt, "en")}</td>
      <td className="py-3">
        <div className="flex flex-wrap items-start gap-2">
          {review.status !== "published" ? <ModerateButton revision={review.revision} id={review.id} label="Publish" pending="Publishing…" to="published" /> : null}
          {review.status !== "rejected" ? <ModerateButton revision={review.revision} id={review.id} label="Reject" pending="Rejecting…" to="rejected" /> : null}
          <Button
            aria-controls={panelId}
            aria-expanded={replyOpen}
            className="min-h-11"
            onClick={() => setReplyOpen((open) => !open)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Reply
          </Button>
        </div>
        <div id={panelId}>{replyOpen ? <ReplyForm review={review} /> : null}</div>
      </td>
    </tr>
  );
}
