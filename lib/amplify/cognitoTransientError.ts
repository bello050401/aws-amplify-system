/** Amplify's NoSignedUser can wrap a Cognito Identity rate limit. The outer
 * name alone is not evidence of a transient failure: an expired or missing
 * session must still follow the signed-out path. */
export function isCognitoRateLimitError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const fields = current as { name?: unknown; code?: unknown; underlyingError?: unknown; cause?: unknown };
    if (fields.name === "TooManyRequestsException" || fields.code === "TooManyRequestsException") return true;
    pending.push(fields.underlyingError, fields.cause);
  }
  return false;
}
