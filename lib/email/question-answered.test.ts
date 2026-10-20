// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildQuestionAnsweredEmail } from "@/lib/email/question-answered";

describe("buildQuestionAnsweredEmail", () => {
  it("renders the Vietnamese answer email with the idea link", () => {
    const mail = buildQuestionAnsweredEmail({
      locale: "vi",
      recipientName: "Minh",
      ideaTitle: "Tại sao vẫn phải đọc?",
      ideaUrl: "https://books.example/vi/ideas/tai-sao",
    });
    expect(mail.subject).toBe("Tác giả đã trả lời câu hỏi của bạn");
    expect(mail.text).toContain("Chào Minh,");
    expect(mail.text).toContain("Tại sao vẫn phải đọc?");
    expect(mail.text).toContain("https://books.example/vi/ideas/tai-sao");
    expect(mail.html).toContain('<a href="https://books.example/vi/ideas/tai-sao">');
  });

  it("renders English copy and a generic greeting without a name", () => {
    const mail = buildQuestionAnsweredEmail({
      locale: "en",
      recipientName: "  ",
      ideaTitle: "Why still read?",
      ideaUrl: "https://books.example/en/ideas/why",
    });
    expect(mail.subject).toBe("The author answered your question");
    expect(mail.text).toContain("Hi,\n");
    expect(mail.text).toContain("Read the answer: https://books.example/en/ideas/why");
  });

  it("escapes the idea title and name in HTML", () => {
    const mail = buildQuestionAnsweredEmail({
      locale: "en",
      recipientName: "<b>Eve</b>",
      ideaTitle: "<script>x</script>",
      ideaUrl: "https://books.example/en/ideas/x",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>Eve");
    expect(mail.html).toContain("&lt;script&gt;");
  });
});
