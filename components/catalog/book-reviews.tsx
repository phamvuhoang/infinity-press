import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { CatalogReviewSummary } from "@/lib/catalog/public-types";
import type { PublicReview } from "@/lib/data/reviews";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { fillCountTemplate, formatDate } from "@/lib/i18n/format";

export type BookReviewsCopy = Dictionary["catalog"]["reviews"];

function Stars({ rating }: { rating: number }) {
  return (
    <span aria-label={`${rating}/5`} className="text-forest" role="img">
      {"★".repeat(rating) + "☆".repeat(5 - rating)}
    </span>
  );
}

// Server component: the book page is prerendered, so published reviews arrive as props.
export function BookReviews({
  locale,
  copy,
  summary,
  reviews,
  reviewHref,
  askHref,
}: {
  locale: Locale;
  copy: BookReviewsCopy;
  summary: CatalogReviewSummary | null;
  reviews: PublicReview[];
  reviewHref: string;
  // Null when the author does not take questions: the button is left out, not disabled.
  askHref: string | null;
}) {
  return (
    <div className="space-y-6">
      {summary ? (
        <p className="flex flex-wrap items-baseline gap-x-3 text-[0.9375rem] text-ink-soft">
          <span className="sr-only">{copy.average}</span>
          <span className="font-serif text-3xl text-ink">{summary.average}</span>
          <span>{fillCountTemplate(locale, summary.count, { one: copy.countOne, other: copy.countOther })}</span>
        </p>
      ) : null}

      {reviews.length > 0 ? (
        <ul className="divide-y divide-hairline border-y border-hairline">
          {reviews.map((review) => (
            <li className="space-y-2 py-5" key={review.id}>
              <div className="flex flex-wrap items-center gap-x-3 text-[0.9375rem]">
                <Stars rating={review.rating} />
                <span className="font-medium">{review.reviewerName ?? copy.anonymousReader}</span>
                <time className="text-xs text-sage-text" dateTime={review.publishedAt}>
                  {formatDate(review.publishedAt, locale)}
                </time>
              </div>
              <p className="text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{review.body}</p>
              {review.authorReply ? (
                <p className="ml-4 border-l-2 border-sand pl-4 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">
                  <span className="font-medium text-ink">{copy.authorReply}</span> {review.authorReply}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.9375rem] text-ink-soft">{copy.empty}</p>
      )}

      <div className="flex flex-wrap gap-3">
        <Button render={<Link href={reviewHref} />} variant="outline">
          {copy.write}
        </Button>
        {askHref ? (
          <Button render={<Link href={askHref} />} variant="outline">
            {copy.ask}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
