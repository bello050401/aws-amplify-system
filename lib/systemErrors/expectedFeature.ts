/** This trusted local marker is only constructed when the complete search
 * cannot fit its processing budget. It preserves the user-facing correction. */
export class InventorySearchLimitError extends Error {
  constructor() {
    super('検索対象が処理上限を超えています。カテゴリなどの条件を追加してください。途中までの結果は表示していません。');
    this.name = 'InventorySearchLimitError';
  }
}
/** Classify locally. Neither messages nor SDK payloads become diagnostic fields. */
export function isExpectedFeatureError(error: unknown): boolean {
  if (error instanceof InventorySearchLimitError) return true;
  if (!error || typeof error !== 'object') return false;
  const value = error as {name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown};
  if (['AbortError', 'NotAuthorizedException', 'UnauthorizedException', 'ForbiddenException', 'NoValidAuthTokens', 'TooManyRequestsException', 'ThrottlingException', 'ConditionalCheckFailedException'].includes(String(value.name))) return true;
  if ([401, 403, 429].includes(Number(value.status ?? value.statusCode))) return true;
  return error instanceof Error && error.name === 'Error' && /^(?:NEXT_REDIRECT|NEXT_NOT_FOUND|NoValidAuthTokens|GMAIL_AUTH_REQUIRED|GMAIL_RATE_LIMIT)(?:$|:|;)/.test(error.message);
}
