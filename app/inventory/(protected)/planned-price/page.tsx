import {getMobileSession} from '@/lib/mobile/session';
import PriceEntryPage from './PriceEntryPage';
import {listPriceEntry} from '@/lib/inventory/plannedPriceService';
export const dynamic='force-dynamic';
export default async function Page(){
 const session=await getMobileSession();
 if(!session.ok||!['ADMIN','EDITOR'].includes(session.role))return <p>編集する権限がありません。</p>;
 // Send the first editable list with the page. Previously hydration started a
 // second authorized HTTP request before any products could be displayed.
 try{return <PriceEntryPage initialItems={await listPriceEntry()}/>;}
 catch{return <PriceEntryPage/>;} // Existing visible retry/error flow remains available.
}
