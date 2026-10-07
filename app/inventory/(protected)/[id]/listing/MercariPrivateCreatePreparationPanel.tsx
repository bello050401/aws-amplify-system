"use client";

import { useState } from "react";
import { getMercariPrivateCreatePreparationAction } from
  "@/app/actions/mercariPrivateCreatePreparation";

const OLD_TEST_INVENTORY_ID = "dd273c1e-9b2a-4013-acc6-c445a481fab8";
const OLD_TEST_INTENT = "B005659_SEPARATE_PRIVATE_TEST_99999";
const NEXT_TEST_INVENTORY_ID = "5b0f3587-cbbb-4c09-ae78-595b2b3e353f";
const NEXT_TEST_INTENT = "B005413_SEPARATE_PRIVATE_TEST_99999";

/** Export only the saved BELLO draft. The file cannot create or publish a product. */
export function MercariPrivateCreatePreparationPanel({ inventoryId }: { inventoryId: string }) {
  const isOldPrivateTest = inventoryId.toLowerCase() === OLD_TEST_INVENTORY_ID;
  const isNextPrivateTest = inventoryId.toLowerCase() === NEXT_TEST_INVENTORY_ID;
  const isPrivateTest = isOldPrivateTest || isNextPrivateTest;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preparationText, setPreparationText] = useState<string | null>(null);
  const intent = isOldPrivateTest ? OLD_TEST_INTENT :
    isNextPrivateTest ? NEXT_TEST_INTENT : undefined;
  async function readPreparation() {
    const result = await getMercariPrivateCreatePreparationAction(inventoryId, intent);
    if (!result.ok) {
      setMessage(result.code === "INCOMPLETE_DRAFT" ?
        "説明文・価格・画像など、保存済み下書きの必須項目を確認してください。" :
        result.code === "EXISTING_LINK" ?
          "この在庫にはメルカリShopsとの紐付けまたは出品記録があります。新規作成は準備できません。" :
          result.code === "TEST_INTENT_REQUIRED" ?
            "この在庫は専用の非公開テストとしてのみ準備できます。" :
          "準備内容を確認できませんでした。ログイン状態と商品を確認してください。");
      return null;
    }
    return result.preparation;
  }
  async function prepare() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setPreparationText(null);
    try {
      const preparation = await readPreparation();
      if (!preparation) return;
      const blob = new Blob([JSON.stringify(preparation, null, 2) + "\n"],
        { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const code = "testManagementCode" in preparation ?
        preparation.testManagementCode : preparation.inventoryCode;
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
  async function copy() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setPreparationText(null);
    try {
      const preparation = await readPreparation();
      if (!preparation) return;
      const json = JSON.stringify(preparation, null, 2) + "\n";
      setPreparationText(json);
      try {
        await navigator.clipboard.writeText(json);
        setMessage("保存済み下書きの準備内容をコピーしました。Shopsへの送信は行っていません。");
      } catch {
        setMessage("自動コピーできませんでした。下の欄から準備内容をコピーしてください。Shopsへの送信は行っていません。");
      }
    } catch {
      setMessage("準備内容を取得できませんでした。ログイン状態を確認してください。");
    } finally { setBusy(false); }
  }
  return <section className="mt-6 max-w-2xl rounded border border-gray-200 bg-white p-4 text-sm text-gray-800">
    <h2 className="font-bold">メルカリShops非公開出品の準備</h2>
    <p className="mt-2">{isOldPrivateTest ?
      "B005659の保存済み説明文と写真を読み、別の非公開テスト商品用に99,999円と専用管理コードを記録します。元のEC下書きは54,200円のままで、既存の公開商品も変更しません。傷の記載は保存内容の転記であり、現物確認済みを意味しません。" :
      isNextPrivateTest ?
      "B005413の保存済み説明文と写真を読み、別の非公開テスト商品用に99,999円と専用管理コードを記録します。元のEC下書きは30,000円のままで、既存の出品は変更しません。" :
      "保存済みの説明文・価格・写真を確認し、準備ファイルにまとめます。商品登録や公開は行いません。"}</p>
    <button type="button" disabled={busy} onClick={() => void prepare()}
      className="mt-3 rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-40">
      {busy ? "確認中…" : isOldPrivateTest ?
        "B005659の非公開テスト準備ファイルを作る" :
        isNextPrivateTest ? "B005413の非公開テスト準備ファイルを作る" :
        "保存済み内容から準備ファイルを作る"}
    </button>
    <button type="button" disabled={busy} onClick={() => void copy()}
      className="ml-2 mt-3 rounded border border-blue-700 px-3 py-2 text-blue-700 disabled:opacity-40">
      準備内容をコピーする
    </button>
    {preparationText && <textarea readOnly aria-label="準備内容（コピー用）"
      className="mt-3 block h-32 w-full rounded border border-gray-300 p-2"
      value={preparationText} />}
    {message && <p role="status" className="mt-2">{message}</p>}
  </section>;
}
