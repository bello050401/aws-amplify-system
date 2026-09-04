/**
 * 応答が返らない外部呼び出しで固まらないための fetch（2026-09-04 健全化 PHASE 8）。
 *
 * ── なぜ要るのか ────────────────────────────────────────────────
 *
 * Node の `fetch` には**既定のタイムアウトが無い**。接続したまま応答が
 * 返ってこない相手に当たると、その待ちは実行環境の上限まで続く。
 * SSR(Lambda)で起きると、その1リクエストが上限いっぱい居座る。
 *
 * とくに危ないのがWebhookの経路。LINEは2xxが返らなければ再送するので、
 * 1回ハングすると **再送 → またハング** と積み上がる。外部が遅いだけで
 * こちらの処理系が詰まる形になる。
 *
 * 監査時点(2026-09-04)で、外部へ `fetch` している17ファイルのうち
 * タイムアウトを持っていたのは3つだけだった。
 *
 * ── 方針 ────────────────────────────────────────────────────────
 *
 * ここでやるのは「待ち続けない」ことだけ。**再試行はしない。**
 * 何を再試行してよいかは呼び出し側の事情（冪等かどうか）で決まるもので、
 * 共通化すると危ない方向へ倒れる。タイムアウトは呼び出し側が
 * 「一時的な失敗」として扱えるよう、名前の付いたエラーで返す。
 */

/** 待ち時間の上限を超えたときに投げるエラー。呼び出し側が一時的な失敗として分類できるよう名前を付ける。 */
export class FetchTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label}が${timeoutMs}ms以内に応答しませんでした。`);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 既定の上限。
 *
 * 15秒は既存の Mercari クライアント（MERCARI_TIMEOUT_MS の既定値）に
 * 合わせた値。外部APIの通常の応答（数百ms〜数秒）に対しては十分に余裕が
 * あり、かつ Amplify SSR の実行上限より確実に短い。
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  input: string | URL | Request,
  init?: RequestInit,
  options?: { timeoutMs?: number; label?: string },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const label = options?.label ?? "外部サービス";

  // 呼び出し側が独自の AbortSignal を渡していたら、それも尊重する
  // （どちらが先に発火しても中断できるようにする）。
  const controller = new AbortController();
  const caller = init?.signal;
  const onCallerAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // 中断の理由が「時間切れ」なのか「呼び出し側の中断」なのかを区別する。
    // どちらも AbortError で来るので、フラグで見分けるしかない。
    if (timedOut) throw new FetchTimeoutError(label, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    if (caller) caller.removeEventListener("abort", onCallerAbort);
  }
}
