import Link from 'next/link';
import { getInventoryRole } from '@/lib/amplify/requireInventoryUser';
import { InventoryHeader } from '../../InventoryHeader';
import { PartnerCatalogManagement } from './PartnerCatalogManagement';

export const metadata = { title: '取引先への商品共有 | BELLO 在庫管理' };

export default async function InventorySharePage() {
  const role = await getInventoryRole();
  if (!role) return null;
  return <><InventoryHeader role={role} center={<h1 className="text-lg font-bold">取引先への商品共有</h1>} /><main className="flex-1 overflow-y-auto p-5 md:p-8"><div className="mx-auto max-w-3xl"><Link href="/inventory" className="text-sm underline">← 在庫一覧へ</Link>{role === 'ADMIN' ? <PartnerCatalogManagement /> : <p className="mt-8" role="alert">共有リンクの管理にはADMIN権限が必要です。</p>}</div></main></>;
}
