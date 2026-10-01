"use client";

import { useState } from "react";
import { readNextEngineMasterCandidates, type MasterCandidatesResult } from "@/app/actions/nextEngineMasterCandidates";

export function NextEngineMasterCandidatesPanel() {
  const [result, setResult] = useState<MasterCandidatesResult | null>(null);
  const [pending, setPending] = useState(false);
  async function read() {
    if (pending) return;
    setPending(true);
    try { setResult(await readNextEngineMasterCandidates()); }
    catch { setResult({ ok: false, message: "登録情報を確認できませんでした。" }); }
    finally { setPending(false); }
  }
  return (
    <section className="mt-4 space-y-2 border-t border-gray-200 pt-4">
      <h3 className="font-semibold text-gray-900">登録済みの仕入先と店舗</h3>
      <button type="button" className="rounded border border-gray-300 px-3 py-2 disabled:opacity-50"
        disabled={pending} onClick={() => void read()}>{pending ? "確認中…" : "登録情報を確認"}</button>
      {result && !result.ok && <p role="status" className="text-amber-800">
        {result.message}{result.code ? `（確認コード: ${result.code}` : ""}
        {result.apiCode ? `、NEコード: ${result.apiCode}` : ""}
        {result.httpStatus ? `、HTTP: ${result.httpStatus}` : ""}
        {result.code ? "）" : ""}
      </p>}
      {result?.ok && <div className="space-y-3" role="status">
        <div>
          <h4 className="font-medium">有効な仕入先（コード・名称）</h4>
          {result.data.suppliers.length ? <ul className="list-inside list-disc">
            {result.data.suppliers.map(row => <li key={row.code}>{row.code} — {row.name}</li>)}
          </ul> : <p>表示範囲に有効な仕入先はありません。</p>}
          {result.data.suppliersMore && <p>51件目以降は表示していません。</p>}
        </div>
        <div>
          <h4 className="font-medium">登録店舗（ID・名称）</h4>
          {result.data.shops.length ? <ul className="list-inside list-disc">
            {result.data.shops.map(row => <li key={row.id}>{row.id} — {row.name}</li>)}
          </ul> : <p>表示範囲に有効な店舗はありません。</p>}
          {result.data.shopsMore && <p>51件目以降は表示していません。</p>}
        </div>
        <p className="text-amber-800">店舗の登録状況から、自動の商品連携設定は判定できません。各店舗・連携アプリの設定を別途確認してください。</p>
      </div>}
    </section>
  );
}
