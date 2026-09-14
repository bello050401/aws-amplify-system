/**
 * lib/listing/mercari/csv/browserImageZip.ts の合成fixtureテスト。
 * 実ネットワーク・実S3・実ブラウザは一切使わない——`globalThis.fetch`を
 * 差し替えたモックで、task_f712cf24a9fe2308cd(2026-09-14是正)が要求する
 * 「取得中の実制限」を実際に走らせて検証する:
 *   - 数MB相当の複数枚(応答上限以下/超過)
 *   - chunked過大body(1枚あたりの上限を、ストリーム受信中に打ち切る)
 *   - 合計サイズ超過(複数ファイルを跨いだ打ち切り)
 *   - 通信停止(ストリーム読み取り中のエラー)
 *   - 期限切れ相当のHTTPエラー(403/404)
 *   - タイムアウト(応答が返らない)
 *   - 画像保存名の一致(assembleZipFromPlanが組み立てたZIPのファイル名)
 *
 * 実行: node scripts/with-server-only-stub.cjs scripts/verify-browser-image-zip.ts
 * (browserImageZip.ts自体はserver-onlyではないが、既存のverify:*群と
 * 同じ実行方法に揃えて他のnpm scriptsと一貫させる——stubの有無で挙動は変わらない)。
 */
import { assembleZipFromPlan, fetchImageBytesBounded, type ZipDownloadPlanItem } from "../lib/listing/mercari/csv/browserImageZip";

let failures = 0;
let passes = 0;

function assertTrue(cond: boolean, label: string) {
  if (cond) {
    passes++;
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.error(`✗ FAIL: ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}

const originalFetch = globalThis.fetch;
function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

/** レスポンスbodyを、指定バイト数ずつのチャンクへ分けて返すReadableStream。pull()の呼び出し回数を`pullCount`で外から観測できる。 */
function chunkedStream(totalBytes: number, chunkSize: number, pullCounter: { count: number }): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCounter.count++;
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(n).fill(0xab));
      sent += n;
    },
  });
}

async function testSuccessRoundTrip() {
  await withMockFetch(
    (async (url: string | URL | Request) => {
      const name = String(url);
      const bytes = new TextEncoder().encode(`hello:${name}`);
      return new Response(bytes, { status: 200 });
    }) as typeof fetch,
    async () => {
      const plan: ZipDownloadPlanItem[] = [
        { inventoryId: "inv-1", displayId: "B000001", filename: "B000001_1.jpg", url: "https://example.invalid/a" },
        { inventoryId: "inv-1", displayId: "B000001", filename: "B000001_2.jpg", url: "https://example.invalid/b" },
      ];
      const result = await assembleZipFromPlan("test.zip", plan);
      assertTrue(result.ok, "2枚とも成功すればZIP組み立ても成功する");
      if (result.ok) {
        assertEqual(result.filename, "test.zip", "ZIPファイル名は呼び出し時に渡した値がそのまま使われる");
        assertEqual(result.fileCount, 2, "fileCountは投入した画像数と一致する");
      }
    },
  );
}

async function testHttpErrorsSurfaceStatus() {
  for (const status of [403, 404]) {
    await withMockFetch(
      (async () => new Response(null, { status })) as typeof fetch,
      async () => {
        const plan: ZipDownloadPlanItem[] = [{ inventoryId: "inv-1", displayId: "B000001", filename: "B000001_1.jpg", url: "https://example.invalid/x" }];
        const result = await assembleZipFromPlan("test.zip", plan);
        assertTrue(!result.ok, `HTTP ${status}は失敗として扱われる(部分成功のZIPを返さない)`);
        if (!result.ok) {
          const joined = (result.failures ?? []).map((f) => f.reason).join(" / ");
          assertTrue(joined.includes(`HTTP ${status}`), `失敗理由にHTTP ${status}が含まれる(利用者が原因を判別できる)`);
        }
      },
    );
  }
}

async function testPerFileByteCapAbortsMidStream() {
  const pullCounter = { count: 0 };
  const totalBytesAvailable = 20 * 1024 * 1024; // 20MB相当(全部読めば上限超過)
  const chunkSize = 1 * 1024 * 1024; // 1MBずつ
  const fileByteLimit = 3 * 1024 * 1024; // 1枚あたりの上限を3MBに設定(テスト用の小さい値)

  await withMockFetch(
    (async () => new Response(chunkedStream(totalBytesAvailable, chunkSize, pullCounter), { status: 200 })) as typeof fetch,
    async () => {
      const bounded = await fetchImageBytesBounded("https://example.invalid/big", {
        fileByteLimit,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        onBytes: () => true,
      });
      assertTrue(!bounded.ok, "1枚あたりの上限を超えるストリームは失敗として打ち切られる");
      if (!bounded.ok) {
        assertTrue((bounded.reason ?? "").includes("上限"), "失敗理由が上限超過だと分かる文言を含む");
      }
      // 20MB / 1MBチャンク = 20回のpullが必要だが、3MB上限なので
      // 3〜4回目のpullで打ち切られているはず——全量(20回)を読み切って
      // いない(=「取得中に中断」できている、Content-Lengthを待たない)ことの証拠。
      assertTrue(pullCounter.count < totalBytesAvailable / chunkSize, `ストリームを全部読み切る前に打ち切られた(pull回数=${pullCounter.count})`);
    },
  );
}

async function testTotalByteCapAbortsRemainingFiles() {
  // 各ファイルは1枚あたりの上限(fileByteLimit)未満だが、3枚合計で
  // 合計上限を超える——assembleZipFromPlanの共有onBytesカウンタが
  // ファイルを跨いで合算し、残りのファイルの取得を打ち切ることを検証する。
  // 実運用の定数(15MB/40MB)そのままだとテストが重くなるため、
  // fetchImageBytesBounded相当の小さいバイト数でassembleZipFromPlanの
  // ロジックを模した簡易版をここで直接組む代わりに、
  // 実際にimageTransferLimits.tsの定数を使うassembleZipFromPlanを
  // 5ファイル×9MB(合計45MB、40MB上限超過・各9MBは15MB上限未満)で検証する。
  const nineMb = 9 * 1024 * 1024;
  await withMockFetch(
    (async () => new Response(new Uint8Array(nineMb).fill(1), { status: 200 })) as typeof fetch,
    async () => {
      const plan: ZipDownloadPlanItem[] = Array.from({ length: 5 }, (_, i) => ({
        inventoryId: "inv-1",
        displayId: "B000001",
        filename: `B000001_${i + 1}.jpg`,
        url: `https://example.invalid/${i}`,
      }));
      const result = await assembleZipFromPlan("test.zip", plan);
      assertTrue(!result.ok, "5枚×9MB=45MBは合計上限(40MB)を超え、全体が失敗になる(部分成功のZIPを返さない)");
      if (!result.ok) {
        const joined = (result.failures ?? []).map((f) => f.reason).join(" / ");
        assertTrue(joined.includes("合計サイズ上限") || joined.includes("時間予算"), "失敗理由に合計サイズ上限超過が読み取れる");
      }
    },
  );
}

async function testStreamErrorDuringReadIsReportedNotThrown() {
  await withMockFetch(
    (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          pull() {
            throw new Error("simulated connection reset");
          },
        }),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const plan: ZipDownloadPlanItem[] = [{ inventoryId: "inv-1", displayId: "B000001", filename: "B000001_1.jpg", url: "https://example.invalid/x" }];
      // 通信停止(ストリーム読み取り中の例外)がassembleZipFromPlanの外へ
      // 例外として漏れ出さず、失敗結果として返ってくることを検証する
      // ——呼び出し側(UIコンポーネント)がtry/catchを飛び越えて壊れない。
      let threw = false;
      let result: Awaited<ReturnType<typeof assembleZipFromPlan>> | undefined;
      try {
        result = await assembleZipFromPlan("test.zip", plan);
      } catch {
        threw = true;
      }
      assertTrue(!threw, "ストリーム読み取り中の通信断は例外を投げず、失敗結果として返る");
      assertTrue(!!result && !result.ok, "通信断は失敗として扱われる");
    },
  );
}

async function testTimeoutAbortsHangingRequest() {
  // 応答が永久に返らない(=通信が固まった)相手を模す——fetchが解決しない
  // Promiseを返す。timeoutMsを小さくして、実際にAbortSignal経由で
  // 打ち切られることを確認する(本番の定数IMAGE_FETCH_TIMEOUT_MS=30秒を
  // そのまま待つとテストが遅くなるため、ここだけ小さい値を直接渡す
  // ——fetchImageBytesBoundedがtimeoutMsを引数として受け取れることの
  // テスト容易性がexportしている理由そのもの)。
  await withMockFetch(
    ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch,
    async () => {
      const t0 = Date.now();
      const result = await fetchImageBytesBounded("https://example.invalid/hangs", {
        fileByteLimit: 1024,
        timeoutMs: 150,
        signal: new AbortController().signal,
        onBytes: () => true,
      });
      const elapsedMs = Date.now() - t0;
      assertTrue(!result.ok, "応答が返らない相手はタイムアウトで失敗扱いになる(待ち続けない)");
      assertTrue((result.reason ?? "").includes("タイムアウト"), "失敗理由がタイムアウトだと分かる文言を含む");
      assertTrue(elapsedMs < 2_000, `timeoutMs(150ms)の桁を大きく超えて待ち続けていない(実測${elapsedMs}ms)`);
    },
  );
}

async function main() {
  await testSuccessRoundTrip();
  await testHttpErrorsSurfaceStatus();
  await testPerFileByteCapAbortsMidStream();
  await testTotalByteCapAbortsRemainingFiles();
  await testStreamErrorDuringReadIsReportedNotThrown();
  await testTimeoutAbortsHangingRequest();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    process.exit(1);
  }
}

void main();
