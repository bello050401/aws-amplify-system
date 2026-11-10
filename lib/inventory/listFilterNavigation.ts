/** Change only the requested part of the list. Closing a panel is not a search. */
export function listFilterHref(current: string, changes: Record<string, string | null>, resetPage = true): string {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  if (resetPage) params.delete("offset");
  return params.size ? `/inventory?${params}` : "/inventory";
}
