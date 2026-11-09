/** Compare the result actually committed by the server, including filters and
 * paging. The same text on a different page is not a completed new search. */
export function searchResultAcknowledges(resultQuery: string, requestedHref: string): boolean {
  const requested = new URL(requestedHref, 'https://bello.invalid');
  if (requested.pathname !== '/inventory' || requested.origin !== 'https://bello.invalid') return false;
  const canonical = (query: URLSearchParams) => {
    query.sort();
    return query.toString();
  };
  return canonical(new URLSearchParams(resultQuery)) === canonical(requested.searchParams);
}

/** A click/Enter just after the 250ms automatic submission uses that same
 * request, even if it has already committed. A later explicit search still
 * fetches current data. No result or authorization is cached here. */
export function coalesceSearchSubmission(
  previous: { href: string; at: number } | null,
  href: string,
  now: number,
): boolean {
  return previous !== null && previous.href === href && now >= previous.at && now - previous.at < 1000;
}
