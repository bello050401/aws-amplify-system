import Link from 'next/link';
import {canEditInventory,getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import ProcurementPanel from './ProcurementPanel';
export const dynamic='force-dynamic';
export default async function ProcurementPage(){
  const role=await getInventoryRole();
  return <main aria-label="定期仕入れ" tabIndex={0} className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain p-3 outline-none sm:p-5"><div className="mx-auto w-full max-w-screen-2xl"><Link href="/inventory" className="text-sm text-blue-700">← 在庫一覧へ</Link><h1 className="my-4 text-2xl font-bold">定期仕入れ</h1>{canEditInventory(role)?<ProcurementPanel/>:<p>この機能は在庫を編集できるスタッフが利用できます。</p>}</div></main>;
}
