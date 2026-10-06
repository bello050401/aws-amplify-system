"use client";

import { useState } from "react";
import { getMercariPrivateCreatePreparationAction } from
  "@/app/actions/mercariPrivateCreatePreparation";

/** Export only the saved BELLO draft. The file cannot create or publish a product. */
export function MercariPrivateCreatePreparationPanel({ inventoryId }: { inventoryId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function prepare() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await getMercariPrivateCreatePreparationAction(inventoryId);
      if (!result.ok) {
        setMessage(result.code === "INCOMPLETE_DRAFT" ?
          "説明文・価格・画像など、保存済み下書きの必須項目を確認してください。" :
          result.code === "EXISTING_LINK" ?
            "この在庫にはメルカリShopsとの紐付けまたは出品記録があります。新規作成は準備できません。" :
            "準備内容を確認できませんでした。ログイン状態と商品を確認してください。");
        return;
      }
      const blob = new Blob([JSON.stringify(result.preparation, null, 2) + "\n"],
        { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `bello-mercari-private-create-${result.preparation.inventoryCode}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("保存済み下書きの準備ファイルを作成しました。メルカリShopsへの送信は行っていません。");
    } catch {
      setMessage("準備ファイルを作成できませんでした。ログイン状態を確認してください。");
    } finally { setBusy(false); }
  }
  return <section className="mt-6 max-w-2xl rounded border border-gray-200 bg-white p-4 text-sm text-gray-800">
    <h2 className="font-bold">メルカリShops非公開出品の準備</h2>
    <p className="mt-2">保存済みの説明文・価格・写真を確認し、準備ファイルにまとめます。商品登録や公開は行いません。</p>
    <button type="button" disabled={busy} onClick={() => void prepare()}
      className="mt-3 rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-40">
      {busy ? "確認中…" : "保存済み内容から準備ファイルを作る"}
    </button>
    {message && <p role="status" className="mt-2">{message}</p>}
  </section>;
}
