import { describe, expect, it } from "vitest";
import { formatDateOnlyForDisplay, isValidDateOnly, todayDateOnlyJST } from "./date";

describe("isValidDateOnly", () => {
  it("accepts valid YYYY-MM-DD", () => {
    expect(isValidDateOnly("2026-08-28")).toBe(true);
  });
  it("rejects malformed strings", () => {
    expect(isValidDateOnly("2026/08/28")).toBe(false);
    expect(isValidDateOnly("not-a-date")).toBe(false);
  });
  it("rejects impossible calendar dates (no silent rollover)", () => {
    expect(isValidDateOnly("2026-02-30")).toBe(false);
  });
});

describe("formatDateOnlyForDisplay", () => {
  it("converts hyphen to slash", () => {
    expect(formatDateOnlyForDisplay("2026-08-28")).toBe("2026/08/28");
  });
  it("returns dash for empty/invalid values", () => {
    expect(formatDateOnlyForDisplay(null)).toBe("-");
    expect(formatDateOnlyForDisplay(undefined)).toBe("-");
    expect(formatDateOnlyForDisplay("invalid")).toBe("-");
  });
});

describe("todayDateOnlyJST", () => {
  it("returns a well-formed date-only string", () => {
    expect(isValidDateOnly(todayDateOnlyJST())).toBe(true);
  });
});
