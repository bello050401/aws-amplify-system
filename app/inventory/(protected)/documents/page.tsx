import {getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {DocumentForm} from '@/components/invoicing/DocumentForm';
export const dynamic='force-dynamic';
export const metadata={title:'請求書・領収書発行 | BELLO'};
export default async function DocumentsPage(){if(await getInventoryRole()!=='ADMIN')return <div role="alert" className="p-8">管理者のみ利用できます。</div>;return <main className="flex-1 overflow-y-auto"><DocumentForm/></main>;}
