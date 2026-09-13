/**
 * ImageProcessingPanel 実React境界試験(2026-09-13)専用モック。
 * esbuildのaliasでapp/actions/imageProcessing.tsの代わりに差し込む——
 * 実AWS/Server Actionを一切呼ばない、ブラウザ内で完結する合成ハーネス
 * 専用。next build/next devからはscripts/qa-image-processing-harness/を
 * 一切参照しないため本番へ混入しない。
 *
 * 各呼び出しをPromiseとして外側(Playwright)へ公開し、
 * window.__ipHarness.resolve(id, value)/reject(id, message) で呼び出し
 * 側の都合の良いタイミング・順序で解決できるようにする——遅延Promiseの
 * 到着順序をテストコード側から完全に制御するため(実タイマー/実サーバー
 * 遅延に頼ると再現性が落ちる)。
 */
export interface ImageProcessingVersionSummary {
  id: string;
  version: number;
  status: string;
  active: boolean;
  aspectRatio: string | null;
  processedMasterKey: string | null;
  webKey: string | null;
  thumbnailKey: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  completedAt: string | null;
}

interface PendingCall {
  id: number;
  fn: string;
  args: unknown[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

declare global {
  interface Window {
    __ipHarness: {
      calls: PendingCall[];
      resolve: (id: number, value: unknown) => void;
      reject: (id: number, message: string) => void;
      callsFor: (fn: string) => PendingCall[];
      latestCallFor: (fn: string) => PendingCall | undefined;
    };
  }
}

const calls: PendingCall[] = [];
let seq = 0;

function ensureHarness() {
  if (typeof window === "undefined") return;
  if (!window.__ipHarness) {
    window.__ipHarness = {
      calls,
      resolve(id, value) {
        const call = calls.find((c) => c.id === id);
        if (!call) throw new Error(`__ipHarness.resolve: no pending call ${id}`);
        call.resolve(value);
      },
      reject(id, message) {
        const call = calls.find((c) => c.id === id);
        if (!call) throw new Error(`__ipHarness.reject: no pending call ${id}`);
        call.reject(new Error(message));
      },
      callsFor(fn) {
        return calls.filter((c) => c.fn === fn);
      },
      latestCallFor(fn) {
        const matches = calls.filter((c) => c.fn === fn);
        return matches[matches.length - 1];
      },
    };
  }
}

function controllable<T>(fn: string) {
  return (...args: unknown[]): Promise<T> => {
    ensureHarness();
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      calls.push({ id, fn, args, resolve: resolve as (v: unknown) => void, reject });
    });
  };
}

export const listImageProcessingVersionsBatchAction = controllable<Record<string, ImageProcessingVersionSummary[] | null>>("batch");
// 【状態表示読取性能P3、2026-09-13夜】以前はpending job状態を即時解決の
// 固定値({}=常に「予約なし」)にしていた——batch側だけを手動制御すれば
// シナリオ1〜3(初回全体失敗/再試行/同一商品race/部分失敗)は検証できた
// ため。表示先行(版取得とpending確認の反映タイミングを分離したこと、
// docs/image-status-read-perf-followup-20260913.md参照)を検証するには
// pending側も独立して手動制御できる必要があるため、batchと同じ
// controllable()へ変更した。シナリオ1〜3はpending呼び出しの解決を
// 待たずに完了する(currentStatusのCHECKING擬似状態がデフォルトの
// 「加工する」ボタン文言・disabled表示へ安全に倒れるため、既存の
// アサーションは無改修で成立する)。
export const listPendingImageProcessingJobStatusesAction = controllable<Record<string, "PENDING" | "PROCESSING">>("pending");
export const listImageProcessingVersionsAction = controllable<ImageProcessingVersionSummary[]>("single");
export const reprocessImageAction = controllable<{ enqueued: boolean }>("reprocess");
export const reprocessAllImagesAction = controllable<{ enqueuedCount: number; skippedNoHashCount: number }>("reprocessAll");
export const adoptImageVersionAction = controllable<void>("adopt");
export const rollbackImageVersionAction = controllable<void>("rollback");
