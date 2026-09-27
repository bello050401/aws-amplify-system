"use client";

export function NextEngineListingSection({ title, description, price, imageCount, hasDraft }: {
  title: string; description: string; price: string; imageCount: number; hasDraft: boolean;
}) {
  const count = (value: string) => Array.from(value.trim()).length;
  const checks = [
    { label: "商品名", ready: count(title) > 0 && count(title) <= 130, detail: `${count(title)} / 130文字` },
    { label: "商品説明", ready: count(description) > 0 && count(description) <= 3000, detail: `${count(description)} / 3,000文字` },
    { label: "販売価格", ready: price.trim() !== "" && Number.isSafeInteger(Number(price)) && Number(price) >= 300 && Number(price) <= 9999999, detail: "300〜9,999,999円" },
    { label: "出品画像", ready: imageCount > 0 && imageCount <= 20, detail: `${imageCount} / 20枚` },
  ];
  return (
    <section aria-labelledby="next-engine-heading" className="mt-4 rounded border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="next-engine-heading" className="text-sm font-bold text-gray-900">メルカリShops出品 · ネクストエンジン経由</h2>
        <span className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">自動送信の接続準備中</span>
      </div>
      <p className="mt-2 text-xs text-gray-600">上の下書きで商品名・説明・価格・画像を準備します。カテゴリー・ブランドなどの販売先設定は、ネクストエンジン側の出品設定で確定します。</p>
      <ul className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        {checks.map(check => <li key={check.label} className="flex items-center justify-between gap-2 rounded bg-gray-50 p-2">
          <span>{check.label} <span className={check.ready ? "text-green-700" : "text-amber-800"}>{check.ready ? "入力済み" : "要確認"}</span></span>
          <span className="text-gray-500">{check.detail}</span>
        </li>)}
      </ul>
      <ol className="mt-4 list-inside list-decimal space-y-1 text-xs text-gray-700">
        <li>下書きを保存{hasDraft ? "（保存済みの下書きあり。変更した内容は再保存してください）" : "（まだ保存されていません）"}</li>
        <li>ネクストエンジンへ商品情報を連携 — 接続準備中</li>
        <li>ネクストエンジン側で画像・販売先設定を確認して出品</li>
      </ol>
      <p className="mt-3 text-xs text-amber-800">現在、この画面からネクストエンジンへの送信・メルカリShopsへの公開はできません。入力済みの表示は、送信成功や出品完了を意味しません。</p>
      <a href="https://base.next-engine.org/" target="_blank" rel="noopener noreferrer" className="mt-3 inline-block rounded border border-gray-300 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50">ネクストエンジンを開く</a>
    </section>
  );
}
