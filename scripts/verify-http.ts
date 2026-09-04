/**
 * 外部呼び出しのタイムアウト（2026-09-04 健全化 PHASE 8）。
 *
 *   npm run verify:http
 *
 * AWSにも外部サービスにも一切つながない。`fetch` を差し替えて、
 * 「応答が返らない相手」「呼び出し側が中断した」「正常に返った」の
 * 3つの振る舞いだけを固定する。
 *
 * ここが壊れると、外部が遅いだけでSSRの1リクエストが上限まで居座り、
 * Webhookの再送と重なって積み上がる —— 症状が「なんとなく重い」に
 * なるので、実機では原因を追いにくい。だからテストで固定する。
 */
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/http/fetchWithTimeout";

let failures = 0;
let passes = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const realFetch = globalThis.fetch;

/** 中断されるまで返らない fetch。 */
function neverRespondingFetch() {
  return (_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // 永久に待つ（＝タイムアウトが無ければテストが止まる）
      if (signal.aborted) return reject(abortError());
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

async function testTimesOut() {
  globalThis.fetch = neverRespondingFetch() as unknown as typeof fetch;
  const startedAt = Date.now();
  try {
    await fetchWithTimeout("https://example.invalid/never", undefined, { timeoutMs: 120, label: "テスト相手" });
    check(false, "応答が返らない相手は時間切れで打ち切る");
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    check(err instanceof FetchTimeoutError, "応答が返らない相手は時間切れで打ち切る", `${elapsed}ms`);
    check(
      err instanceof Error && err.message.includes("テスト相手"),
      "時間切れのメッセージにどこが遅かったかが入る",
      err instanceof Error ? err.message : "",
    );
    check(elapsed < 2000, "上限を大きく超えて待ち続けない", `${elapsed}ms`);
  }
}

async function testCallerAbortIsNotReportedAsTimeout() {
  globalThis.fetch = neverRespondingFetch() as unknown as typeof fetch;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  try {
    await fetchWithTimeout("https://example.invalid/never", { signal: controller.signal }, { timeoutMs: 5000 });
    check(false, "呼び出し側の中断は時間切れとして扱わない");
  } catch (err) {
    check(
      !(err instanceof FetchTimeoutError) && err instanceof Error && err.name === "AbortError",
      "呼び出し側の中断は時間切れとして扱わない",
      err instanceof Error ? err.name : "",
    );
  }
}

async function testPassesThroughOnSuccess() {
  const seen: { input: unknown; init: unknown }[] = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    seen.push({ input, init });
    return new Response("ok", { status: 201, headers: { "x-test": "1" } });
  }) as unknown as typeof fetch;

  const res = await fetchWithTimeout("https://example.invalid/ok", { method: "POST", headers: { a: "b" } });
  check(res.status === 201, "正常な応答はそのまま返す", `status=${res.status}`);
  check(res.headers.get("x-test") === "1", "ヘッダも素通しする");
  const init = seen[0].init as { method?: string; headers?: Record<string, string>; signal?: AbortSignal };
  check(init.method === "POST", "呼び出し側が渡したmethodを保つ");
  check(init.headers?.a === "b", "呼び出し側が渡したheadersを保つ");
  check(Boolean(init.signal), "中断用のsignalを必ず付ける（付いていないと打ち切れない）");
}

async function main() {
  try {
    await testTimesOut();
    await testCallerAbortIsNotReportedAsTimeout();
    await testPassesThroughOnSuccess();
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

void main().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(`[verify-http] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
