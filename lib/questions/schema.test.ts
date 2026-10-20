import { describe, expect, it } from "vitest";

import { questionInputSchema } from "@/lib/questions/schema";

const ID = "30000000-0000-4000-8000-000000000001";

describe("questionInputSchema", () => {
  it("accepts a book or an idea target and trims the body", () => {
    expect(questionInputSchema.parse({ body: "  Why?  ", bookId: ID })).toEqual({ body: "Why?", bookId: ID });
    expect(questionInputSchema.parse({ body: "Why?", ideaId: ID })).toEqual({ body: "Why?", ideaId: ID });
  });
  it("rejects no target", () => {
    const result = questionInputSchema.safeParse({ body: "Why?" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["target"]);
  });
  it("rejects html, empty and 501-character bodies", () => {
    expect(questionInputSchema.safeParse({ body: "<b>x</b>", bookId: ID }).success).toBe(false);
    expect(questionInputSchema.safeParse({ body: "  ", bookId: ID }).success).toBe(false);
    expect(questionInputSchema.safeParse({ body: "a".repeat(501), bookId: ID }).success).toBe(false);
    expect(questionInputSchema.safeParse({ body: "a".repeat(500), bookId: ID }).success).toBe(true);
  });
});
