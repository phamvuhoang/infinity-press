import { describe, expect, it } from "vitest";

import { currencyExponent, MAX_MINOR, minorFromMajorText, minorFromTransport, minorToMajorText } from "@/lib/commerce/money";

describe("currencyExponent", () => {
  it.each([
    ["VND", 0],
    ["JPY", 0],
    ["USD", 2],
  ])("%s has %i minor digits", (currency, exponent) => {
    expect(currencyExponent(currency)).toBe(exponent);
  });

  it("refuses a code that is not a currency", () => {
    expect(() => currencyExponent("XYZ1")).toThrow();
  });
});

describe("minorFromMajorText", () => {
  it.each([
    ["500", "JPY", 500],
    ["50000", "VND", 50000],
    ["50,000", "VND", null],
    ["5", "USD", 500],
    ["5.1", "USD", 510],
    ["5.10", "USD", 510],
    ["0.07", "USD", 7],
    ["19.99", "USD", 1999],
    ["1.005", "USD", null],
    ["500.5", "JPY", null],
    ["-1", "USD", null],
    ["", "USD", null],
    ["1e3", "USD", null],
    ["12abc", "USD", null],
  ])("reads %j in %s as %j minor units", (text, currency, expected) => {
    expect(minorFromMajorText(text, currency)).toBe(expected);
  });

  it("does not round through binary floating point", () => {
    // 0.1 + 0.2 and 1.15 * 100 both misbehave as floats; exact decimal parsing must not.
    expect(minorFromMajorText("1.15", "USD")).toBe(115);
    expect(minorFromMajorText("4.35", "USD")).toBe(435);
  });

  it("refuses an amount beyond the safe integer range instead of rounding it", () => {
    expect(minorFromMajorText(String(MAX_MINOR), "VND")).toBe(MAX_MINOR);
    expect(minorFromMajorText(String(MAX_MINOR + 1), "VND")).toBeNull();
    expect(minorFromMajorText("99999999999999999999", "VND")).toBeNull();
  });
});

describe("minorToMajorText", () => {
  it.each([
    [500, "JPY", "500"],
    [50000, "VND", "50000"],
    [500, "USD", "5.00"],
    [7, "USD", "0.07"],
    [1999, "USD", "19.99"],
  ])("writes %i minor %s as %s", (minor, currency, expected) => {
    expect(minorToMajorText(minor, currency)).toBe(expected);
  });
});

describe("minorFromTransport", () => {
  it("reads the decimal string a bigint travels as", () => {
    expect(minorFromTransport("50000")).toBe(50000);
    expect(minorFromTransport(500)).toBe(500);
  });

  it.each(["1.5", "-1", "abc", "", String(MAX_MINOR + 1)])("refuses %j", (value) => {
    expect(() => minorFromTransport(value)).toThrow();
  });

  it("refuses a number that is not a safe whole amount", () => {
    expect(() => minorFromTransport(1.5)).toThrow();
    expect(() => minorFromTransport(MAX_MINOR + 1)).toThrow();
  });
});
