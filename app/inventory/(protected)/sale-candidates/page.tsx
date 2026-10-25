import {getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {SaleCandidates} from '@/components/sales/SaleCandidates';
export const dynamic='force-dynamic';
export const metadata={title:'売却管理 | BELLO'};
export default async function Page(){if(await getInventoryRole()!=='ADMIN')return <div role="alert" className="p-8">管理者のみ利用できます。</div>;return <main className="flex-1 overflow-y-auto"><SaleCandidates/></main>;}
