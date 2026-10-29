import {getMobileSession} from '@/lib/mobile/session';
import PriceEntryPage from './PriceEntryPage';
export const dynamic='force-dynamic';
export default async function Page(){const session=await getMobileSession();if(!session.ok||!['ADMIN','EDITOR'].includes(session.role))return <p>編集する権限がありません。</p>;return <PriceEntryPage/>;}
