/** A selection is a fixed set of inventory IDs, never a search expression. */
export const MAX_EDIT_SELECTION = 1000;
export type SelectionAction = 'edit' | 'undo' | 'redo' | 'history';
export interface SelectionRequest { requestId: string; ids: string[]; mode: SelectionAction }
export function parseSelectionRequest(value: unknown): SelectionRequest | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 100 ||
      !['edit','undo','redo','history'].includes(String(input.mode)) || !Array.isArray(input.ids) ||
      !input.ids.length || input.ids.length > MAX_EDIT_SELECTION ||
      input.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) return null;
  return {requestId: input.requestId, ids: [...new Set(input.ids as string[])], mode: input.mode as SelectionAction};
}
