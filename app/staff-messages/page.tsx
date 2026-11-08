import {InquiryQueue} from '@/app/inventory/(protected)/messages/InquiryQueue';
import {getMobileSession} from '@/lib/mobile/session';
export const dynamic='force-dynamic';
export const metadata={title:'メッセージ | BELLO'};
export default async function StaffMessages(){
  const session=await getMobileSession();
  if(!session.ok||session.role==='VIEWER')return <p className="p-5">メッセージの利用権限を確認してください。</p>;
  // Same authorization and draft operations as PC. No second message store.
  return <main className="min-h-screen bg-[#F8F6F1] p-3 pb-8"><InquiryQueue isAdmin={false} compact/></main>;
}
