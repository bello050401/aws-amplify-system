import { describe, expect, it } from "vitest";
import {
  SHIPPING_DURATIONS,
  shippingDurationLabel,
  shippingDurationToMercariValue,
} from "./shippingDuration";

describe("shippingDuration mapper", () => {
  it("covers the 4 durations from the spec (指示書25項)", () => {
    expect(SHIPPING_DURATIONS).toHaveLength(4);
    expect(SHIPPING_DURATIONS.map((d) => d.label)).toEqual([
      "1〜2日",
      "2〜3日",
      "4〜7日",
      "8日以上",
    ]);
  });

  it("throws on an unknown code instead of silently mapping it", () => {
    expect(() => shippingDurationToMercariValue("UNKNOWN")).toThrow();
  });

  it("falls back to the raw code when a label is unknown", () => {
    expect(shippingDurationLabel("UNKNOWN")).toBe("UNKNOWN");
  });
});
