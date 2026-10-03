/** Fetch every result page or fail explicitly; the request-ID index is not time ordered. */
export async function collectReadResultPages<T>(
  fetchPage: (nextToken?: string) => Promise<{ items: T[]; nextToken?: string | null }>,
  maxPages = 20,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const response = await fetchPage(token);
    all.push(...response.items);
    if (!response.nextToken) return all;
    if (seen.has(response.nextToken)) throw new Error("Mercari bridge result cursor repeated");
    seen.add(response.nextToken);
    token = response.nextToken;
  }
  throw new Error("Mercari bridge result list exceeds the safe page limit");
}
