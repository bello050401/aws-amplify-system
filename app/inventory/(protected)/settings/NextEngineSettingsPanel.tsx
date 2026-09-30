"use client";

import type { NextEngineConnectionState } from "@/lib/listing/nextEngine/connectionState";

const labels: Record<NextEngineConnectionState, string> = {
  CONFIGURATION_REQUIRED: "アプリ認証情報の設定待ち",
  SECRET_UNAVAILABLE: "認証情報の安全な保管先を確認できません",
  AWAITING_LAUNCH: "ネクストエンジン側からの接続待ち",
  CONNECTED: "接続済み",
};

export function NextEngineSettingsPanel({ state, diagnosticEnabled }: { state: NextEngineConnectionState; diagnosticEnabled: boolean }) {
  return (
    <section className="max-w-2xl space-y-3 rounded border border-gray-200 bg-white p-4 text-[13px] text-gray-700">
      <h2 className="font-bold text-gray-900">ネクストエンジン商品情報連携</h2>
      <p>接続状態: <strong>{labels[state]}</strong></p>
      <p>この連携はBELLOの商品情報をネクストエンジンの商品マスタへ渡すためのものです。商品画像やメルカリShopsでの公開は別途確認します。</p>
      <p className="text-amber-800">商品マスタ登録と非公開テスト商品の処理結果は、まだ確認できていません。</p>
      {diagnosticEnabled && (
        <details className="rounded border border-amber-300 bg-amber-50 p-3">
          <summary className="cursor-pointer font-semibold">合成値だけの接続診断を開く</summary>
          <p className="mt-2">検証用の固定合成値だけで保存先への読み書きを1回確認します。ネクストエンジンへの接続や商品送信は行いません。</p>
          <form method="post" action="/api/next-engine/diagnostic" className="mt-2">
            <button type="submit" className="rounded border border-amber-700 px-3 py-2 text-amber-950">合成診断を1回実行</button>
          </form>
        </details>
      )}
    </section>
  );
}
