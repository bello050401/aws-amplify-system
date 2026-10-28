"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { defaultYahooPurchaseRange } from "@/lib/procurement/yahooRange";
import { editYahooAmounts, initialYahooAmounts, yahooAmountError, type YahooAmountFields } from "@/lib/procurement/yahooAmounts";
import {
  startYahooProcurementAction,
  readYahooProcurementAction,
  previewYahooProcurementAction,
  prepareYahooProcurementPhotoAction,
  registerYahooProcurementAction,
  type YahooProcurementRow,
} from "@/app/actions/yahooProcurement";
type Row = YahooProcurementRow & YahooAmountFields & {
  selected: boolean;
  confirmed: boolean;
  distinct: boolean;
  result?: string;
};
export default function YahooProcurementPanel() {
  const [from, setFrom] = useState(() => defaultYahooPurchaseRange().from),
    [to, setTo] = useState(() => defaultYahooPurchaseRange().to),
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
      ...initialYahooAmounts(l),
      selected: !l.inventoryId,
      confirmed: !l.changed,
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
      `${items.length ? `未取り込みの${items.length}商品を取得しました。写真・数量・送料を確認して登録できます。` : "この期間に未取り込みの商品はありません。"}${r.importedCount ? `取り込み済み${r.importedCount}商品を除外しました。` : ""}${r.excludedCount ? `キャンセル等の${r.excludedCount}商品も除外しています。` : ""}${r.unrecognized ? `形式を確認できない通知が${r.unrecognized}通あります。これらは自動登録せず、Gmailでの確認が必要です。` : ""}`,
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
      setNotice("");
      setError((e as Error).message);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function fetchLots(specifyDates = false) {
    await execute(async () => {
      setRows([]);
      setRun("");
      setNotice("購入通知を取得しています…");
      const r = specifyDates
        ? await startYahooProcurementAction(from, to)
        : await startYahooProcurementAction();
      if (!r.ok) throw Error(r.error);
      setRun(r.runId);
      await read(r.runId);
    });
  }
  async function register() {
    await execute(async () => {
      const selected = rows.filter((r) => r.selected && !r.inventoryId);
      if (!selected.length) return;
      // The ledger includes every item in a combined order, including unselected items.
      const required = rows.filter(r => !r.inventoryId && selected.some(s =>
        s.auctionId === r.auctionId || (!!s.orderId && s.orderId === r.orderId)));
      for (const row of required) {
        const invalid = yahooAmountError(row);
        if (invalid) throw Error(row.auctionId + "：" + invalid);
        if (row.changed && !row.confirmed) throw Error(row.auctionId + "：金額変更通知があります。最新の金額を確認してください。");
      }
      for (const row of selected) {
        if (!row.sourceReady) throw Error(row.auctionId + "：写真・ストア情報の取得が完了していません。");
        if (row.possibleDuplicates.length && !row.distinct) throw Error(row.auctionId + "：同名の既存商品とは別の仕入れか確認してください。");
      }
      const quantity = selected.reduce((n, r) => n + Number(r.count), 0);
      const total = selected.reduce((n, r) => n + Number(r.total) + Number(r.postage), 0);
      if (!window.confirm(`選択した${selected.length}商品（${quantity}点）を登録します。\n購入金額合計（送料込）：${total.toLocaleString()}円\n\n送料がない商品は0円で登録します。数量・購入単価・送料に間違いありませんか？`)) return;
      const confirmation = rows.map((r) => ({
        auctionId: r.auctionId,
        quantity: Number(r.count),
        itemTotal: Number(r.total),
        shipping: r.postage === "" ? NaN : Number(r.postage),
        amountConfirmed: !r.changed || r.confirmed,
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
  const selected = rows.filter(r => r.selected && !r.inventoryId);
  const selectedValid = selected.every(r => !yahooAmountError(r));
  const selectedQuantity = selected.reduce((n, r) => n + Number(r.count), 0);
  const selectedTotal = selected.reduce((n, r) => n + Number(r.total) + Number(r.postage), 0);
  return (
    <section className="space-y-5">
      <div className="rounded-lg border bg-white p-4 space-y-3">
        <h2 className="text-lg font-bold">ヤフオクの落札商品を取り込む</h2>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void fetchLots()}
            disabled={busy}
            className="rounded bg-blue-700 px-6 py-3 font-bold text-white disabled:opacity-50"
          >
            未取り込みの商品を取得
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
          取り込み済み・キャンセルの商品は除外します。まだ登録していない商品は、次回も表示されます。
        </p>
        <p className="text-sm font-medium text-gray-800">
          購入価格は1点あたりの単価です。送料が取得できない商品は0円で開始します。送料がかかる商品だけ変更してください。
        </p>
        <details className="rounded border border-gray-200 p-3">
          <summary className="cursor-pointer font-medium text-blue-700">期間を指定して取得</summary>
          <p className="mt-2 text-sm text-gray-600">通常は2026/10/15以降の直近31日が対象です。それ以前の商品はここで期間を指定してください（1回31日以内）。取り込み済みの商品は再登録しません。</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
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
            onClick={() => void fetchLots(true)}
            disabled={busy}
            className="rounded bg-blue-700 px-6 py-3 text-white disabled:opacity-50"
          >
            この期間の未取り込み商品を取得
          </button>
          </div>
        </details>
        <details className="text-sm text-gray-600">
          <summary className="cursor-pointer">登録内容・金額の計算方法</summary>
        <p className="text-sm text-gray-600">
          購入通知から取得し、先頭の商品写真を登録します。保管場所は所沢事務所、カテゴリは補修待ちです。ストアの会社名・本店住所はストア情報から入力し、個人出品者の氏名・住所は空欄にします。本人確認方法・職業は指定の固定値、古物の特徴は商品名から入力します。
        </p>
        <p className="text-sm text-gray-600">
          購入単価＝（税込の商品合計＋この商品分の送料）÷数量。1円未満は四捨五入します。古物台帳の購入合計は端数を丸める前の実際の合計金額です。数量・送料を変更すると単価を再計算します。単価を直接変更すると購入合計も変更します。まとめ買いの送料は商品金額の割合で配分します。金額変更通知がある場合は、取引ナビで最新の金額を確認してください。
        </p>
        </details>
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
      {!!rows.length && (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-gray-50 px-3 py-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-5 w-5" disabled={busy}
                checked={rows.some(r => !r.inventoryId) && rows.filter(r => !r.inventoryId).every(r => r.selected)}
                onChange={e => setRows(old => old.map(r => r.inventoryId ? r : { ...r, selected: e.target.checked }))} />
              すべて選択
            </label>
            <span>{rows.length}商品 ／ 選択 {selected.length}商品</span>
          </div>
          {rows.map((r, index) => (
            <article key={r.auctionId} aria-label={`仕入れ商品 ${index + 1}`} className="border-b border-gray-200 p-3 last:border-b-0">
              <div className="grid grid-cols-[1.25rem_4rem_minmax(0,1fr)] items-center gap-3 lg:grid-cols-[1.25rem_4.5rem_minmax(12rem,1fr)_5.5rem_9rem_8rem]">
                <input type="checkbox" aria-label={`選択 ${r.auctionId}`} checked={r.selected}
                  disabled={busy || !!r.inventoryId} className="h-5 w-5"
                  onChange={e => patch(r.auctionId, { selected: e.target.checked })} />
                {r.imageUrl ? (
                  <img src={r.imageUrl} alt={r.name} referrerPolicy="no-referrer" loading="lazy"
                    className="h-16 w-16 rounded bg-gray-50 object-contain lg:h-18 lg:w-18" />
                ) : <div className="grid h-16 w-16 place-items-center rounded bg-gray-50 text-xs">写真未取得</div>}
                <div className="min-w-0">
                  <p className="line-clamp-2 break-words text-sm font-semibold" title={r.name}>{r.name}</p>
                  <p className="mt-1 text-xs text-gray-500">{r.date} ／ {r.auctionId}</p>
                  {r.inventoryId && <p className="mt-1 text-sm text-green-700">{r.result || "登録済み"}　<Link href={"/inventory/" + r.inventoryId} className="underline">商品ページ</Link></p>}
                </div>
                <div className="col-span-3 grid min-w-0 grid-cols-[minmax(0,0.65fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 lg:contents">
                  {([
                    ["数量（点）", "count"],
                    ["購入単価（送料込・円）", "unitPrice"],
                    ["送料（全点分・円）", "postage"],
                  ] as const).map(([label, field]) => (
                    <label key={field} className="grid min-w-0 gap-1 text-xs text-gray-600">
                      {label}
                      <input aria-label={label + " " + r.auctionId} type="number" inputMode="numeric"
                        min={field === "count" ? 1 : 0} max={field === "count" ? 10000 : 2147483647} step="1"
                        value={r[field]} disabled={busy || !!r.inventoryId}
                        onChange={e => patch(r.auctionId, { ...editYahooAmounts(r, field, e.target.value), confirmed: !r.changed })}
                        className="min-h-11 w-full min-w-0 rounded border border-gray-300 px-2 py-2 text-right text-base tabular-nums text-gray-900 disabled:bg-gray-50" />
                    </label>
                  ))}
                </div>
              </div>
              <details className="mt-2 text-sm text-gray-600">
                <summary className="cursor-pointer text-blue-700">詳細・取引情報</summary>
                <div className="mt-2 space-y-2 rounded bg-gray-50 p-3">
                  <p className="break-words">{r.name}</p>
                  <p>商品合計（税込・送料別）：{Number(r.total).toLocaleString()}円 ／ 購入合計（送料込）：{(Number(r.total) + Number(r.postage)).toLocaleString()}円</p>
                  {r.orderId && <p className="break-all">注文：{r.orderId}</p>}
                  <a href={`https://auctions.yahoo.co.jp/jp/auction/${r.auctionId}`} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">商品・取引ナビを確認</a>
                  {r.storeInfo ? <p>古物台帳：{r.storeInfo.name}<br />{r.storeInfo.address}<br /><a href={r.storeInfo.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">ストア情報</a></p>
                    : r.sourceReady && <p>個人出品者：相手氏名・住所は空欄。本人確認方法・職業は指定の固定値</p>}
                </div>
              </details>
              {!!r.warnings.length && <p className="mt-2 text-sm text-amber-800">{r.warnings.join(" ")}</p>}
              {!r.inventoryId && r.changed && (
                <label className="mt-2 flex items-start gap-2 rounded bg-amber-50 p-2 text-sm">
                  <input type="checkbox" checked={r.confirmed} disabled={busy} className="h-5 w-5 shrink-0"
                    onChange={e => patch(r.auctionId, { confirmed: e.target.checked })} />
                  金額変更通知の最新金額・送料を確認しました
                </label>
              )}
              {!r.inventoryId && !!r.possibleDuplicates.length && (
                <div className="mt-2 rounded bg-amber-50 p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>同名の商品があります。</span>
                    {r.possibleDuplicates.map((d, i) => <Link key={d.id} href={"/inventory/" + d.id} target="_blank" title={d.name} className="text-blue-700 underline">既存商品を確認{r.possibleDuplicates.length > 1 ? ` ${i + 1}` : ""}</Link>)}
                  </div>
                  <label className="mt-2 flex items-start gap-2">
                    <input type="checkbox" checked={r.distinct} disabled={busy} className="h-5 w-5 shrink-0"
                      onChange={e => patch(r.auctionId, { distinct: e.target.checked })} />
                    既存の商品とは別の仕入れであることを確認しました
                  </label>
                </div>
              )}
              {!r.inventoryId && yahooAmountError(r) && <p role="alert" className="mt-2 text-sm text-red-700">{yahooAmountError(r)}</p>}
              {r.error && <p role="alert" className="mt-2 text-sm text-red-700">{r.error}</p>}
              {!r.sourceReady && !busy && <button
                onClick={() => void execute(async () => {
                  const p = await prepareYahooProcurementPhotoAction(run, r.auctionId);
                  if (!p.ok) throw Error(p.error);
                  patch(r.auctionId, { sourceReady: true, imageUrl: p.imageUrl, storeInfo: p.storeInfo, date: p.date, error: undefined });
                })} className="mt-2 rounded border px-3 py-2">写真・ストア情報を再取得</button>}
            </article>
          ))}
        </div>
      )}
      {!!rows.length && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-100 bg-white px-4 py-3 shadow-lg">
          <div>
            <p className="font-semibold">選択 {selected.length}商品{selectedValid ? `・${selectedQuantity}点` : ""}</p>
            <p className="text-sm text-gray-600">購入金額合計（送料込）：{selectedValid ? `${selectedTotal.toLocaleString()}円` : "入力内容を確認してください"}</p>
          </div>
          <button onClick={register} disabled={busy || !selected.length || !selectedValid}
            className="min-h-11 rounded bg-blue-700 px-6 py-3 font-bold text-white disabled:opacity-50">
            {busy ? "処理中…" : "選択した商品を確認して登録"}
          </button>
        </div>
      )}
    </section>
  );
}
