import { describe, expect, it } from "vitest";
import { PRODUCT_CONDITIONS, conditionLabel, conditionToMercariValue } from "./condition";

describe("condition mapper", () => {
  it("covers all 6 condition levels from the spec (指示書13項)", () => {
    expect(PRODUCT_CONDITIONS).toHaveLength(6);
  });

  it("returns the Japanese label for a known code", () => {
    expect(conditionLabel("NO_NOTABLE_DAMAGE")).toBe("目立った傷や汚れなし");
  });

  it("returns a Mercari API value for a known code", () => {
    expect(conditionToMercariValue("SLIGHT_DAMAGE")).toBe("SLIGHT_DAMAGE");
  });

  it("every entry has a non-empty label and mercariValue", () => {
    for (const c of PRODUCT_CONDITIONS) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.mercariValue.length).toBeGreaterThan(0);
    }
  });
});
