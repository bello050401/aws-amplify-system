import Link from 'next/link';
import {temporaryOriginalWeb} from '@/lib/photoRegistration/temporaryOriginalWeb';
export const dynamic='force-dynamic';
export default async function Page(){
 const service=await temporaryOriginalWeb();
 if(!service)return <p>ログインと権限を確認してください。</p>;
 const rows=(await service.list()).filter(x=>!x.purgedAt&&Date.parse(x.expiresAt)>Date.now());
 return <main className="p-5"><Link href="/inventory/photo-registration" className="text-blue-700">画像登録へ戻る</Link>
 <h1 className="my-4 text-xl font-bold">編集前の取込写真（7日間）</h1>
 <p className="mb-4 text-sm">撮影機から取り込んだ原本です。加工後の保存が完了した写真は、各画像と商品詳細の「編集前の写真」から確認できます。期限終了後は自動削除されます。直近200枚を表示します。</p>
 {!rows.length?<p>保管中の取込写真はありません。</p>:<ul className="space-y-3">{rows.map(row=><li key={row.id} className="rounded border p-3"><p className="font-medium">{row.fileName}</p>
 <p className="text-sm">取込：{new Date(row.importedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} ／ 保管期限：{new Date(row.expiresAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}</p>
 {row.uploadedAt?<a className="mt-2 inline-block rounded border px-3 py-2 text-blue-700" href={'/api/inventory/photo-original-download?id='+row.id}>編集前写真をダウンロード</a>:<p className="text-amber-700">アップロード未完了。撮影機で再実行してください。</p>}</li>)}</ul>}
 </main>;
}
