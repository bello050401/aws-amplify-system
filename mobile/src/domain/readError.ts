export class InventoryReadError extends Error {
  constructor(public readonly code: "not_found" | "unavailable") {
    super(code);
    this.name = "InventoryReadError";
  }
}
