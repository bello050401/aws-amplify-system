/** Bounded search workspace for the current catalogue and its 10x load test.
 * This is a processing limit, not a permission to return a truncated result.
 * The persistent/cached candidate projection retains its separate 8 MiB cap. */
export const MAX_SEARCH_CANDIDATES = 100_000;
