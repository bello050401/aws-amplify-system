/**
 * 画像まとめダウンロード(ZIP)のブラウザ側実装(task_f712cf24a9fe2308cd、
 * 2026-09-14是正)。
 *
 * ## なぜサーバーではなくブラウザでZIPを組み立てるか
 *
 * imageBundle.tsの`resolveInventoryImageZipPlan`のコメント参照——
 * Server Action経由で画像バイト(base64化すると数十MB)を返す旧設計は
 * AWS公式ドキュメントが明記するAmplify Hosting Web Computeの応答上限
 * (5.72MB、超過分はコンテンツ無しの504)を実運用の写真枚数で容易に
 * 超える。ここでは画像バイトをS3の署名URLから**ブラウザが直接**取得し
 * (このNext.jsサーバーは経由しない——署名URLの発行元は
 * app/actions/listing.tsのgetMercariCsvImageZipPlanActionで、返す
 * ペイロードはURL一覧のみ)、ZIP組み立て(imageZip.ts、Uint8Array実装)も
 * ブラウザ側で行う。
 *
 * ## "server-only"を付けていない理由
 *
 * このファイルは"use client"コンポーネント(ListingsOverviewTable.tsx/
 * MercariCategoryMappingSection.tsx)から直接importされる——ブラウザの
 * fetch/AbortController/ReadableStreamだけに依存し、next/headers等の
 * サーバー専用APIには一切依存しない。
 *
 * ## 取得中の実制限(指示書「Content-Lengthだけに依存せずstream読取中の
 * バイト上限/AbortSignal timeout/全体時間上限」への対応)
 *
 * - `lib/http/fetchWithTimeout.ts`は使わない——同ユーティリティは
 *   「応答ヘッダーが返るまで」しかタイマーを効かせない設計(finallyで
 *   即座にclearTimeoutする、外部API呼び出し向けの意図的な割り切り)。
 *   ここでは数MBのバイナリをストリームで読み切るまでの時間全体を
 *   保証したいため、専用に実装している(fetchImageBytesBounded)。
 * - Content-Length(response.headers.get("content-length"))は
 *   信用しない——偽装/欠落があり得るため、実際に読んだチャンクの
 *   累計バイト数だけを判定に使い、1枚の上限(MAX_ZIP_FILE_BYTES)を
 *   超えた時点でreader.cancel()して即座に打ち切る(全量を読み切って
 *   から判定しない)。
 * - 合計(MAX_ZIP_TOTAL_BYTES)も同様に、全画像を跨いだ累計で
 *   超えた時点で残り全体を中断する(共有AbortController)。
 * - 1枚あたりIMAGE_FETCH_TIMEOUT_MS、全体でZIP_TOTAL_TIME_BUDGET_MS
 *   の時間上限を持つ。
 * - 同時取得数はZIP_FETCH_CONCURRENCYで制限する(メモリ・同時接続数の
 *   両方を有界にする——指示書「メモリと同時取得を制限」)。
 * - 1枚でも失敗したら(サイズ超過・タイムアウト・HTTPエラー・通信断)
 *   全体を`ok:false`にし、取得済みの他の画像だけで部分成功のZIPを
 *   作らない——imageBundle.ts/exportCsv.tsと同じ「部分成功を黙って
 *   隠さない」方針をブラウザ側でも維持する。
 */
import { buildStoredZip } from "./imageZip";
import { MAX_ZIP_FILE_BYTES, MAX_ZIP_TOTAL_BYTES, IMAGE_FETCH_TIMEOUT_MS, ZIP_TOTAL_TIME_BUDGET_MS, ZIP_FETCH_CONCURRENCY } from "./imageTransferLimits";

export interface ZipDownloadPlanItem {
  inventoryId: string;
  displayId: string;
  filename: string;
  url: string;
}

export interface ZipDownloadFailure {
  inventoryId: string;
  displayId: string;
  reason: string;
}

export type ZipAssembleResult =
  | { ok: true; blob: Blob; filename: string; fileCount: number; totalBytes: number }
  | { ok: false; reason: string; failures?: ZipDownloadFailure[] };

interface BoundedFetchResult {
  ok: boolean;
  bytes?: Uint8Array;
  reason?: string;
}

/**
 * 1枚の画像を、1枚あたりの上限を超えた時点で打ち切りながら取得する。
 * `onBytes`は読んだチャンクのバイト数を都度通知し、falseを返した場合は
 * (呼び出し側が合計上限超過などで中断を望んでいる)即座に取得を打ち切る。
 *
 * exportしているのはscripts/verify-browser-image-zip.tsから直接単体
 * テストするため(fetch/AbortSignal.timeoutを差し替えたモックで、
 * 「ストリーム読取中の打ち切り」「1枚ごとのタイムアウト」を実際に
 * 走らせて検証する——assembleZipFromPlan経由だと定数
 * (imageTransferLimits.ts、本番同様30秒/40MB)が固定されテストが遅くなる)。
 */
export async function fetchImageBytesBounded(
  url: string,
  opts: { fileByteLimit: number; timeoutMs: number; signal: AbortSignal; onBytes: (n: number) => boolean },
): Promise<BoundedFetchResult> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (opts.signal.aborted) controller.abort();
  else opts.signal.addEventListener("abort", forwardAbort, { once: true });

  // このfetch自身の1枚あたりタイムアウトで打ち切られたのか、呼び出し元
  // (assembleZipFromPlanのoverallController、合計サイズ/全体時間予算超過)
  // から転送されたabortなのかを区別するためのフラグ。どちらも
  // `controller.signal.aborted`は同じtrueになるため、これが無いと
  // 「他の画像が原因で中断された」のに毎回「このURLがタイムアウトした」
  // と表示してしまい、利用者が原因を誤認する
  // (task_f712cf24a9fe2308cd、2026-09-14レビュー修正)。
  let timedOut = false;

  // 応答ヘッダー〜ストリーム読了までの全体をカバーするタイマー
  // (fetchWithTimeout.tsと異なり、finallyでは止めない——下のreaderループの
  // 最中もこのタイマーが効き続ける必要があるため)。
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    } catch (err) {
      if (timedOut) return { ok: false, reason: `画像の取得がタイムアウトしました(${opts.timeoutMs}ms)` };
      if (controller.signal.aborted) return { ok: false, reason: "他の画像の失敗や合計サイズ/時間予算の超過により取得を中断しました" };
      return { ok: false, reason: `画像の取得に失敗しました(${err instanceof Error ? err.message : "unknown error"})` };
    }
    if (!res.ok) {
      // 期限切れ(403)・権限なし(403)・対象なし(404)等をここで拾う——
      // 黙ってスキップせず理由として利用者へ返す(旧imageBundle.tsと同じ文言)。
      return { ok: false, reason: `画像を取得できませんでした(HTTP ${res.status})` };
    }

    const reader = res.body?.getReader();
    if (!reader) {
      // ストリーム読み出しに対応していない実行環境向けのフォールバック
      // (標準のブラウザfetchでは通常到達しない)。この経路だけは
      // 全量読み切ってからの上限判定になる点に注意。
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > opts.fileByteLimit) {
        return { ok: false, reason: `1枚あたりの上限(${Math.floor(opts.fileByteLimit / 1024 / 1024)}MB)を超えています` };
      }
      if (!opts.onBytes(buf.byteLength)) {
        return { ok: false, reason: "合計サイズ上限を超えたため中断しました" };
      }
      return { ok: true, bytes: buf };
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > opts.fileByteLimit) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: `1枚あたりの上限(${Math.floor(opts.fileByteLimit / 1024 / 1024)}MB)を超えています(取得中に中断)` };
        }
        if (!opts.onBytes(value.byteLength)) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "合計サイズ上限を超えたため中断しました" };
        }
        chunks.push(value);
      }
    } catch (err) {
      // 通信停止(接続リセット等)はreader.read()が例外を投げてくる——
      // ここで捕まえて失敗結果として返す(呼び出し側のPromise.allを
      // 巻き込んで壊さない。1件の通信断が他の正常な画像の取得結果まで
      // 失わせない)。
      if (timedOut) return { ok: false, reason: `画像の取得がタイムアウトしました(${opts.timeoutMs}ms)` };
      if (controller.signal.aborted) return { ok: false, reason: "他の画像の失敗や合計サイズ/時間予算の超過により取得を中断しました" };
      return { ok: false, reason: `画像の取得中に通信が停止しました(${err instanceof Error ? err.message : "unknown error"})` };
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { ok: true, bytes };
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", forwardAbort);
  }
}

/**
 * 画像取得計画(app/actions/listing.tsのgetMercariCsvImageZipPlanAction
 * が返すURL一覧)から、実際にブラウザでZIPを組み立てる。
 */
export async function assembleZipFromPlan(filename: string, plan: ZipDownloadPlanItem[]): Promise<ZipAssembleResult> {
  if (plan.length === 0) {
    return { ok: false, reason: "ZIPに含める画像が0件です" };
  }

  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), ZIP_TOTAL_TIME_BUDGET_MS);

  let totalBytes = 0;
  let totalExceeded = false;
  function onBytes(n: number): boolean {
    totalBytes += n;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      totalExceeded = true;
      overallController.abort();
      return false;
    }
    return true;
  }

  type ItemResult = { ok: true; item: ZipDownloadPlanItem; data: Uint8Array } | { ok: false; item: ZipDownloadPlanItem; reason: string };
  const results: ItemResult[] = new Array(plan.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= plan.length) return;
      const item = plan[i];
      if (overallController.signal.aborted) {
        results[i] = {
          ok: false,
          item,
          reason: totalExceeded
            ? `合計サイズ上限(${Math.floor(MAX_ZIP_TOTAL_BYTES / 1024 / 1024)}MB)を超えたため中断しました`
            : `全体の時間予算(${Math.floor(ZIP_TOTAL_TIME_BUDGET_MS / 1000)}秒)を超えたため中断しました`,
        };
        continue;
      }
      // fetchImageBytesBounded自体はここまでの実装で例外を投げない設計だが、
      // 呼び出し元(このworker、ひいてはPromise.all)を1件の想定外の失敗で
      // 巻き込んで壊さないよう、念のためここでも捕まえる(1枚の通信断が
      // 他の正常な画像の取得結果まで失わせない、という方針の最終防衛線)。
      let fetched: Awaited<ReturnType<typeof fetchImageBytesBounded>>;
      try {
        fetched = await fetchImageBytesBounded(item.url, {
          fileByteLimit: MAX_ZIP_FILE_BYTES,
          timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
          signal: overallController.signal,
          onBytes,
        });
      } catch (err) {
        fetched = { ok: false, reason: `画像の取得に失敗しました(${err instanceof Error ? err.message : "unknown error"})` };
      }
      results[i] = fetched.ok && fetched.bytes ? { ok: true, item, data: fetched.bytes } : { ok: false, item, reason: fetched.reason ?? "画像の取得に失敗しました" };
    }
  }

  try {
    const workerCount = Math.min(ZIP_FETCH_CONCURRENCY, plan.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    clearTimeout(overallTimer);
  }

  const failures = results.filter((r): r is Extract<ItemResult, { ok: false }> => !r.ok);
  if (failures.length > 0) {
    // 1件でも失敗したら部分成功のZIPを作らない(imageBundle.ts/exportCsv.tsと同じ方針)。
    return {
      ok: false,
      reason: "一部商品の画像を取得できませんでした",
      failures: failures.map((f) => ({
        inventoryId: f.item.inventoryId,
        displayId: f.item.displayId,
        reason: `${f.item.filename}: ${f.reason}`,
      })),
    };
  }

  const successes = results as Extract<ItemResult, { ok: true }>[];
  const zip = buildStoredZip(successes.map((r) => ({ filename: r.item.filename, data: r.data })));
  if (!zip.ok || !zip.bytes) {
    return { ok: false, reason: zip.reason ?? "ZIPの組み立てに失敗しました" };
  }

  // new Uint8Array(zip.bytes)でArrayBuffer(SharedArrayBufferではない)
  // 裏付けの新しいTypedArrayへコピーし直す——BlobPartはArrayBufferView<ArrayBuffer>
  // を要求するが、Uint8Array型注釈だけでは(TS 5.7+のUint8Array汎用化により)
  // ArrayBufferLikeとして扱われ、そのままでは型が合わない。
  const blob = new Blob([new Uint8Array(zip.bytes)], { type: "application/zip" });
  return { ok: true, blob, filename, fileCount: successes.length, totalBytes };
}

/** ZIP(Blob)をファイルとして保存する(mercariCsvDownload.tsのdownloadCsvFromBase64と同じ、Object URL経由の保存パターン)。 */
export function downloadZipBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
