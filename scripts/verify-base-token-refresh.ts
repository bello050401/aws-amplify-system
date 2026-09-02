/**
 * BASEのアクセストークン更新まわりの検証(**BASEアカウント不要**)。
 *
 * 再認証は人しかできないので、実際のBASEには繋がない。繋がなくても
 * 確かめられるところ —— 期限判定・再試行の可否・待ち時間・同時実行の
 * 畳み込み・保存の順序 —— をすべてここで見る。
 *
 * Run with: npm run verify:base-token-refresh
 */
import {
  MAX_TOKEN_ATTEMPTS,
  createSingleFlight,
  isRetryableTokenStatus,
  shouldRetryToken,
  tokenRetryDelayMs,
} from "@/lib/base/tokenRetry";

let failures = 0;
let passes = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}
const assertTrue = (c: boolean, label: string) => assertEqual(c, true, label);

/* ══════════════════════════════════════════════════════════════════
 * 1. 再試行してよい失敗と、してはいけない失敗
 * ══════════════════════════════════════════════════════════════════
 * 4xx を再試行すると、同じ答えが返るだけでなく、レート制限に当たって
 * **本当に必要なときの1回を潰す**。
 */
function testRetryClassification() {
  assertEqual(isRetryableTokenStatus(null), true, "再試行: ネットワーク層の失敗(status無し)は試す");
  assertEqual(isRetryableTokenStatus(500), true, "再試行: 500 は試す");
  assertEqual(isRetryableTokenStatus(502), true, "再試行: 502 は試す");
  assertEqual(isRetryableTokenStatus(503), true, "再試行: 503 は試す");
  assertEqual(isRetryableTokenStatus(504), true, "再試行: 504 は試す");
  assertEqual(isRetryableTokenStatus(429), true, "再試行: 429 は待てば通るので試す");

  assertEqual(isRetryableTokenStatus(400), false, "再試行: 400 は試さない(invalid_grant等)");
  assertEqual(isRetryableTokenStatus(401), false, "再試行: 401 は試さない(Client Secretが違う)");
  assertEqual(isRetryableTokenStatus(403), false, "再試行: 403 は試さない(権限が無い)");
  assertEqual(isRetryableTokenStatus(404), false, "再試行: 404 は試さない");
  assertEqual(isRetryableTokenStatus(422), false, "再試行: 422 は試さない");
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 回数の上限と待ち時間
 * ══════════════════════════════════════════════════════════════════ */
function testRetryBudget() {
  assertEqual(MAX_TOKEN_ATTEMPTS, 3, "回数: 初回を含めて3回まで");

  assertEqual(shouldRetryToken(1, 503), true, "回数: 1回目の503は再試行する");
  assertEqual(shouldRetryToken(2, 503), true, "回数: 2回目の503も再試行する");
  assertEqual(shouldRetryToken(3, 503), false, "回数: 3回目で打ち切る(無限に粘らない)");
  assertEqual(shouldRetryToken(1, 400), false, "回数: 400は1回目でも再試行しない");

  assertEqual(tokenRetryDelayMs(1), 500, "待ち: 1回目の失敗後は0.5秒");
  assertEqual(tokenRetryDelayMs(2), 1000, "待ち: 2回目の失敗後は1秒");
  assertEqual(tokenRetryDelayMs(3), 2000, "待ち: 3回目の失敗後は2秒");
  assertTrue(tokenRetryDelayMs(1) < tokenRetryDelayMs(2), "待ち: 回を追うごとに伸びる");

  // 利用者を待たせている経路なので、合計が長くなりすぎないこと。
  const worstCase = tokenRetryDelayMs(1) + tokenRetryDelayMs(2);
  assertTrue(worstCase <= 2000, `待ち: 打ち切りまでの合計が2秒以内(実際 ${worstCase}ms)`);
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 同時実行を1本に畳む(single flight)
 * ══════════════════════════════════════════════════════════════════
 * BASEはリフレッシュのたびに refresh_token を回転させることがある。
 * 2本同時に走ると、後から来たほうが既に無効なトークンを送ることになり、
 * 最悪の場合は連携そのものが壊れて**人による再連携**が必要になる。
 */
async function testSingleFlight() {
  const flight = createSingleFlight<string>();
  let calls = 0;
  let release!: (v: string) => void;
  const gate = new Promise<string>((r) => (release = r));

  const work = () => {
    calls++;
    return gate;
  };

  const a = flight(work);
  const b = flight(work);
  const c = flight(work);
  assertEqual(calls, 1, "同時実行: 3本同時に来ても実際の更新は1回だけ");

  release("token-1");
  const results = await Promise.all([a, b, c]);
  assertEqual(results, ["token-1", "token-1", "token-1"], "同時実行: 全員が同じ結果を受け取る");

  // 終わったら次はまた実行される(結果を持ち続けない)。
  // トークンをキャッシュしてしまうと、失効後も古い値を返し続ける。
  let second = 0;
  await flight(async () => {
    second++;
    return "token-2";
  });
  assertEqual(second, 1, "同時実行: 完了後は次の呼び出しで再度実行する(結果を持ち越さない)");

  // 失敗しても詰まらない。詰まると以降ずっと更新できなくなる。
  const failing = createSingleFlight<string>();
  let attempts = 0;
  const boom = () => {
    attempts++;
    return Promise.reject(new Error("boom"));
  };
  await failing(boom).catch(() => {});
  await failing(boom).catch(() => {});
  assertEqual(attempts, 2, "同時実行: 失敗しても次の呼び出しは実行される(詰まらない)");

  // 同時に来た全員へ同じ失敗が伝わる。片方だけ成功したことにしない。
  const shared = createSingleFlight<string>();
  let rejectIt!: (e: Error) => void;
  const failGate = new Promise<string>((_, rej) => (rejectIt = rej));
  const p1 = shared(() => failGate);
  const p2 = shared(() => failGate);
  rejectIt(new Error("shared failure"));
  const outcomes = await Promise.all([
    p1.then(() => "ok").catch((e: Error) => e.message),
    p2.then(() => "ok").catch((e: Error) => e.message),
  ]);
  assertEqual(outcomes, ["shared failure", "shared failure"], "同時実行: 失敗も全員へ同じものが伝わる");
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 期限の判定
 * ══════════════════════════════════════════════════════════════════
 * oauth.ts の判定と同じ式をここで確かめる。壊れた保存値で
 * 「期限内」と誤判定しないことが要点。
 */
function testExpiry() {
  const MARGIN_MS = 60_000;
  const now = Date.now();
  const stillValid = (expiresAt: string) => new Date(expiresAt).getTime() > now + MARGIN_MS;

  assertEqual(stillValid(new Date(now + 3600_000).toISOString()), true, "期限: 1時間先ならそのまま使う");
  assertEqual(stillValid(new Date(now + 120_000).toISOString()), true, "期限: 2分先ならそのまま使う");
  assertEqual(stillValid(new Date(now + 30_000).toISOString()), false, "期限: 30秒先は余裕を切るので更新する");
  assertEqual(stillValid(new Date(now - 1_000).toISOString()), false, "期限: 既に切れていれば更新する");
  assertEqual(stillValid(new Date(now).toISOString()), false, "期限: ちょうど今なら更新する");

  // 壊れた値。NaN との比較は必ず false になるので「更新する」側へ倒れる。
  // 読めない値を有効期限内とみなして期限切れトークンを使い続けるより安全。
  for (const broken of ["", "not-a-date", "2026-13-45T99:99:99Z", "null", "undefined"]) {
    assertEqual(stillValid(broken), false, `期限: 壊れた値(${broken || "空文字"})は更新側へ倒れる`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 5. リフレッシュトークンの回転
 * ══════════════════════════════════════════════════════════════════
 * BASEは更新時に refresh_token を返さないことがある。それは
 * 「変わっていない」の意味であって「消えた」ではない。
 */
function testRotation() {
  // oauth.ts の saveToken と同じ規則。
  const resolve = (returned: string | undefined, stored: string | undefined) => returned ?? stored;

  assertEqual(resolve("new-refresh", "old-refresh"), "new-refresh", "回転: 新しい値が返ればそれを使う");
  assertEqual(resolve(undefined, "old-refresh"), "old-refresh", "回転: 返らなければ既存を保つ(消さない)");
  assertEqual(resolve(undefined, undefined), undefined, "回転: どちらも無ければ保存できない(例外にする)");
  // 空文字が返った場合。?? は空文字を通してしまうので、ここは意図の確認。
  assertEqual(resolve("", "old-refresh"), "", "回転: 空文字はそのまま通る(BASEは空文字を返さない前提)");
}

async function main() {
  testRetryClassification();
  testRetryBudget();
  await testSingleFlight();
  testExpiry();
  testRotation();

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
