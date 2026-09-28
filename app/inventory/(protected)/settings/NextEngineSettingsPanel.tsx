"use client";

import { useSearchParams } from "next/navigation";
import type { NextEngineConnectionState } from "@/lib/listing/nextEngine/connectionState";

const labels: Record<NextEngineConnectionState, string> = {
  CONFIGURATION_REQUIRED: "アプリ認証情報の設定待ち",
  SECRET_UNAVAILABLE: "認証情報の安全な保管先を確認できません",
  AWAITING_LAUNCH: "ネクストエンジン側からの接続待ち",
  CONNECTED: "接続済み",
};

export function NextEngineSettingsPanel({ state }: { state: NextEngineConnectionState }) {
  const search = useSearchParams();
  return (
    <section className="max-w-2xl space-y-3 rounded border border-gray-200 bg-white p-4 text-[13px] text-gray-700">
      <h2 className="font-bold text-gray-900">ネクストエンジン商品情報連携</h2>
      <p>接続状態: <strong>{labels[state]}</strong></p>
      {search.has("nextEngineError") && <p role="alert" className="text-red-700">接続を確認できませんでした。管理者が設定と接続先を確認してください。</p>}
      {search.has("nextEngineConnected") && state === "CONNECTED" && <p role="status" className="text-green-700">認証情報の保存と再確認が完了しました。</p>}
      <p>この連携はBELLOの商品情報をネクストエンジンの商品マスタへ渡すためのものです。商品画像やメルカリShopsでの公開は別途確認します。</p>
      <p className="text-amber-800">商品マスタ登録と非公開テスト商品の処理結果は、まだ確認できていません。</p>
    </section>
  );
}
