import {getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {InventoryHeader} from '../../InventoryHeader';
import {InquiryQueue} from './InquiryQueue';
import {Suspense} from 'react';
import {AIBudgetSummary} from './AIBudgetSummary';
export const metadata={title:'メッセージ | BELLO 在庫管理'};
export default async function MessagesPage(){const role=await getInventoryRole();if(!role)return null;return <div className="flex min-h-full flex-col"><InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">メッセージ</h1>}/>{role==='ADMIN'&&<Suspense fallback={<p className="px-6 py-2 text-sm text-gray-500">AI利用枠を確認中…</p>}><AIBudgetSummary/></Suspense>}<main className="p-3 sm:p-6">{role==='ADMIN'||role==='EDITOR'?<InquiryQueue isAdmin={role==='ADMIN'}/>:<p>問い合わせを確認する権限がありません。</p>}</main></div>;}
