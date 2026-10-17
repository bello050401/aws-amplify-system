// A non-deliverable internal account identifier, not an email inbox or an authorization rule.
// The Cognito session's verified groups still control all access on the server.
export const STAFF_ACCOUNT_IDENTIFIER = "staff@bello.invalid";
export type LoginMode = "account" | "staff";

export function requestedLoginMode(search: string): LoginMode | null {
  const mode = new URLSearchParams(search).get("login");
  return mode === "staff" || mode === "account" ? mode : null;
}

export function loginUsername(mode: LoginMode, enteredId: string): string {
  return mode === "staff" ? STAFF_ACCOUNT_IDENTIFIER : resolveLoginId(enteredId);
}

export function resolveLoginId(input: string): string {
  const value = input.trim().normalize("NFKC");
  return value === "スタッフ" || value.toLowerCase() === "staff" ? STAFF_ACCOUNT_IDENTIFIER : value;
}

export function loginErrorMessage(error: unknown, mode: LoginMode = "account"): string {
  const name = error instanceof Error ? error.name : "";
  if (["NotAuthorizedException", "UserNotFoundException"].includes(name)) return mode === "staff" ? "パスワードが違います。入力内容を確認してください。" : "ログインIDまたはパスワードが違います。入力内容を確認してください。";
  if (["TooManyRequestsException", "LimitExceededException"].includes(name)) return "ログインの試行が多いため、少し時間を置いてからお試しください。";
  if (name === "NetworkError") return "通信できません。接続を確認して、もう一度お試しください。";
  return "ログインを完了できませんでした。通信状態を確認して、もう一度お試しください。";
}
