import {NextResponse} from 'next/server';
import {temporaryOriginalWeb} from '@/lib/photoRegistration/temporaryOriginalWeb';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const service=await temporaryOriginalWeb();
 if(!service)return new NextResponse('ログインと権限を確認してください。',{status:403});
 const url=await service.download(new URL(request.url).searchParams.get('id')??'');
 return url?NextResponse.redirect(url,{status:302,headers:{'Cache-Control':'no-store'}}):new NextResponse('写真が未保存、または保管期限が終了しています。',{status:404});
}
