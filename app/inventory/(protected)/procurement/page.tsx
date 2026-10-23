import Link from 'next/link';
import {canEditInventory,getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import ProcurementPanel from './ProcurementPanel';
export const dynamic='force-dynamic';
export default async function ProcurementPage(){
  const role=await getInventoryRole();
  return <main className="mx-auto w-full max-w-6xl p-5"><Link href="/inventory" className="text-sm text-blue-700">← 在庫一覧へ</Link><h1 className="my-5 text-2xl font-bold">定期仕入れ</h1>{canEditInventory(role)?<ProcurementPanel/>:<p>この機能は在庫を編集できるスタッフが利用できます。</p>}</main>;
}
