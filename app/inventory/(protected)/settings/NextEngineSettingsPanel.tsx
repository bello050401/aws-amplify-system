"use client";

import type { NextEngineConnectionState } from "@/lib/listing/nextEngine/connectionState";
import { NextEnginePrivateMasterTestPanel } from "./NextEnginePrivateMasterTestPanel";
import { NextEngineMasterCandidatesPanel } from "./NextEngineMasterCandidatesPanel";

const labels: Record<NextEngineConnectionState, string> = {
  CONFIGURATION_REQUIRED: "アプリ認証情報の設定待ち",
  SECRET_UNAVAILABLE: "認証情報の安全な保管先を確認できません",
  AWAITING_LAUNCH: "ネクストエンジン側からの接続待ち",
  TOKEN_REFERENCE_INVALID: "接続情報の保管先設定を確認できません",
  TOKEN_READ_UNAVAILABLE: "保存済み接続情報を読み取れません",
  TOKEN_FORMAT_INVALID: "保存済み接続情報の形式を確認できません",
  TOKEN_VERSION_MISMATCH: "アプリ認証情報の版と保存済み接続情報が一致しません",
  TOKEN_COMPANY_MISMATCH: "接続先企業と保存済み接続情報が一致しません",
  APP_CONFIGURATION_CHANGED: "接続状態の確認中にアプリ設定が変わりました",
  CONNECTED: "接続済み",
};

export function NextEngineSettingsPanel({ state, privateTestEnabled = false, privateRetestEnabled = false, callbackResult = null }: {
  state: NextEngineConnectionState;
  privateTestEnabled?: boolean;
  privateRetestEnabled?: boolean;
  callbackResult?: "success" | "failed" | null;
}) {
  return (
    <section className="max-w-2xl space-y-3 rounded border border-gray-200 bg-white p-4 text-[13px] text-gray-700">
      <h2 className="font-bold text-gray-900">ネクストエンジン商品情報連携</h2>
      {callbackResult === "failed" && <p className="text-amber-800">直前の接続処理を完了できませんでした。下の接続状態を確認してください。</p>}
      {callbackResult === "success" && state !== "CONNECTED" && <p className="text-amber-800">接続処理後の保存済み状態を確認できません。下の接続状態を確認してください。</p>}
      <p>接続状態: <strong>{labels[state]}</strong></p>
      <p>この連携はBELLOの商品情報をネクストエンジンの商品マスタへ渡すためのものです。商品画像やメルカリShopsでの公開は別途確認します。</p>
      <p>商品の送信と結果確認は、各商品のEC出品画面で行います。NEの商品マスタ登録だけでは販売先への出品は完了しません。</p>
      {state === "CONNECTED" && <NextEngineMasterCandidatesPanel />}
      {state === "CONNECTED" && privateTestEnabled && <NextEnginePrivateMasterTestPanel />}
      {state === "CONNECTED" && privateRetestEnabled && <NextEnginePrivateMasterTestPanel attempt="second" />}
    </section>
  );
}
