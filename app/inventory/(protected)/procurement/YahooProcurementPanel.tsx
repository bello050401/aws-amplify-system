"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import {
  startYahooProcurementAction,
  readYahooProcurementAction,
  previewYahooProcurementAction,
  prepareYahooProcurementPhotoAction,
  registerYahooProcurementAction,
  type YahooProcurementRow,
} from "@/app/actions/yahooProcurement";
type Row = YahooProcurementRow & {
  selected: boolean;
  count: string;
  total: string;
  postage: string;
  confirmed: boolean;
  distinct: boolean;
  result?: string;
};
export default function YahooProcurementPanel() {
  const [from, setFrom] = useState("2026-10-15"),
    [to, setTo] = useState(() =>
      new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
    ),
    [run, setRun] = useState(""),
    [rows, setRows] = useState<Row[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [incomplete, setIncomplete] = useState(false);
  const working = useRef(false);
  const patch = (id: string, v: Partial<Row>) =>
    setRows((old) => old.map((r) => (r.auctionId === id ? { ...r, ...v } : r)));
  async function read(id: string) {
    setIncomplete(true);
    for (;;) {
      const r = await readYahooProcurementAction(id);
      if (!r.ok) throw Error(r.error);
      setNotice(`購入通知を確認中 ${r.checked} / ${r.total}通`);
      if (r.done) break;
    }
    setIncomplete(false);
    const r = await previewYahooProcurementAction(id);
    if (!r.ok) throw Error(r.error);
    const items: Row[] = r.rows.map((l) => ({
      ...l,
      selected: !l.inventoryId,
      count: String(l.quantity),
      total: String(l.itemTotal),
      postage: l.shipping === null ? "" : String(l.shipping),
      confirmed: l.shipping !== null && !l.changed,
      distinct: false,
    }));
    setRows(items);
    for (let i = 0; i < items.length; i++) {
      setNotice(`写真・ストア情報を取得中 ${i + 1} / ${items.length}商品`);
      const p = await prepareYahooProcurementPhotoAction(
        id,
        items[i].auctionId,
      );
      patch(
        items[i].auctionId,
        p.ok
          ? {
              imageUrl: p.imageUrl,
              storeInfo: p.storeInfo,
              date: p.date,
              sourceReady: true,
              error: undefined,
            }
          : { error: p.error },
      );
    }
    setNotice(
      `${items.length}商品を取得しました。${r.excludedCount ? `キャンセル等の${r.excludedCount}商品は除外しています。` : ""}${r.unrecognized ? `形式を確認できない通知が${r.unrecognized}通あります。これらは自動登録せず、Gmailでの確認が必要です。` : ""}写真・数量・送料を確認して登録できます。`,
    );
  }
  async function execute(job: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await job();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function fetchLots() {
    await execute(async () => {
      setRows([]);
      setRun("");
      setNotice("購入通知を取得しています…");
      const r = await startYahooProcurementAction(from, to);
      if (!r.ok) throw Error(r.error);
      setRun(r.runId);
      await read(r.runId);
    });
  }
  async function register() {
    await execute(async () => {
      const selected = rows.filter((r) => r.selected && !r.inventoryId);
      const confirmation = rows.map((r) => ({
        auctionId: r.auctionId,
        quantity: Number(r.count),
        itemTotal: Number(r.total),
        shipping: r.postage === "" ? NaN : Number(r.postage),
        amountConfirmed: r.confirmed,
        distinctConfirmed: r.distinct,
      }));
      let done = 0;
      for (const row of selected) {
        setNotice(`${++done} / ${selected.length}商品を登録中…`);
        const result = await registerYahooProcurementAction(
          run,
          row.auctionId,
          confirmation,
        );
        patch(
          row.auctionId,
          result.ok
            ? {
                inventoryId: result.inventoryId,
                result: result.skipped ? "登録済み" : "登録完了",
                error: undefined,
              }
            : { error: result.error },
        );
      }
      setNotice(
        "登録結果を確認してください。再取得しても同じオークションIDは重複登録しません。",
      );
    });
  }
  return (
    <section className="space-y-5">
      <div className="rounded border bg-white p-5 space-y-4">
        <h2 className="text-lg font-bold">ヤフオクの落札商品を取り込む</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1">
            開始日
            <input
              type="date"
              value={from}
              disabled={busy}
              onChange={(e) => setFrom(e.target.value)}
              className="min-h-11 rounded border p-2"
            />
          </label>
          <label className="grid gap-1">
            終了日
            <input
              type="date"
              value={to}
              disabled={busy}
              onChange={(e) => setTo(e.target.value)}
              className="min-h-11 rounded border p-2"
            />
          </label>
          <button
            onClick={fetchLots}
            disabled={busy}
            className="rounded bg-blue-700 px-6 py-3 text-white disabled:opacity-50"
          >
            取得
          </button>
          {run && incomplete && (
            <button
              disabled={busy}
              onClick={() => void execute(() => read(run))}
              className="rounded border px-4 py-3"
            >
              取得を続ける
            </button>
          )}
        </div>
        <p className="text-sm text-gray-600">
          購入通知から取得し、先頭の商品写真を登録します。保管場所は所沢事務所、カテゴリは補修待ちです。ストアの会社名・本店住所はストア情報から入力し、個人出品者の氏名・住所は空欄にします。本人確認方法・職業は指定の固定値、古物の特徴は商品名から入力します。
        </p>
        <p className="text-sm text-gray-600">
          商品合計は税込です。送料は別欄で確認し、購入単価には送料を含め、1円未満は四捨五入します。まとめ買いの送料は商品金額の割合で配分します。金額変更通知がある場合は、取引ナビで最新の金額を確認してください。
        </p>
      </div>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-4 text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded bg-blue-50 p-4">
          {notice}
        </p>
      )}
      <div className="space-y-4">
        {rows.map((r) => (
          <article key={r.auctionId} className="rounded border bg-white p-4">
            <div className="flex gap-4">
              {r.imageUrl ? (
                <img
                  src={r.imageUrl}
                  alt={r.name}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="h-24 w-24 shrink-0 rounded object-contain bg-gray-50"
                />
              ) : (
                <div className="h-24 w-24 shrink-0 grid place-items-center bg-gray-50 text-xs">
                  写真未取得
                </div>
              )}
              <div className="min-w-0">
                <label className="flex gap-2 font-bold">
                  <input
                    type="checkbox"
                    checked={r.selected}
                    disabled={busy || !!r.inventoryId}
                    onChange={(e) =>
                      patch(r.auctionId, { selected: e.target.checked })
                    }
                    className="h-5 w-5 shrink-0"
                  />
                  {r.name}
                </label>
                <p className="text-sm text-gray-600">
                  {r.date} ／ {r.auctionId}{" "}
                  {r.orderId && `／ 注文 ${r.orderId}`}
                </p>
                <a
                  href={`https://auctions.yahoo.co.jp/jp/auction/${r.auctionId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-700 underline"
                >
                  商品・取引ナビを確認
                </a>
              </div>
            </div>
            {r.inventoryId ? (
              <p className="mt-3 text-green-700">
                {r.result || "登録済み"}　
                <Link
                  href={"/inventory/" + r.inventoryId}
                  className="underline"
                >
                  商品ページ
                </Link>
              </p>
            ) : (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["数量（点）", "count"],
                      ["商品合計（税込・円）", "total"],
                      ["送料（この商品分・円）", "postage"],
                    ] as const
                  ).map(([label, key]) => (
                    <label className="grid gap-1 text-sm" key={key}>
                      {label}
                      <input
                        aria-label={label + " " + r.auctionId}
                        type="number"
                        inputMode="numeric"
                        min={key === "count" ? 1 : 0}
                        step="1"
                        value={r[key]}
                        disabled={busy}
                        onChange={(e) =>
                          patch(r.auctionId, {
                            [key]: e.target.value,
                            confirmed: false,
                          })
                        }
                        className="min-h-11 rounded border p-2"
                      />
                    </label>
                  ))}
                </div>
                <label className="mt-3 flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={r.confirmed}
                    disabled={busy || r.postage === ""}
                    onChange={(e) =>
                      patch(r.auctionId, { confirmed: e.target.checked })
                    }
                    className="h-5 w-5"
                  />
                  数量・商品合計・送料を確認しました
                </label>
              </>
            )}
            {!!r.warnings.length && (
              <p className="mt-2 text-sm text-amber-800">
                {r.warnings.join(" ")}
              </p>
            )}
            {r.storeInfo ? (
              <p className="mt-3 text-sm">
                古物台帳：{r.storeInfo.name}
                <br />
                {r.storeInfo.address}
                <br />
                <a
                  href={r.storeInfo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-700 underline"
                >
                  ストア情報
                </a>
              </p>
            ) : (
              r.sourceReady && (
                <p className="mt-3 text-sm text-gray-600">
                  個人出品者：相手氏名・住所・本人確認方法は空欄
                </p>
              )
            )}
            {!r.inventoryId && !!r.possibleDuplicates.length && (
              <div className="mt-3 rounded bg-amber-50 p-3 text-sm">
                <p>同名の商品があります。重複登録にご注意ください。</p>
                {r.possibleDuplicates.map((d) => (
                  <p key={d.id}>
                    <Link
                      href={"/inventory/" + d.id}
                      target="_blank"
                      className="text-blue-700 underline"
                    >
                      {d.name}
                    </Link>
                  </p>
                ))}
                <label className="mt-2 flex gap-2">
                  <input
                    type="checkbox"
                    checked={r.distinct}
                    disabled={busy}
                    onChange={(e) =>
                      patch(r.auctionId, { distinct: e.target.checked })
                    }
                    className="h-5 w-5"
                  />
                  既存の商品とは別の仕入れであることを確認しました
                </label>
              </div>
            )}
            {r.error && (
              <p role="alert" className="mt-3 text-red-700">
                {r.error}
              </p>
            )}
            {!r.sourceReady && !busy && (
              <button
                onClick={() =>
                  void execute(async () => {
                    const p = await prepareYahooProcurementPhotoAction(
                      run,
                      r.auctionId,
                    );
                    if (!p.ok) throw Error(p.error);
                    patch(r.auctionId, {
                      sourceReady: true,
                      imageUrl: p.imageUrl,
                      storeInfo: p.storeInfo,
                      date: p.date,
                      error: undefined,
                    });
                  })
                }
                className="mt-2 rounded border px-3 py-2"
              >
                写真・ストア情報を再取得
              </button>
            )}
          </article>
        ))}
      </div>
      {!!rows.length && (
        <button
          onClick={register}
          disabled={busy || !rows.some((r) => r.selected && !r.inventoryId)}
          className="rounded bg-blue-700 px-6 py-3 font-bold text-white disabled:opacity-50"
        >
          選択した商品を登録
        </button>
      )}
    </section>
  );
}
