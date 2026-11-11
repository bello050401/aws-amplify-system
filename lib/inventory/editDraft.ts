import type { InventoryEditRules } from './editTransform';

/** An empty/zero value is still an intentional edit that must be guarded. */
export function hasInventoryEditDraft(rules: InventoryEditRules): boolean {
  return rules.categories.mode !== 'keep' || rules.names.length > 0 ||
    Boolean(rules.location && rules.location.mode !== 'keep') ||
    Object.keys(rules.customFieldChanges ?? {}).length > 0 ||
    Object.keys(rules.fields ?? {}).length > 0;
}
