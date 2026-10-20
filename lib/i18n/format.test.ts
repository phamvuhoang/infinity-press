import { describe, expect, it } from "vitest";

import { fillCountTemplate, fillTemplate, formatDate } from "@/lib/i18n/format";

describe("fillTemplate", () => {
  it("replaces known placeholders and keeps unknown ones", () => {
    expect(fillTemplate("Book {position} in {series} {missing}", { position: 2, series: "Harbour" })).toBe(
      "Book 2 in Harbour {missing}",
    );
  });
});

describe("fillCountTemplate", () => {
  const forms = { one: "{count} book", other: "{count} books" };

  it("uses the singular form for one in English", () => {
    expect(fillCountTemplate("en", 1, forms)).toBe("1 book");
  });

  it("uses the plural form for zero and many in English", () => {
    expect(fillCountTemplate("en", 0, forms)).toBe("0 books");
    expect(fillCountTemplate("en", 2, forms)).toBe("2 books");
  });

  it("uses the other form in Vietnamese, which has no plural", () => {
    expect(fillCountTemplate("vi", 1, { one: "{count} cuốn (one)", other: "{count} cuốn sách" })).toBe("1 cuốn sách");
  });
});

describe("formatDate", () => {
  it("formats in Vietnam time", () => {
    // 20:00 UTC on 15 September is 03:00 on 16 September in Asia/Ho_Chi_Minh.
    expect(formatDate("2026-09-15T20:00:00Z", "en")).toBe("Sep 16, 2026");
    expect(formatDate("2026-09-15T20:00:00Z", "vi")).toContain("2026");
  });

  it("adds the time when asked", () => {
    expect(formatDate("2026-09-15T20:00:00Z", "en", { withTime: true })).toMatch(/3:00/);
  });
});
