import {getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {InventoryHeader} from '../../../InventoryHeader';
import {DesktopSaleJobs} from '@/components/sales/DesktopSaleJobs';
export const dynamic='force-dynamic';
export const metadata={title:'PC商品照合 | BELLO'};
export default async function Page(){
 if(await getInventoryRole()!=='ADMIN')return <div role="alert" className="p-8">管理者のみ利用できます。</div>;
 return <div className="flex min-h-0 flex-1 flex-col"><InventoryHeader role="ADMIN" center={<span className="text-sm font-semibold">PC商品照合</span>}/><main className="min-h-0 flex-1 overflow-y-auto"><DesktopSaleJobs/></main></div>;
}
