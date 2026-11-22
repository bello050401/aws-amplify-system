/** Classify locally. Neither messages nor SDK payloads become diagnostic fields. */
export function isExpectedFeatureError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as {name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown};
  if (['AbortError', 'NotAuthorizedException', 'UnauthorizedException', 'ForbiddenException', 'NoValidAuthTokens', 'TooManyRequestsException', 'ThrottlingException', 'ValidationException', 'ConditionalCheckFailedException'].includes(String(value.name))) return true;
  if ([400, 401, 403, 404, 409, 422, 429].includes(Number(value.status ?? value.statusCode))) return true;
  return error instanceof Error && error.name === 'Error' && /^(?:NEXT_REDIRECT|NEXT_NOT_FOUND|NoValidAuthTokens|GMAIL_AUTH_REQUIRED|GMAIL_RATE_LIMIT)(?:$|:|;)/.test(error.message);
}
