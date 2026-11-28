import { Suspense } from "react";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { loadWholesaleAction, saveWholesaleAction } from "@/app/actions/wholesale";
import { InventoryHeader } from "../../../InventoryHeader";
import { WholesaleTable } from "../WholesaleTable";

export const metadata = { title: "業販一覧 | BELLO 在庫管理" };
async function WholesaleData() {
  const data = await loadWholesaleAction().catch(() => null);
  return <WholesaleTable initialData={data} loadData={loadWholesaleAction} saveData={saveWholesaleAction}/>;
}
export default async function WholesalePage() {
  const role = await getInventoryRole();
  if (!role) return null;
  return <div className="flex h-full flex-col"><InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">EC出品 · 業販</h1>}/><div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6"><Suspense fallback={<p role="status">業販一覧を読み込み中…</p>}><WholesaleData/></Suspense></div></div>;
}
