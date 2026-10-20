"use client";

import { useActionState, useState } from "react";

import type { ReviewFormState } from "@/app/[lang]/(account)/library/reviews/[bookId]/actions";
import { SubmitButton } from "@/components/auth/submit-button";
import { Textarea } from "@/components/ui/textarea";
import type { MyReview } from "@/lib/data/reviews";
import { fillTemplate } from "@/lib/i18n/format";

const BODY_MAX_LENGTH = 1000;
const RATINGS = [1, 2, 3, 4, 5];

type Copy = {
  ratingLabel: string;
  bodyLabel: string;
  counter: string;
  save: string;
  delete: string;
  states: Record<MyReview["status"], string>;
  authorReply: string;
  errors: { notEntitled: string; failed: string; rating: string; body: string };
  saved: string;
};

type Action = (state: ReviewFormState, formData: FormData) => Promise<ReviewFormState>;

const initialState: ReviewFormState = { fieldErrors: {}, formError: null, savedAt: null };

// Form errors arrive as keys, and field errors are keyed by field: the schema's messages are
// English, so only the keys are used and the customer copy comes from the dictionary.
function formErrorCopy(copy: Copy, formError: string | null): string | null {
  if (formError === null) return null;
  return formError === "not_entitled" ? copy.errors.notEntitled : copy.errors.failed;
}

export function ReviewForm({
  action,
  deleteAction,
  review,
  copy,
  canEdit = true,
}: {
  action: Action;
  deleteAction: () => Promise<void>;
  review: MyReview | null;
  copy: Copy;
  canEdit?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialState);
  const [rating, setRating] = useState(review?.rating ?? 0);
  const [body, setBody] = useState(review?.body ?? "");
  const formError = formErrorCopy(copy, state.formError);

  return (
    <div className="mt-8 space-y-8">
      {review ? (
        <div className="space-y-3 text-sm">
          <p className="inline-flex rounded-sm bg-surface px-2.5 py-1 font-medium">{copy.states[review.status]}</p>
          {review.authorReply ? (
            <div className="border-l-2 border-sand pl-4">
              <p className="text-sage-text">{copy.authorReply}</p>
              <p className="mt-1 whitespace-pre-line">{review.authorReply}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {canEdit ? <form action={formAction} className="space-y-6">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{copy.ratingLabel}</legend>
          <div className="flex gap-1">
            {RATINGS.map((n) => (
              <label
                className={`flex size-11 cursor-pointer items-center justify-center text-3xl has-focus-visible:outline-2 has-focus-visible:outline-forest ${n <= rating ? "text-forest" : "text-sand"}`}
                key={n}
              >
                <input
                  aria-label={`${n}/5`}
                  checked={rating === n}
                  className="sr-only"
                  name="rating"
                  onChange={() => setRating(n)}
                  type="radio"
                  value={n}
                />
                <span aria-hidden="true">★</span>
              </label>
            ))}
          </div>
          {state.fieldErrors.rating ? <p className="mt-1 text-sm text-error" role="alert">{copy.errors.rating}</p> : null}
        </fieldset>

        <div>
          <label className="mb-2 block text-sm font-medium" htmlFor="review-body">{copy.bodyLabel}</label>
          <Textarea
            aria-invalid={state.fieldErrors.body ? true : undefined}
            id="review-body"
            maxLength={BODY_MAX_LENGTH}
            name="body"
            onChange={(event) => setBody(event.target.value)}
            value={body}
          />
          <p className="mt-1 text-right text-xs text-sage-text">{fillTemplate(copy.counter, { count: body.length })}</p>
          {state.fieldErrors.body ? <p className="mt-1 text-sm text-error" role="alert">{copy.errors.body}</p> : null}
        </div>

        {formError ? <p className="text-sm text-error" role="alert">{formError}</p> : null}
        {state.savedAt !== null && !formError ? <p className="text-sm text-forest" role="status">{copy.saved}</p> : null}
        <SubmitButton className="min-h-11" pendingLabel={copy.save}>{copy.save}</SubmitButton>
      </form> : review ? (
        <div className="space-y-2">
          <p aria-label={`${review.rating}/5`}>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</p>
          <p className="whitespace-pre-line">{review.body}</p>
        </div>
      ) : null}

      {review ? (
        <form action={deleteAction}>
          <SubmitButton className="min-h-11" pendingLabel={copy.delete} variant="outline">{copy.delete}</SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
