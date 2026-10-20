import Link from "next/link";

import { ReviewRow } from "@/components/admin/reviews/review-row";
import type { AdminReviewDTO, AdminReviewStatus } from "@/lib/data/admin-reviews";

export const REVIEW_STATUSES: readonly AdminReviewStatus[] = ["pending", "published", "rejected"];

const label = (status: AdminReviewStatus) => status.charAt(0).toUpperCase() + status.slice(1);

export function ReviewList({ reviews, status }: { reviews: AdminReviewDTO[]; status: AdminReviewStatus }) {
  return (
    <div>
      <nav aria-label="Review status" className="mb-6 flex flex-wrap gap-x-6 gap-y-1 text-sm font-medium">
        {REVIEW_STATUSES.map((tab) => (
          <Link
            aria-current={tab === status ? "page" : undefined}
            className={`inline-flex min-h-11 items-center underline-offset-[6px] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest ${tab === status ? "text-forest underline" : "text-ink"}`}
            href={`/admin/reviews?status=${tab}`}
            key={tab}
          >
            {label(tab)}
          </Link>
        ))}
      </nav>
      {reviews.length === 0 ? (
        <p className="text-sage-text">{`No ${status} reviews.`}</p>
      ) : (
        <div aria-label="Reviews" className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-forest" role="region" tabIndex={0}>
          <table className="w-full min-w-[56rem] text-left text-sm">
            <caption className="sr-only">{`${label(status)} reviews`}</caption>
            <thead>
              <tr className="border-b border-sand text-sage-text">
                <th className="py-2 pr-3 font-medium" scope="col">Book</th>
                <th className="py-2 pr-3 font-medium" scope="col">Reviewer</th>
                <th className="py-2 pr-3 font-medium" scope="col">Rating</th>
                <th className="py-2 pr-3 font-medium" scope="col">Review</th>
                <th className="py-2 pr-3 font-medium" scope="col">Date</th>
                <th className="py-2 font-medium" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <ReviewRow key={review.id} review={review} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
