// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildReviewRepliedEmail } from "@/lib/email/review-replied";

const base = {
  locale: "vi" as const,
  recipientName: "Minh",
  bookTitle: "Sách S15",
  rating: 5,
  reviewBody: "Cuốn sách rất hay.",
  reply: "Cảm ơn bạn đã đọc.",
  reviewUrl: "https://books.example/vi/library/reviews/b1",
};

describe("buildReviewRepliedEmail", () => {
  it("renders the Vietnamese email with the title in the subject, the context, the reply and the link", () => {
    const mail = buildReviewRepliedEmail(base);
    expect(mail.subject).toBe("Tác giả đã phản hồi đánh giá của bạn về “Sách S15”");
    expect(mail.text).toContain("Chào Minh,");
    expect(mail.text).toContain("Đánh giá của bạn (5/5):\nCuốn sách rất hay.");
    expect(mail.text).toContain("Phản hồi từ tác giả:\nCảm ơn bạn đã đọc.");
    expect(mail.text).toContain("Mở đánh giá của bạn: https://books.example/vi/library/reviews/b1");
    expect(mail.html).toContain('<a href="https://books.example/vi/library/reviews/b1">');
  });

  it("uses the generic subject and greeting without a title or a name", () => {
    const mail = buildReviewRepliedEmail({ ...base, locale: "en", recipientName: "  ", bookTitle: null });
    expect(mail.subject).toBe("The author replied to your review");
    expect(mail.text).toContain("Hi,\n");
  });

  it("cuts the review context at 120 graphemes on a grapheme boundary and marks the cut", () => {
    const body = "ế".repeat(130);
    const mail = buildReviewRepliedEmail({ ...base, reviewBody: body });
    expect(mail.text).toContain(`${"ế".repeat(120)}…`);
    expect(mail.text).not.toContain("ế".repeat(121));
  });

  it("escapes the reply, the body, the title and the name in HTML", () => {
    const mail = buildReviewRepliedEmail({
      ...base,
      recipientName: "<b>Eve</b>",
      bookTitle: "<i>T</i>",
      reviewBody: "<script>x</script>",
      reply: "a < b & c",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>Eve");
    expect(mail.html).toContain("a &lt; b &amp; c");
    expect(mail.html).toContain("&lt;i&gt;T&lt;/i&gt;");
  });

  it("keeps a newline in the title out of the subject header", () => {
    const mail = buildReviewRepliedEmail({ ...base, bookTitle: "A\r\nBcc: x" });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});
