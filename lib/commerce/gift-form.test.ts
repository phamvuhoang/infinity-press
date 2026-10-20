// @vitest-environment node
import { describe, expect, it } from "vitest";

import { GIFT_MESSAGE_MAX_LENGTH, GIFT_RECIPIENT_EMAIL_MAX_LENGTH, giftCheckoutSchema } from "@/lib/commerce/gift-form";

function parse(input: unknown) {
  return giftCheckoutSchema.parse(input);
}

describe("giftCheckoutSchema", () => {
  it("normalizes the recipient email to trimmed lower case", () => {
    expect(parse({ recipientEmail: "  Recipient@Example.COM \n", message: "Chúc mừng!" })).toEqual({
      recipientEmail: "recipient@example.com",
      message: "Chúc mừng!",
    });
  });

  it("trims the message and keeps it up to the maximum length", () => {
    const message = "m".repeat(GIFT_MESSAGE_MAX_LENGTH);

    expect(GIFT_MESSAGE_MAX_LENGTH).toBe(500);
    expect(parse({ recipientEmail: "a@example.com", message: `  ${message}  ` })).toEqual({
      recipientEmail: "a@example.com",
      message,
    });
  });

  it.each([
    ["an omitted message", undefined],
    ["an empty message", ""],
    ["a whitespace-only message", "   \n\t "],
  ])("turns %s into null", (_label, message) => {
    expect(parse({ recipientEmail: "a@example.com", ...(message === undefined ? {} : { message }) })).toEqual({
      recipientEmail: "a@example.com",
      message: null,
    });
  });

  it.each([
    ["a missing address", undefined],
    ["a blank address", "   "],
    ["an address with no domain", "recipient@"],
    ["an address with no local part", "@example.com"],
    ["a bare word", "recipient"],
  ])("refuses %s", (_label, recipientEmail) => {
    expect(giftCheckoutSchema.safeParse({ recipientEmail }).success).toBe(false);
  });

  // gifts.recipient_email is CHECKed at 3-320 characters, so an address longer than that must come
  // back as a field error rather than reaching the database and failing as a raw 23514.
  it("refuses an address longer than the database allows", () => {
    const tooLong = `${"a".repeat(310)}@example.com`;

    expect(GIFT_RECIPIENT_EMAIL_MAX_LENGTH).toBe(320);
    expect(tooLong.length).toBeGreaterThan(GIFT_RECIPIENT_EMAIL_MAX_LENGTH);
    const result = giftCheckoutSchema.safeParse({ recipientEmail: tooLong });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["recipientEmail"]);
  });

  it("accepts an address at exactly the maximum length", () => {
    const atLimit = `${"a".repeat(GIFT_RECIPIENT_EMAIL_MAX_LENGTH - "@example.com".length)}@example.com`;

    expect(atLimit).toHaveLength(GIFT_RECIPIENT_EMAIL_MAX_LENGTH);
    expect(parse({ recipientEmail: atLimit }).recipientEmail).toBe(atLimit);
  });

  it("refuses a 501-character message", () => {
    const result = giftCheckoutSchema.safeParse({
      recipientEmail: "a@example.com",
      message: "m".repeat(GIFT_MESSAGE_MAX_LENGTH + 1),
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["message"]);
  });

  it("measures the message after trimming, so surrounding whitespace never pushes it over", () => {
    const message = "m".repeat(GIFT_MESSAGE_MAX_LENGTH);

    expect(parse({ recipientEmail: "a@example.com", message: `\n${message}\n` }).message).toBe(message);
  });
});
