"use client";

import { useState } from "react";
import { generateProductPageAction, type ProductPageActionResult } from "@/app/actions/productPage";

/**
 * 在庫情報からBASE掲載用の商品ページを生成する。
 *
 * ## 生成しただけでは出品しない
 *
 * ここで出るのは下書き。BASEへは何も送らない(外部への書き込みは
 * 別の仕組みで止めてある)。人が読んで、必要なら直してから使う前提。
 *
 * ## 足りない事実を隠さない
 *
 * 在庫に無い情報(寸法・コンディション等)は、それらしい文章で埋めずに
 * 空欄のまま返る。何が足りないかは「入力が必要な項目」として出す ——
 * 空欄は気づけるが、もっともらしい嘘は気づけない。
 */
export function ProductPageSection({ inventoryId }: { inventoryId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProductPageActionResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    setBusy(true);
    setResult(null);
    setCopied(false);
    try {
      setResult(await generateProductPageAction(inventoryId));
    } catch (err) {
      setResult({
        ok: false,
        error: err instanceof Error ? err.message : "生成に失敗しました。",
        correlationId: "",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えなくても本文は画面に出ているので選択してコピーできる。
    }
  }

  return (
    <div className="mt-6 border-t border-gray-200 pt-4">
      <p className="mb-1 text-[13px] font-bold text-gray-900">BASE商品ページの下書きを作る</p>
      <p className="mb-2 text-[11px] text-gray-500">
        在庫の情報と、BELLOが過去にBASEへ書いた商品説明の文体をもとに、掲載用の文章を作ります。
        <strong>作るのは下書きだけで、BASEへは何も送信しません。</strong>
        在庫に無い情報（寸法・素材・デザイナー等）は推測せず、空欄のままにします。
      </p>

      <button
        type="button"
        onClick={() => void handleGenerate()}
        disabled={busy}
        className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
      >
        {busy ? "生成中…（20秒ほどかかります）" : "商品ページを生成する"}
      </button>

      {result && !result.ok && (
        <p className="mt-2 border border-red-300 bg-red-50 p-2 text-[12px] text-red-700">{result.error}</p>
      )}

      {result?.ok && (
        <div className="mt-3 space-y-3">
          {/* 事実の裏付け検査に落ちた場合。文章は見せるが、そのまま使わせない。 */}
          {!result.result.ok && (
            <div className="border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900">
              <p className="font-bold">この下書きはそのまま使わないでください。</p>
              <p className="mt-1">{result.result.failureReason}</p>
            </div>
          )}

          {result.result.missingFacts.length > 0 && (
            <div className="border border-blue-300 bg-blue-50 p-2 text-[12px] text-blue-900">
              <p className="font-bold">在庫に情報が無いため、空欄にした項目</p>
              <ul className="mt-1 list-disc pl-4">
                {result.result.missingFacts.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
              <p className="mt-1 text-[11px]">在庫詳細でこれらを入力してから作り直すと、より完成度の高い文章になります。</p>
            </div>
          )}

          {result.result.sections && (
            <>
              <div>
                <p className="text-[11px] font-bold text-gray-600">商品タイトル案</p>
                <p className="border border-gray-200 bg-gray-50 p-2 text-[13px]">{result.result.sections.title}</p>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-[11px] font-bold text-gray-600">掲載用の本文</p>
                  <button
                    type="button"
                    onClick={() => void handleCopy(result.result.fullDescription ?? "")}
                    className="border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
                  >
                    {copied ? "コピーしました" : "本文をコピー"}
                  </button>
                </div>
                <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap border border-gray-200 bg-white p-3 text-[12px] leading-relaxed">
                  {result.result.fullDescription}
                </pre>
              </div>

              <details className="text-[11px] text-gray-500">
                <summary className="cursor-pointer">この文章の作られ方</summary>
                <ul className="mt-1 space-y-0.5 pl-4">
                  <li>文体プロファイル: v{result.result.styleProfileVersion ?? "—"}</li>
                  <li>文体の参考にした過去BASE商品: {result.result.referencedBaseItemIds.length}件</li>
                  <li>モデル: {result.result.modelProvider ?? "—"} / {result.result.modelName ?? "—"}</li>
                  {result.savedId && <li>保存済み（生成履歴として残ります）</li>}
                </ul>
                <p className="mt-1">
                  参考にした過去商品は<strong>文体の見本</strong>で、そこに書かれていた素材・寸法・年代は今回の商品へ転記していません。
                  生成後に、在庫の事実と照らして機械的な検査も通しています。
                </p>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}
