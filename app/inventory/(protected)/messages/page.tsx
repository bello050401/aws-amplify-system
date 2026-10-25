import {getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {InventoryHeader} from '../../InventoryHeader';
export const metadata={title:'メッセージ | BELLO 在庫管理'};
export default async function MessagesPage(){const role=await getInventoryRole();if(!role)return null;return <div className="flex h-full flex-col"><InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">メッセージ</h1>}/><div className="m-6 rounded-xl border bg-white p-6"><h2 className="font-semibold">メッセージ機能は停止中です</h2><p className="mt-2 text-sm text-gray-600">今後の運用に向けて表示を残しています。問い合わせ取得・返信作成・通知送信は行いません。売却管理の購入通知取得は継続します。</p></div></div>;}
