"use client";

import { useState } from "react";
import { getMercariPrivateCreatePreparationAction } from
  "@/app/actions/mercariPrivateCreatePreparation";

const TEST_INVENTORY_ID = "dd273c1e-9b2a-4013-acc6-c445a481fab8";
const TEST_INTENT = "B005659_SEPARATE_PRIVATE_TEST_99999";

/** Export only the saved BELLO draft. The file cannot create or publish a product. */
export function MercariPrivateCreatePreparationPanel({ inventoryId }: { inventoryId: string }) {
  const isPrivateTest = inventoryId.toLowerCase() === TEST_INVENTORY_ID;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function prepare() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await getMercariPrivateCreatePreparationAction(
        inventoryId, isPrivateTest ? TEST_INTENT : undefined);
      if (!result.ok) {
        setMessage(result.code === "INCOMPLETE_DRAFT" ?
          "説明文・価格・画像など、保存済み下書きの必須項目を確認してください。" :
          result.code === "EXISTING_LINK" ?
            "この在庫にはメルカリShopsとの紐付けまたは出品記録があります。新規作成は準備できません。" :
            result.code === "TEST_INTENT_REQUIRED" ?
              "この在庫は専用の非公開テストとしてのみ準備できます。" :
            "準備内容を確認できませんでした。ログイン状態と商品を確認してください。");
        return;
      }
      const blob = new Blob([JSON.stringify(result.preparation, null, 2) + "\n"],
        { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const code = "testManagementCode" in result.preparation ?
        result.preparation.testManagementCode : result.preparation.inventoryCode;
      link.download = `bello-mercari-private-create-${code}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(isPrivateTest ?
        "99,999円・別管理コードの非公開テスト準備ファイルを作成しました。Shopsへの送信は行っていません。" :
        "保存済み下書きの準備ファイルを作成しました。メルカリShopsへの送信は行っていません。");
    } catch {
      setMessage("準備ファイルを作成できませんでした。ログイン状態を確認してください。");
    } finally { setBusy(false); }
  }
  return <section className="mt-6 max-w-2xl rounded border border-gray-200 bg-white p-4 text-sm text-gray-800">
    <h2 className="font-bold">メルカリShops非公開出品の準備</h2>
    <p className="mt-2">{isPrivateTest ?
      "B005659の保存済み説明文と写真を読み、別の非公開テスト商品用に99,999円と専用管理コードを記録します。元のEC下書きは54,200円のままで、既存の公開商品も変更しません。傷の記載は保存内容の転記であり、現物確認済みを意味しません。" :
      "保存済みの説明文・価格・写真を確認し、準備ファイルにまとめます。商品登録や公開は行いません。"}</p>
    <button type="button" disabled={busy} onClick={() => void prepare()}
      className="mt-3 rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-40">
      {busy ? "確認中…" : isPrivateTest ?
        "B005659の非公開テスト準備ファイルを作る" :
        "保存済み内容から準備ファイルを作る"}
    </button>
    {message && <p role="status" className="mt-2">{message}</p>}
  </section>;
}
