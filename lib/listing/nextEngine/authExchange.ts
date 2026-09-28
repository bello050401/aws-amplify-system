import { assertNextEngineServerRuntime } from "./serverBoundary";

/** Exchange a short-lived Next Engine launch state on the server only.
 * The caller must persist returned tokens server-side and must never serialize
 * this result into a browser response, URL, log or client component.
 * https://developer.next-engine.com/api/api_neauth/
 */
export async function exchangeNextEngineLaunch(
  input: { uid: string; state: string; clientId: string; clientSecret: string; expectedCompanyNeId: string },
  request: typeof fetch = fetch,
): Promise<{ uid: string; companyNeId: string; accessToken: string; refreshToken: string }> {
  assertNextEngineServerRuntime();
  const { uid, state, clientId, clientSecret, expectedCompanyNeId } = input;
  if (![uid, state, clientId, clientSecret, expectedCompanyNeId].every(value => typeof value === "string" && value.trim())) {
    throw new Error("ネクストエンジンの認証情報が不足しています。");
  }
  let payload: unknown;
  try {
    const response = await request("https://api.next-engine.org/api_neauth", {
      method: "POST",
      body: new URLSearchParams({ uid, state, client_id: clientId, client_secret: clientSecret }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("HTTP failure");
    payload = await response.json();
  } catch {
    throw new Error("ネクストエンジンの認証接続を確認できませんでした。");
  }
  if (!payload || typeof payload !== "object") throw new Error("ネクストエンジンの認証応答が不正です。");
  const data = payload as Record<string, unknown>;
  if (data.result !== "success" || data.uid !== uid ||
      data.company_ne_id !== expectedCompanyNeId ||
      typeof data.access_token !== "string" || !data.access_token ||
      typeof data.refresh_token !== "string" || !data.refresh_token) {
    throw new Error("ネクストエンジンの認証結果を確認できませんでした。");
  }
  return {
    uid,
    companyNeId: data.company_ne_id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}
