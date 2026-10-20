import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { BookReviews } from "@/components/catalog/book-reviews";
import vi from "@/lib/i18n/dictionaries/vi.json";

afterEach(cleanup);

const copy = vi.catalog.reviews;

it("renders the summary, each review with reply, and the two links", () => {
  render(
    <BookReviews
      askHref="/vi/ask?book=b1"
      copy={copy}
      locale="vi"
      reviewHref="/vi/library/reviews/b1"
      reviews={[
        {
          id: "r1",
          reviewerName: null,
          rating: 5,
          body: "Hay",
          authorReply: "Cảm ơn",
          authorReplyAt: "2026-09-13T00:00:00Z",
          publishedAt: "2026-09-12T00:00:00Z",
        },
      ]}
      summary={{ count: 2, average: 4.5 }}
    />,
  );
  expect(screen.getByText("4.5")).toBeInTheDocument();
  expect(screen.getByText("2 đánh giá")).toBeInTheDocument();
  expect(screen.getByText("Độc giả")).toBeInTheDocument();
  expect(screen.getByLabelText("5/5")).toHaveTextContent("★★★★★");
  expect(screen.getByText("Cảm ơn")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Viết đánh giá" })).toHaveAttribute("href", "/vi/library/reviews/b1");
  expect(screen.getByRole("link", { name: "Hỏi tác giả" })).toHaveAttribute("href", "/vi/ask?book=b1");
});

it("renders only the links when there is no summary", () => {
  render(<BookReviews askHref="/y" copy={copy} locale="vi" reviewHref="/x" reviews={[]} summary={null} />);
  expect(screen.queryByText(/^\d+ đánh giá$/)).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(2);
});

it("leaves the ask button out when askHref is null", () => {
  render(<BookReviews askHref={null} copy={copy} locale="vi" reviewHref="/x" reviews={[]} summary={null} />);
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.queryByRole("link", { name: "Hỏi tác giả" })).toBeNull();
});
