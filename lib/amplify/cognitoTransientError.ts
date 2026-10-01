/** Amplify's NoSignedUser can wrap a Cognito Identity rate limit. The outer
 * name alone is not evidence of a transient failure: an expired or missing
 * session must still follow the signed-out path. */
function hasNestedAuthError(error: unknown, matches: (fields: { name?: unknown; code?: unknown; message?: unknown }) => boolean): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const fields = current as { name?: unknown; code?: unknown; message?: unknown; underlyingError?: unknown; cause?: unknown };
    if (matches(fields)) return true;
    pending.push(fields.underlyingError, fields.cause);
  }
  return false;
}

export function isCognitoRateLimitError(error: unknown): boolean {
  return hasNestedAuthError(error, fields => fields.name === "TooManyRequestsException" || fields.code === "TooManyRequestsException");
}

/** Cognito Identity can reject a stale login token after the page layout has
 * already authorized the user. Only this exact nested verification failure is
 * recognized; a general NotAuthorized/AccessDenied must remain an error. */
export function isCognitoInvalidLoginTokenError(error: unknown): boolean {
  return hasNestedAuthError(error, fields =>
    (fields.name === "NotAuthorizedException" || fields.code === "NotAuthorizedException") &&
    typeof fields.message === "string" && fields.message.startsWith("Invalid login token. Couldn't verify signed token."),
  );
}
