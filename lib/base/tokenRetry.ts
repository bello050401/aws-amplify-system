/**
 * BASEのトークンエンドポイントを叩くときの、再試行と同時実行の方針。
 *
 * 判定だけをここに分けてある —— fetchもDynamoDBも触らないので、
 * ネットワークもBASEアカウントも無しに検証できる。
 */

/** 何回目まで試すか(初回を含む)。 */
export const MAX_TOKEN_ATTEMPTS = 3;

/**
 * このHTTPステータスなら、もう一度試す価値があるか。
 *
 * ── 4xx は再試行しない ──────────────────────────────────────────
 *
 * invalid_grant(リフレッシュトークンが失効)や invalid_client
 * (Client Secretが違う)は、何度投げても同じ答えしか返らない。
 * 再試行は時間を浪費するだけでなく、BASE側のレート制限に当たって
 * **本当に必要なときの1回まで潰す**。
 *
 * ── 429 は例外 ──────────────────────────────────────────────────
 *
 * 4xxだが「いまは駄目、後なら良い」を意味する唯一のもの。待てば通る。
 *
 * ── ステータスが取れない場合 ────────────────────────────────────
 *
 * fetch自体が失敗した(ネットワーク断・DNS・タイムアウト)ときは
 * status が null になる。これは典型的な一時障害なので再試行する。
 */
export function isRetryableTokenStatus(status: number | null): boolean {
  if (status === null) return true; // ネットワーク層の失敗
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * 次の試行までの待ち時間(ミリ秒)。指数バックオフ。
 *
 * attempt は1始まり(1回目が失敗した直後は attempt=1)。
 * 0.5秒 → 1秒 → 2秒。BASEのトークン更新は利用者を待たせている経路
 * なので、ここを長くしすぎると画面が固まって見える。
 */
export function tokenRetryDelayMs(attempt: number): number {
  return 500 * Math.pow(2, Math.max(0, attempt - 1));
}

/** もう一度試すか。回数の上限とステータスの両方を見る。 */
export function shouldRetryToken(attempt: number, status: number | null): boolean {
  return attempt < MAX_TOKEN_ATTEMPTS && isRetryableTokenStatus(status);
}

/**
 * 同じ処理が同時に何本も走らないようにする(single flight)。
 *
 * ── なぜトークン更新に要るのか ──────────────────────────────────
 *
 * BASEはリフレッシュのたびに refresh_token を**回転させる**ことがある。
 * 期限切れ直後にリクエストが2本同時に来ると、両方が更新を試み、
 *
 *   1本目 … 成功。BASE側で古い refresh_token は無効になる
 *   2本目 … 既に無効になった refresh_token を送る → invalid_grant
 *
 * となる。2本目の失敗だけなら再試行で済むが、悪いのは保存の競合で、
 * 後から書いた側が古いトークンで上書きすると**連携そのものが壊れて
 * 人による再連携が必要**になる。BASEの再認証は人しかできないので、
 * これは最も避けたい壊れ方。
 *
 * 実行中の Promise を1つだけ持ち、後続はそれに相乗りする。
 *
 * ── どこまで効くか(正直に) ──────────────────────────────────────
 *
 * モジュールスコープなので、効くのは**同じプロセスの中だけ**。
 * Amplify HostingのSSRは複数インスタンスへ分散しうるので、
 * インスタンスをまたいだ同時更新は防げない。とはいえ同時実行の大半は
 * 「温まった1インスタンスへ来た連続リクエスト」なので、分散ロックを
 * 持ち込まずに効く範囲は大きい。
 */
export function createSingleFlight<T>(): (fn: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (fn) => {
    if (inFlight) return inFlight;
    inFlight = fn().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
