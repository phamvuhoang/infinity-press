import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  fieldErrorsFrom,
  formatFaq,
  formatKeyIdeas,
  parseFaq,
  parseKeyIdeas,
  readBoolean,
  readInteger,
  readList,
  readOptionalInteger,
  readOptionalText,
  readText,
} from "@/lib/catalog/form";

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

describe("FormData readers", () => {
  it("trims text and treats blanks as missing", () => {
    const data = form([["title", "  Sách  "], ["subtitle", "   "]]);
    expect(readText(data, "title")).toBe("Sách");
    expect(readText(data, "missing")).toBe("");
    expect(readOptionalText(data, "subtitle")).toBeNull();
  });

  it("reads integers, booleans, and lists", () => {
    const data = form([["price", "1500"], ["blank", ""], ["active", "on"], ["topic", "a"], ["topic", ""], ["topic", "b"]]);
    expect(readInteger(data, "price")).toBe(1500);
    expect(readInteger(data, "blank")).toBeUndefined();
    expect(readOptionalInteger(data, "blank")).toBeNull();
    expect(readBoolean(data, "active")).toBe(true);
    expect(readBoolean(data, "missing")).toBe(false);
    expect(readList(data, "topic")).toEqual(["a", "b"]);
  });
});

describe("fieldErrorsFrom", () => {
  it("keeps the first message per field path", () => {
    const schema = z.object({ name: z.string().min(2, "Too short").max(1, "Too long"), nested: z.object({ slug: z.string().min(1, "Enter a slug.") }) });
    const result = schema.safeParse({ name: "a", nested: { slug: "" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(fieldErrorsFrom(result.error)).toEqual({ name: "Too short", "nested.slug": "Enter a slug." });
    }
  });
});

describe("key ideas and FAQ text formats", () => {
  it("round-trips key ideas", () => {
    const items = [{ title: "Quan sát", summary: "Nhìn mà không phán xét." }, { title: "Tự do", summary: "" }];
    expect(parseKeyIdeas(formatKeyIdeas(items))).toEqual(items);
    expect(parseKeyIdeas("\n  Title only  \n")).toEqual([{ title: "Title only", summary: "" }]);
  });

  it("round-trips FAQ entries and skips incomplete ones", () => {
    const items = [{ question: "Ebook đọc ở đâu?", answer: "Trên trình duyệt." }];
    expect(parseFaq(formatFaq(items))).toEqual(items);
    expect(parseFaq("Q: No answer\n\nQ: Complete\nA: Yes")).toEqual([{ question: "Complete", answer: "Yes" }]);
  });
});
