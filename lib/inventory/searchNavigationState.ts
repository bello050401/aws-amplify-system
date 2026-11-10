/** Compare the result actually committed by the server, including filters and
 * paging. The same text on a different page is not a completed new search. */
export function searchResultAcknowledges(resultQuery: string, requestedHref: string): boolean {
  const requested = new URL(requestedHref, 'https://bello.invalid');
  if (requested.pathname !== '/inventory' || requested.origin !== 'https://bello.invalid') return false;
  const canonical = (query: URLSearchParams) => {
    // The list omits default paging values from its canonical return URL.
    if (query.get('offset') === '0') query.delete('offset');
    if (query.get('limit') === '50') query.delete('limit');
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

/** A response-received phase must never acknowledge a prefetch/older request,
 * a different filter, another endpoint, or an external origin. It is not proof
 * that results rendered or that a server request succeeded. */
export function isCurrentSearchResource(
  resource: {name:string;initiatorType:string;startTime:number},
  active: {href:string;startedAt:number},
  origin:string,
): boolean {
  if(resource.initiatorType!=="fetch"||resource.startTime<active.startedAt)return false;
  try {
    const url=new URL(resource.name,origin);
    if(url.origin!==origin||url.pathname!=="/inventory"||!url.searchParams.has("_rsc"))return false;
    url.searchParams.delete("_rsc");
    return searchResultAcknowledges(url.search,active.href);
  } catch {return false;}
}

/** A filter follows the committed URL, not React's shared transition lifetime.
 * Another navigation may supersede it; that must not keep the controls locked. */
export function listNavigationStatus(currentQuery: string, request: { from: string; href: string } | null): "idle" | "waiting" | "complete" | "superseded" {
  if (!request) return "idle";
  if (searchResultAcknowledges(currentQuery, request.href)) return "complete";
  if (!searchResultAcknowledges(currentQuery, `/inventory?${request.from}`)) return "superseded";
  return "waiting";
}
