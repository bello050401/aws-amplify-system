import {procurementProvider,STAFF_APP_HOME} from '@/lib/procurement/providers';
import Link from 'next/link';
import {canEditInventory,getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import ProcurementPanel from './ProcurementPanel';
export const dynamic='force-dynamic';
export default async function ProcurementPage({searchParams}:{searchParams:Promise<{provider?:string;from?:string}>}){
  const params=await searchParams;
  const fromStaff=params.from==='staff-app';
  const role=await getInventoryRole();
  return <main aria-label="定期仕入れ" tabIndex={0} className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain p-3 outline-none sm:p-5"><div className="mx-auto w-full max-w-screen-2xl"><Link href={fromStaff?STAFF_APP_HOME:"/inventory"} className="inline-flex min-h-11 items-center text-sm text-blue-700">{fromStaff?"← ホームに戻る":"← 在庫一覧へ"}</Link><h1 className="my-4 text-2xl font-bold">定期仕入れ</h1>{canEditInventory(role)?<ProcurementPanel key={procurementProvider(params.provider)} initialProvider={procurementProvider(params.provider)}/>:<p>この機能は在庫を編集できるスタッフが利用できます。</p>}</div></main>;
}
