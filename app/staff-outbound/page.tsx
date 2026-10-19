import {OutboundScreen} from '@/app/inventory/(protected)/outbound/OutboundScreen';
import {getMobileSession} from '@/lib/mobile/session';
export const dynamic='force-dynamic';
export const metadata={title:'出庫 | BELLO'};
export default async function StaffOutbound(){const session=await getMobileSession();return session.ok?<OutboundScreen embedded/>:<p className="p-5">ログインを確認してください。</p>;}
