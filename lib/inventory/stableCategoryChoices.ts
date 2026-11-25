export interface PickerChoice { value: string; label: string; sortOrder?: number }

/** Keep the supplied master/workflow order, independent of the current selection.
 * Refreshes can update labels and append new masters without moving surviving targets. */
export function stableCategoryChoices<T extends PickerChoice>(previous: readonly T[], incoming: readonly T[]): T[] {
  const available = new Map(incoming.map(choice => [choice.value, choice]));
  const retained = previous.flatMap(choice => {
    const current = available.get(choice.value);
    if (!current) return [];
    available.delete(choice.value);
    return [current];
  });
  const added = [...available.values()];
  return [...retained, ...added];
}
