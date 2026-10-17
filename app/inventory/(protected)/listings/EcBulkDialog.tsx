"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { reviewEcListingAction, executeEcListingAction } from "@/app/actions/ecListingOperations";
import {
  EC_CHANNEL_LABEL,
  EC_OPERATION_LABEL,
  type EcChannel,
  type EcOperation,
  type EcReview,
} from "@/lib/listing/ecManagement";

export function EcBulkDialog({
  items,
  channel,
  operation,
  onClose,
  onChanged,
}: {
  items: { inventoryId: string; name: string }[];
  channel: EcChannel;
  operation: EcOperation;
  onClose: () => void;
  onChanged: (done: string[]) => void;
}) {
  const [reviews, setReviews] = useState<EcReview[]>([]),
    [busy, setBusy] = useState(true),
    [phase, setPhase] = useState<"review" | "execute" | "done">("review");
  const [terms, setTerms] = useState(false),
    [now, setNow] = useState(Date.now());
  const live = useRef(true),
    stop = useRef(false),
    started = useRef(false),
    dialog = useRef<HTMLDivElement>(null);
  const update = (value: EcReview) =>
    setReviews((rows) => [...rows.filter((r) => r.inventoryId !== value.inventoryId), value]);
  async function waitUntil(at: number) {
    while (live.current && !stop.current && Date.now() < at)
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, at - Date.now())));
  }
  useEffect(() => {
    live.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    if (!started.current) {
      started.current = true;
      void (async () => {
        for (const item of items) {
          if (!live.current || stop.current) break;
          let result: EcReview = {
            inventoryId: item.inventoryId,
            title: item.name,
            channel,
            operation,
            status: "BLOCKED",
            message: "通信に失敗しました。",
          };
          for (let attempt = 0; attempt < 50; attempt++) {
            try {
              result = await reviewEcListingAction(item.inventoryId, channel, operation);
            } catch {
              result = {
                ...result,
                status: "BLOCKED",
                message: "通信に失敗しました。入力は保存されたままです。",
              };
            }
            if (!live.current) return;
            update(result);
            if (result.status !== "WAIT") break;
            await waitUntil(result.nextAt ?? Date.now() + 1000);
            if (stop.current || !live.current) break;
          }
          if (live.current && result.status === "WAIT")
            update({
              ...result,
              status: "BLOCKED",
              message: "準備を中断しました。保存済みの途中結果から、もう一度確認できます。",
            });
        }
        if (live.current) setBusy(false);
      })();
    }
    return () => {
      live.current = false;
      clearInterval(timer);
      previous?.focus();
    };
    // One review queue per opened dialog; callbacks/objects must not restart preparation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ready = reviews.filter((r) => r.status === "READY"),
    requiresTerms = ready.some((r) => r.requiresTerms);
  async function execute() {
    if (busy || !ready.length || (requiresTerms && !terms)) return;
    setBusy(true);
    setPhase("execute");
    stop.current = false;
    const done: string[] = [];
    for (const review of ready) {
      if (stop.current || !live.current) break;
      let result: EcReview = review;
      for (let attempts = 0; attempts < 10; attempts++) {
        try {
          result = await executeEcListingAction(review, true, terms);
        } catch {
          result = {
            ...review,
            status: "BLOCKED",
            message: "結果を取得できませんでした。重複送信せず、販売先を確認してください。",
          };
        }
        if (!live.current) return;
        update(result);
        if (result.status !== "WAIT") break;
        await waitUntil(result.nextAt ?? Date.now() + 30000);
        if (stop.current || !live.current) break;
      }
      if (result.status === "DONE") done.push(result.inventoryId);
      else if (result.status === "WAIT")
        update({
          ...result,
          status: "BLOCKED",
          message: "送信待ちで中断しました。販売先の状態を確認してから、もう一度操作してください。",
        });
    }
    setBusy(false);
    setPhase("done");
    onChanged(done);
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onClose();
        if (e.key === "Tab") {
          const focusables = dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),a[href],input:not(:disabled)",
          );
          if (!focusables?.length) return;
          const first = focusables[0],
            last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ec-bulk-title"
        className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl outline-none"
      >
        <div className="flex items-start justify-between border-b px-5 py-4">
          <div>
            <h2 id="ec-bulk-title" className="text-lg font-bold">
              {EC_OPERATION_LABEL[operation]}の確認
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {operation === "ARCHIVE" || operation === "RESTORE" ? "EC商品情報" : EC_CHANNEL_LABEL[channel]}{" "}
              · {items.length}商品
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded px-3 py-2 text-sm disabled:opacity-30"
          >
            閉じる
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {operation === "ARCHIVE" && (
            <p className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-900">
              EC一覧の商品情報を削除します。在庫・画像・ZAICO・販売先の商品は削除されません。販売先を止める場合は「出品停止」を使ってください。
            </p>
          )}
          <ul className="divide-y">
            {items.map((item) => {
              const r = reviews.find((row) => row.inventoryId === item.inventoryId);
              return (
                <li key={item.inventoryId} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold">{r?.title || item.name}</p>
                    <span
                      className={`shrink-0 rounded px-2 py-1 text-xs ${r?.status === "DONE" ? "bg-green-50 text-green-700" : r?.status === "BLOCKED" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-700"}`}
                    >
                      {!r
                        ? "確認待ち"
                        : r.status === "READY"
                          ? "実行前"
                          : r.status === "DONE"
                            ? "完了"
                            : r.status === "WAIT"
                              ? "処理中"
                              : "要確認"}
                    </span>
                  </div>
                  {r?.price != null && (
                    <p className="mt-1 text-sm">
                      {r.price.toLocaleString()}円 · 数量 {r.quantity}{" "}
                      {r.imageCount != null && `· 画像 ${r.imageCount}枚`}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-gray-600">
                    {r?.message || "順番に確認します。"}
                    {r?.status === "WAIT" &&
                      r.nextAt &&
                      `（あと ${Math.max(0, Math.ceil((r.nextAt - now) / 1000))}秒）`}
                  </p>
                  {r?.details?.map((text, index) => (
                    <p key={index} className="mt-1 text-xs text-gray-600">
                      {text}
                    </p>
                  ))}
                  {r?.status === "BLOCKED" && (
                    <Link
                      href={`/inventory/${item.inventoryId}/listing?channel=${channel}`}
                      target="_blank"
                      className="mt-2 inline-block text-sm text-blue-700 underline"
                    >
                      出品情報を編集
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="border-t bg-gray-50 px-5 py-4">
          {requiresTerms && phase === "review" && (
            <label className="mb-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={terms}
                onChange={(e) => setTerms(e.target.checked)}
                className="mt-1"
              />
              表示内容とYahoo!オークションの利用規約・ガイドラインに同意して公開する
            </label>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-sm text-gray-600">
              {busy
                ? phase === "execute"
                  ? "実行しています…"
                  : "商品情報と出品先を確認しています…"
                : phase === "done"
                  ? "商品ごとの結果を確認してください。"
                  : `${ready.length}件を実行できます。`}
            </p>
            {busy ? (
              <button
                type="button"
                className="rounded border bg-white px-4 py-2 text-sm"
                onClick={() => {
                  stop.current = true;
                }}
              >
                残りの処理を中止
              </button>
            ) : phase === "done" ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded bg-gray-900 px-5 py-2 text-sm text-white"
              >
                一覧に戻る
              </button>
            ) : (
              <button
                type="button"
                disabled={!ready.length || (requiresTerms && !terms)}
                onClick={() => void execute()}
                className={`rounded px-5 py-2 text-sm font-semibold text-white disabled:opacity-40 ${operation === "ARCHIVE" ? "bg-red-700" : "bg-blue-700"}`}
              >
                {operation === "ARCHIVE"
                  ? `本当に${ready.length}件を削除する`
                  : `確認した${ready.length}件を${EC_OPERATION_LABEL[operation]}する`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
