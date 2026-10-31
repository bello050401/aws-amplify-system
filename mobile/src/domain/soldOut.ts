import type { InventoryItem } from './inventory';

export interface SoldOutSaved { sold: InventoryItem; source: InventoryItem }
export class MobileSoldOutError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
