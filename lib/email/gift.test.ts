import { describe, expect, it } from "vitest";

import { buildGiftClaimEmail } from "@/lib/email/gift";

const CLAIM_URL = "https://books.example.com/en/gifts/claim/Zm9vLWJhcl9iYXo";

function build(overrides: Partial<Parameters<typeof buildGiftClaimEmail>[0]> = {}) {
  return buildGiftClaimEmail({
    locale: "en",
    purchaserName: "Ada",
    message: "Enjoy!",
    claimUrl: CLAIM_URL,
    itemTitles: ["Deep Work"],
    ...overrides,
  });
}

describe("buildGiftClaimEmail", () => {
  it("names the purchaser in the subject and the body", () => {
    const email = build();

    expect(email.subject).toBe("Ada sent you a gift on Infinity Books Press");
    expect(email.text).toContain("Ada has sent you a gift on Infinity Books Press.");
    expect(email.html).toContain("Ada has sent you a gift on Infinity Books Press.");
  });

  it("falls back to localized generic copy when the purchaser has no name", () => {
    const en = build({ purchaserName: null });
    // Whitespace is not a name either: a display name of spaces must not produce "  sent you...".
    const blank = build({ purchaserName: "   " });
    const vi = build({ locale: "vi", purchaserName: null });

    expect(en.subject).toBe("You have been sent a gift on Infinity Books Press");
    expect(en.text).toContain("Someone has sent you a gift on Infinity Books Press.");
    expect(blank.subject).toBe(en.subject);
    expect(vi.subject).toBe("Bạn được tặng một món quà trên Infinity Books Press");
    expect(vi.text).toContain("Một người đã gửi tặng bạn một món quà trên Infinity Books Press.");
  });

  it("renders the claim URL as the only link, in both text and html", () => {
    const email = build();

    expect(email.text).toContain(CLAIM_URL);
    expect(email.html).toContain(`href="${CLAIM_URL}"`);
    expect(email.html.match(/href=/g)).toHaveLength(1);
  });

  it("lists every gifted title and omits the section when there are none", () => {
    const many = build({ itemTitles: ["First", "Second", "Third"] });

    expect(many.text).toContain("First");
    expect(many.text).toContain("Second");
    expect(many.text).toContain("Third");
    expect(many.html).toContain("<li>Third</li>");

    const none = build({ itemTitles: [] });
    expect(none.text).not.toContain("Your gift includes:");
    expect(none.html).not.toContain("<ul>");
  });

  it("omits the message block entirely when there is no message", () => {
    const none = build({ message: null });

    expect(none.text).not.toContain("Their message:");
    expect(none.html).not.toContain("Their message:");
  });

  it("escapes hostile html in the purchaser name, the message and the titles", () => {
    const email = build({
      purchaserName: '<img src=x onerror="alert(1)">',
      message: "</p><script>alert('xss')</script>",
      itemTitles: ["<b>Bold</b> & \"quoted\""],
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("<b>Bold</b>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot;");
    // The text part is not markup, so it carries the raw characters - what must not happen is an
    // escaped value leaking into the subject or the link.
    expect(email.text).toContain("<b>Bold</b>");
  });

  it("escapes a hostile claim URL rather than letting it close the attribute", () => {
    const email = build({ claimUrl: 'https://evil.test/" onmouseover="alert(1)' });

    expect(email.html).toContain("&quot; onmouseover=&quot;");
    expect(email.html).not.toContain('" onmouseover="alert(1)"');
  });

  it("strips CR and LF from the subject so no header can be injected", () => {
    const email = build({ purchaserName: "Ada\r\nBcc: victim@example.com\nX-Evil: 1" });

    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toBe("Ada Bcc: victim@example.com X-Evil: 1 sent you a gift on Infinity Books Press");
  });

  it("inserts a value that looks like a placeholder literally", () => {
    const email = build({ purchaserName: "{name}" });

    expect(email.subject).toBe("{name} sent you a gift on Infinity Books Press");
  });

  it("keeps the recipient's line breaks in the message without turning them into markup", () => {
    const email = build({ message: "Line one\nLine two" });

    expect(email.text).toContain("Line one\nLine two");
    expect(email.html).toContain("Line one<br>Line two");
  });

  it("renders the Vietnamese message end to end", () => {
    const email = build({ locale: "vi", message: "Chúc mừng!", itemTitles: ["Nhà giả kim"] });

    expect(email.subject).toBe("Ada đã gửi tặng bạn một món quà trên Infinity Books Press");
    expect(email.text).toContain("Lời nhắn:");
    expect(email.text).toContain("Chúc mừng!");
    expect(email.text).toContain("Nhà giả kim");
    expect(email.html).toContain("Mở món quà của bạn");
  });
});
