import { describe, expect, it, vi, beforeEach } from "vitest";

const findManyMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  },
}));

const { generateNextSku, isSkuTaken } = await import("./SkuGenerator");

describe("SkuGenerator (指示書7項: BELLO-000001形式の自動採番)", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    findUniqueMock.mockReset();
  });

  it("starts at BELLO-000001 when no products exist yet", async () => {
    findManyMock.mockResolvedValue([]);
    expect(await generateNextSku()).toBe("BELLO-000001");
  });

  it("increments past the highest existing numeric suffix", async () => {
    findManyMock.mockResolvedValue([
      { sku: "BELLO-000001" },
      { sku: "BELLO-000007" },
      { sku: "BELLO-000003" },
    ]);
    expect(await generateNextSku()).toBe("BELLO-000008");
  });

  it("ignores manually-entered SKUs that don't match the auto-numbered pattern", async () => {
    findManyMock.mockResolvedValue([{ sku: "BELLO-CUSTOM" }, { sku: "BELLO-000002" }]);
    expect(await generateNextSku()).toBe("BELLO-000003");
  });

  it("isSkuTaken returns false when the SKU is free", async () => {
    findUniqueMock.mockResolvedValue(null);
    expect(await isSkuTaken("BELLO-000099")).toBe(false);
  });

  it("isSkuTaken returns true when another product already owns the SKU", async () => {
    findUniqueMock.mockResolvedValue({ id: "other-id", sku: "BELLO-000001" });
    expect(await isSkuTaken("BELLO-000001", "this-product-id")).toBe(true);
  });

  it("isSkuTaken returns false when the SKU belongs to the product being edited", async () => {
    findUniqueMock.mockResolvedValue({ id: "this-product-id", sku: "BELLO-000001" });
    expect(await isSkuTaken("BELLO-000001", "this-product-id")).toBe(false);
  });
});
