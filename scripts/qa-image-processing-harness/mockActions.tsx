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
// pending job状態は今回のシナリオ(初回全体失敗/再試行/同一商品race/部分
// 失敗)の検証対象ではないため、テストの複雑化を避けて即時解決にする
// (常に「予約なし」)——batch側だけを完全に手動制御する。
export async function listPendingImageProcessingJobStatusesAction(_keys: string[]): Promise<Record<string, "PENDING" | "PROCESSING">> {
  return {};
}
export const listImageProcessingVersionsAction = controllable<ImageProcessingVersionSummary[]>("single");
export const reprocessImageAction = controllable<{ enqueued: boolean }>("reprocess");
export const reprocessAllImagesAction = controllable<{ enqueuedCount: number; skippedNoHashCount: number }>("reprocessAll");
export const adoptImageVersionAction = controllable<void>("adopt");
export const rollbackImageVersionAction = controllable<void>("rollback");
