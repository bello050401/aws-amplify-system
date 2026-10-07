"use client";

import { useEffect, useRef, useState } from "react";
import { searchMercariBrandsAction } from "@/app/actions/listing";
import { prepareMercariManualListingPackAction,
  type MercariManualListingPack } from "@/app/actions/mercariManualListingPack";
import type { BrandMasterEntry } from "@/lib/listing/mercari/csv/masters";
import { LISTING_CONDITIONS } from "@/lib/listing/conditionOptions";
import { sameManualPackSelection,
  type ManualPackSelection } from "@/lib/listing/mercariBridge/manualPackSelection";
import { MercariFurnitureCategoryPicker } from "./MercariFurnitureCategoryPicker";

export function MercariManualListingPackPanel({ inventoryId, availableQuantity,
  hasDraft, hasShopsRecord }: { inventoryId: string; availableQuantity: number;
  hasDraft: boolean; hasShopsRecord: boolean }) {
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [category, setCategory] = useState<{ id: string; path: string } | null>(null);
  const [brandQuery, setBrandQuery] = useState("");
  const [brand, setBrand] = useState<BrandMasterEntry | null>(null);
  const [brandResults, setBrandResults] = useState<BrandMasterEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pack, setPack] = useState<MercariManualListingPack | null>(null);
  const [deadlineMono, setDeadlineMono] = useState<number | null | undefined>(undefined);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const selectionRevision = useRef(0);
  const selectionRef = useRef<ManualPackSelection>({
    price: "", quantity: "", categoryId: null, brandId: null,
  });
  const available = hasDraft && !hasShopsRecord && availableQuantity > 0;
  const conditionLabel = pack ? LISTING_CONDITIONS.find(item =>
    item.code === pack.condition)?.label ?? pack.condition : "";
  const copyText = pack ? [
    `商品名: ${pack.title}`,
    `販売価格: ${pack.priceYen.toLocaleString("ja-JP")}円`,
    `カテゴリー: ${pack.categoryPath}`,
    `ブランド: ${pack.brandName ?? "指定なし"}`,
    `状態: ${conditionLabel}`,
    `数量: ${pack.quantity}`,
    `管理コード: ${pack.managementCode}`,
    "配送方法: 未定（出品者手配）",
    "送料: 送料込み（出品者負担）",
    "発送元: 埼玉県",
    "発送まで: 4〜7日",
    "", "商品説明:", pack.description,
  ].join("\n") : "";
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const response = await fetch("http://127.0.0.1:56210/listing-send-window", {
          mode: "cors", credentials: "omit", cache: "no-store",
          signal: AbortSignal.timeout(4000),
        });
        const data = response.ok ? await response.json() : null;
        if (!disposed) setDeadlineMono(data?.ok === true &&
          (data.remainingSeconds === null ||
            (Number.isInteger(data.remainingSeconds) && data.remainingSeconds >= 0)) ?
          data.remainingSeconds === null ? null :
            performance.now() + data.remainingSeconds * 1000 : undefined);
      } catch { if (!disposed) setDeadlineMono(undefined); }
    }
    void refresh();
    const poll = setInterval(() => void refresh(), 10_000);
    return () => { disposed = true; clearInterval(poll); };
  }, []);
  useEffect(() => {
    const tick = () => setSecondsLeft(deadlineMono === undefined ? null :
      deadlineMono === null ? -1 :
        Math.max(0, Math.ceil((deadlineMono - performance.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadlineMono]);
  async function searchBrand() {
    if (!brandQuery.trim() || busy) return;
    setBusy(true);
    try { setBrandResults(await searchMercariBrandsAction(brandQuery.trim())); }
    catch { setMessage("ブランドを検索できませんでした。"); }
    finally { setBusy(false); }
  }
  async function prepare() {
    if (!available || busy || !category || !/^[0-9]+$/.test(price) ||
        !/^[0-9]+$/.test(quantity)) return;
    setBusy(true);
    setMessage(null);
    setPack(null);
    const revision = selectionRevision.current;
    const requested: ManualPackSelection = { price, quantity,
      categoryId: category.id, brandId: brand?.brandId ?? null };
    try {
      const result = await prepareMercariManualListingPackAction(inventoryId, {
        priceYen: Number(price), quantity: Number(quantity),
        categoryId: category.id, brandId: brand?.brandId ?? null,
      });
      if (revision !== selectionRevision.current ||
          !sameManualPackSelection(requested, selectionRef.current)) {
        setMessage("入力が変わりました。現在の内容で確認し直してください。");
        return;
      }
      if (!result.ok) {
        setMessage(result.code === "EXISTING_LINK" ?
          "この在庫にはShops出品の記録があります。新規出品の準備を中止しました。" :
          result.code === "INVALID_SELECTION" ?
            "価格・カテゴリー・数量を確認してください。在庫数を超える数量は指定できません。" :
            "保存済みの下書きと写真を確認できませんでした。");
        return;
      }
      setPack(result.pack);
      await handoffToPc(result.pack, revision);
    } catch { setMessage("準備内容を作成できませんでした。再度内容を確認してください。"); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!pack) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setMessage("出品内容をコピーしました。Shopsへの送信はしていません。");
    } catch { setMessage("コピーできませんでした。下の内容を選択してコピーしてください。"); }
  }
  function downloadForPc() {
    if (!pack) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2) + "\n"],
      { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `bello-shops-private-preparation-${pack.inventoryId}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("PC用の準備ファイルを保存しました。メルカリShopsへの送信はしていません。");
  }
  async function handoffToPc(selectedPack: MercariManualListingPack,
    revision: number) {
    try {
      const response = await fetch("http://127.0.0.1:56210/general-private-create-job", {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json",
          "X-Bello-Mercari-Bridge": "GENERAL_PRIVATE_CREATE_NO_SEND" },
        body: JSON.stringify(selectedPack), signal: AbortSignal.timeout(10000),
      });
      const result = await response.json().catch(() => null);
      if (revision !== selectionRevision.current) {
        setMessage("入力が変わりました。現在の内容で確認し直してください。");
      } else if (result?.ok === true && result.status === "PREPARED_NO_SEND") {
        setMessage("PCに出品準備を渡しました。Shopsへの送信はまだ行っていません。");
      } else if (result?.code === "UNKNOWN_NO_RETRY") {
        setMessage("この商品の出品試行はPCに記録済みで、結果を確認できません。重複防止のため再送しません。");
      } else {
        setMessage("PCが準備内容を受け付けられませんでした。PCアプリで保存状態を確認してください。");
      }
    } catch {
      setMessage("PCアプリに接続できません。PCアプリを起動してからもう一度押すか、準備ファイルを保存してください。");
    }
  }
  async function sendPreparationToPc() {
    if (!pack || busy) return;
    const revision = selectionRevision.current;
    setBusy(true);
    setMessage(null);
    try { await handoffToPc(pack, revision); }
    finally { setBusy(false); }
  }
  return <section id="mercari-manual-preparation"
    className="mt-5 max-w-2xl rounded border border-gray-200 bg-white p-4 text-sm text-gray-800">
    <h2 className="font-bold">メルカリShops 出品準備</h2>
    <p className="mt-2 text-xs text-gray-600">タイトル・説明文・状態・写真は保存済みのEC下書きから読み込みます。価格、カテゴリー、数量はこの商品について選んでください。</p>
    <dl className="mt-3 grid grid-cols-2 gap-1 rounded bg-gray-50 p-3 text-xs">
      <dt>配送方法</dt><dd>未定（出品者手配）</dd>
      <dt>送料</dt><dd>送料込み（出品者負担）</dd>
      <dt>発送元</dt><dd>埼玉県</dd>
      <dt>発送まで</dt><dd>4〜7日</dd>
    </dl>
    <p className="mt-2 text-xs text-gray-600">送料込み参考価格を確認し、実際の販売価格を入力してください。参考価格は自動入力しません。</p>
    <p className="mt-2 text-xs text-gray-600" role="status">
      {secondsLeft === null ? "PCアプリに接続すると次の出品までの時間を表示します。" :
        secondsLeft < 0 ? "PC側で出品操作が進行中、または記録の確認が必要です。" :
        secondsLeft > 0 ? `次の出品まで ${secondsLeft} 秒` :
          "出品間隔の待機はありません。"}
    </p>
    {!available ? <p className="mt-3 text-amber-700">保存済みの下書き・在庫数・Shops出品記録を確認してください。新規出品準備は現在できません。</p> : <>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs">販売価格（円）<input type="number" min={300} max={9999999}
          step={1} value={price} disabled={busy}
          onChange={event => { selectionRevision.current++; selectionRef.current.price = event.target.value; setPrice(event.target.value); setPack(null); }}
          className="mt-1 w-full rounded border border-gray-300 p-2" /></label>
        <label className="text-xs">出品数量（在庫上限 {availableQuantity}）<input type="number"
          min={1} max={availableQuantity} step={1} value={quantity} disabled={busy}
          onChange={event => { selectionRevision.current++; selectionRef.current.quantity = event.target.value; setQuantity(event.target.value); setPack(null); }}
          className="mt-1 w-full rounded border border-gray-300 p-2" /></label>
      </div>
      <div className="mt-4">
        <p className="mb-2 font-bold">カテゴリーを選択</p>
        <MercariFurnitureCategoryPicker inventoryId={inventoryId}
          currentFullPath={undefined} busy={busy}
          onConfirm={(id, path) => { selectionRevision.current++; selectionRef.current.categoryId = id; setCategory({ id, path }); setPack(null); }} />
        <p className="mt-2 text-xs">選択中: {category?.path ?? "未選択"}</p>
      </div>
      <div className="mt-4">
        <p className="font-bold">ブランド（任意）</p>
        <div className="mt-1 flex gap-2"><input type="search" value={brandQuery} disabled={busy}
          onChange={event => setBrandQuery(event.target.value)}
          placeholder="ブランド名で検索" className="min-w-0 flex-1 rounded border border-gray-300 p-2" />
          <button type="button" onClick={() => void searchBrand()} disabled={busy || !brandQuery.trim()}
            className="rounded border border-gray-300 px-3 disabled:opacity-50">検索</button></div>
        {brandResults.length > 0 && <ul className="mt-1 max-h-40 overflow-auto border border-gray-200">
          {brandResults.map(item => <li key={item.brandId}><button type="button" disabled={busy}
            className="w-full px-2 py-1 text-left hover:bg-gray-50"
            onClick={() => { selectionRevision.current++; selectionRef.current.brandId = item.brandId; setBrand(item); setBrandResults([]); setPack(null); }}>
            {item.name}</button></li>)}
        </ul>}
        <p className="mt-1 text-xs">選択中: {brand?.name ?? "指定なし"}</p>
        {brand && <button type="button" disabled={busy}
          onClick={() => { selectionRevision.current++; selectionRef.current.brandId = null; setBrand(null); setPack(null); }}
          className="text-xs text-blue-700 underline">ブランド指定を外す</button>}
      </div>
      <button type="button" onClick={() => void prepare()}
        disabled={busy || !category || !/^[0-9]+$/.test(price) ||
          !/^[0-9]+$/.test(quantity)}
        className="mt-4 rounded bg-blue-700 px-4 py-2 font-bold text-white disabled:opacity-40">
        {busy ? "準備中…" : "出品準備をPCに渡す"}
      </button>
    </>}
    {message && <p role="status" className="mt-2 text-xs">{message}</p>}
    {pack && <div className="mt-4 rounded border border-gray-200 p-3 text-xs">
      <p className="font-bold">{pack.title}</p>
      <p>管理コード: <code>{pack.managementCode}</code></p>
      <p>価格 ¥{pack.priceYen.toLocaleString("ja-JP")} ／ 数量 {pack.quantity} ／ {pack.categoryPath}</p>
      <p>状態: {conditionLabel} ／ ブランド: {pack.brandName ?? "指定なし"}</p>
      <p className="mt-1">保存済み写真 {pack.imageRefs.length} 枚。送信前に写真もShops画面で確認してください。</p>
      <label className="mt-2 block">保存済みの商品説明
        <textarea readOnly value={pack.description}
          className="mt-1 h-32 w-full rounded border border-gray-200 p-2 text-xs" />
      </label>
      <button type="button" onClick={() => void copy()}
        className="mt-2 rounded border border-gray-300 px-3 py-1">出品内容をまとめてコピー</button>
      <button type="button" onClick={() => void sendPreparationToPc()} disabled={busy}
        className="ml-2 mt-2 rounded bg-blue-700 px-3 py-1 font-bold text-white disabled:opacity-40">
        {busy ? "PCへ送信中…" : "PCに出品準備を渡す"}</button>
      <button type="button" onClick={downloadForPc}
        className="ml-2 mt-2 rounded border border-gray-300 px-3 py-1">PC用の準備ファイルを保存</button>
      <textarea readOnly value={copyText} aria-label="Shops出品準備内容"
        className="mt-2 h-40 w-full rounded border border-gray-200 p-2 text-xs" />
    </div>}
  </section>;
}
