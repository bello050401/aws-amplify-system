import {NextResponse} from 'next/server';
import {temporaryOriginalWeb} from '@/lib/photoRegistration/temporaryOriginalWeb';
import {photoDownloadResponse} from '@/lib/photoRegistration/downloadResponse';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const service=await temporaryOriginalWeb();
 if(!service)return new NextResponse('ログインと権限を確認してください。',{status:403,headers:{'Cache-Control':'no-store'}});
 const url=await service.download(new URL(request.url).searchParams.get('id')??'');
 return url?photoDownloadResponse(request,url):new NextResponse('写真が未保存、または保管期限が終了しています。',{status:404,headers:{'Cache-Control':'no-store'}});
}
