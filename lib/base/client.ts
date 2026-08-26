import type { BaseItem, BaseSearchParams, BaseSearchResult } from "./types";

/**
 * Contract every BASE client (real or mock) implements. Keeping this as an
 * interface means the admin UI, the AI generation flow, and the sync job
 * never need to know whether they're talking to the real BASE API or the
 * fixture-backed mock — swapping `BASE_USE_MOCK` is the only thing that
 * changes.
 */
export interface BaseApiClient {
  /**
   * Keyword search across the shop's catalog (e.g. "Softshell", "vitra").
   * If BASE's own search endpoint turns out not to support free-text
   * search well, the real implementation should fall back to listing all
   * items (paginated + cached) and filtering client-side — see the TODO
   * in client.real.ts.
   */
  search(params: BaseSearchParams): Promise<BaseSearchResult>;

  /** Fetch one item by BASE's item id. */
  getItem(itemId: string): Promise<BaseItem | null>;

  /** Fetch many items by id in one call (used when rendering a published feature page). */
  getItems(itemIds: string[]): Promise<BaseItem[]>;
}

export class BaseApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "BaseApiError";
  }
}
