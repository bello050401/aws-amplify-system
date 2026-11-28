import React from "react";
import { createRoot } from "react-dom/client";
import { WholesaleTable } from "../../../app/inventory/(protected)/listings/WholesaleTable";
import type { WholesaleData, WholesaleSaveRequest } from "../../../lib/listing/wholesale";

const mode = new URLSearchParams(location.search).get("mode");
const sample: WholesaleData = { checkedAt: "2026-11-28T09:00:00Z", snapshotVersion: "fixture-v1", canEdit: mode !== "viewer", unlinkedCount: 3, ambiguousCount: 1, warnings: ["検証環境 — 架空商品だけを使用。実際の在庫・ECには接続しません。"], items: Array.from({ length: mode === "limit" ? 105 : 6 }, (_, i) => ({ id: `fixture-${i}`, name: `${["北欧スタイル 木製ダイニングチェア ナチュラル 長い商品名も省略せず確認できます", "ヴィンテージ風 サイドテーブル", "フロアランプ ホワイト", "ファブリックソファ グレー", "書棚 ウォールナット", "オーク材 ベンチ"][i % 6]} ${i + 1}`, displayId: `TEST-${i + 1}`, imageUrl: i === 2 ? null : "/fixture.svg", updatedAt: "fixture-v1", purchaseAmount: i === 2 ? null : 10000 + i * 1800, shipping: i === 2 ? null : 2000, totalCost: i === 2 ? null : 12000 + i * 1800, sellingDays: i === 2 ? null : 15 + i * 12, quantity: i === 2 ? null : i % 4, saleStartDate: null, alreadyWholesale: i === 4 })) };
let calls: WholesaleSaveRequest[] = [];
(window as any).wholesaleFixtureCalls = calls;
async function load() { if (mode === "load-error") throw Error("fixture read failure"); return sample; }
async function save(request: WholesaleSaveRequest) {
  calls.push(structuredClone(request));
  if (mode === "network" && calls.length === 1) throw Error("lost response");
  return { results: request.items.map((item, index) => ({ id: item.id, status: mode === "partial" && index === 1 ? "failed" as const : mode === "unknown" && calls.length === 1 ? "unknown" as const : "saved" as const, message: mode === "partial" && index === 1 ? "在庫が更新されています。再読込してください。" : undefined })) };
}
createRoot(document.getElementById("root")!).render(<main className="min-h-screen bg-slate-50 p-4 md:p-6"><div className="mb-4 rounded-lg bg-amber-100 p-3 text-center text-sm">BELLO 業販一覧 · ローカル検証専用（架空データ）</div><WholesaleTable initialData={mode === "load-error" ? null : sample} loadData={load} saveData={save}/></main>);
