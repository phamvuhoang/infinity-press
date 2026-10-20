// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildBookReadyEmail } from "@/lib/email/book-ready";

describe("buildBookReadyEmail", () => {
  it("renders English copy with the title, name, and absolute library link", () => {
    const email = buildBookReadyEmail({
      locale: "en",
      recipientName: "Ada",
      bookTitle: "Deep Work",
      libraryUrl: "https://books.example.com/en/library",
    });

    expect(email.subject).toBe("Your book is ready: Deep Work");
    expect(email.text).toContain("Hi Ada,");
    expect(email.text).toContain("“Deep Work” is now in your Infinity Books library");
    expect(email.text).toContain("Open your library: https://books.example.com/en/library");
    expect(email.html).toContain('<a href="https://books.example.com/en/library">Open your library</a>');
    expect(email.html).toContain("<p>Hi Ada,</p>");
  });

  it("renders Vietnamese copy", () => {
    const email = buildBookReadyEmail({
      locale: "vi",
      recipientName: "Minh",
      bookTitle: "Nhà giả kim",
      libraryUrl: "https://books.example.com/vi/library",
    });

    expect(email.subject).toBe("Sách của bạn đã sẵn sàng: Nhà giả kim");
    expect(email.text).toContain("Chào Minh,");
    expect(email.text).toContain("“Nhà giả kim” đã có trong thư viện Infinity Books của bạn");
    expect(email.text).toContain("Mở thư viện của bạn: https://books.example.com/vi/library");
    expect(email.html).toContain('<a href="https://books.example.com/vi/library">Mở thư viện của bạn</a>');
  });

  it("uses a generic greeting when there is no display name", () => {
    for (const recipientName of [null, "   "]) {
      const email = buildBookReadyEmail({
        locale: "en",
        recipientName,
        bookTitle: "Deep Work",
        libraryUrl: "https://books.example.com/en/library",
      });
      expect(email.text.startsWith("Hi,\n")).toBe(true);
      expect(email.html).toContain("<p>Hi,</p>");
    }
  });

  it("uses generic copy without any title when the locale has no localization", () => {
    const email = buildBookReadyEmail({
      locale: "vi",
      recipientName: null,
      bookTitle: null,
      libraryUrl: "https://books.example.com/vi/library",
    });

    expect(email.subject).toBe("Cuốn sách mới của bạn đã sẵn sàng");
    expect(email.text).toContain("Xin chào,");
    expect(email.text).toContain("Cuốn sách mới đã có trong thư viện Infinity Books của bạn");
    expect(email.html).toContain('<a href="https://books.example.com/vi/library">');
  });

  it("escapes catalog and customer text in HTML but keeps it readable in text", () => {
    const email = buildBookReadyEmail({
      locale: "en",
      recipientName: `<b>Eve</b> & "Mallory" 'x'`,
      bookTitle: `<script>alert("x")</script> & 'Co'`,
      libraryUrl: `https://books.example.com/en/library?a=1&b="2"`,
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>Eve</b>");
    expect(email.html).toContain("&lt;b&gt;Eve&lt;/b&gt; &amp; &quot;Mallory&quot; &#39;x&#39;");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;");
    expect(email.html).toContain('href="https://books.example.com/en/library?a=1&amp;b=&quot;2&quot;"');
    expect(email.text).toContain(`“<script>alert("x")</script> & 'Co'”`);
  });

  it("keeps a template placeholder pattern in a title literal", () => {
    const email = buildBookReadyEmail({
      locale: "en",
      recipientName: "{title}",
      bookTitle: "$& {name} $1",
      libraryUrl: "https://books.example.com/en/library",
    });

    expect(email.subject).toBe("Your book is ready: $& {name} $1");
    expect(email.text).toContain("Hi {title},");
  });

  it("keeps line breaks out of the subject", () => {
    const email = buildBookReadyEmail({
      locale: "en",
      recipientName: null,
      bookTitle: "Line\r\nBcc: someone@example.com",
      libraryUrl: "https://books.example.com/en/library",
    });

    expect(email.subject).toBe("Your book is ready: Line Bcc: someone@example.com");
  });
});
