import Link from 'next/link';
import {temporaryOriginalWeb} from '@/lib/photoRegistration/temporaryOriginalWeb';
import OriginalCards from './OriginalCards';
export const dynamic='force-dynamic';
export default async function Page(){
 const service=await temporaryOriginalWeb();if(!service)return <p>ログインと権限を確認してください。</p>;
 const rows=await service.list();
 return <main className="mx-auto max-w-6xl p-4 md:p-7"><Link href="/inventory/photo-registration" className="inline-flex min-h-10 items-center text-sm font-medium text-blue-700">← 画像登録</Link>
 <header className="my-4"><p className="text-xs font-semibold tracking-wide text-indigo-700">PHOTO STATION</p><h1 className="mt-1 text-2xl font-bold text-slate-900">編集前の取込写真</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">取り込んだ原本を、クラウドへの保存から7日間保管します。加工が完了した写真もここから確認できます。保管期限を過ぎると原本だけが自動削除され、編集後の写真は残ります。</p></header>
 <div className="mb-5 rounded-lg border border-indigo-100 bg-indigo-50 p-3 text-xs leading-5 text-indigo-900">直近200枚を表示します。期限になった原本は閲覧を停止し、毎日の自動整理でクラウド上の過去の版も削除します。</div>
 <OriginalCards rows={rows.map(({id,fileName,importedAt,uploadedAt,expiresAt,available,removed,autoDeleted,assetRef,purgedAt})=>({id,fileName,importedAt,uploadedAt,expiresAt,available,removed,autoDeleted,assetRef:assetRef?{batchId:assetRef.batchId}:undefined,purgedAt}))}/>
 </main>;
}
