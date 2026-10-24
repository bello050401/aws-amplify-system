import {NextResponse} from 'next/server';
import {getPhotoRegistrationWebAdapter,getWebTrustedClaims} from '@/lib/photoRegistration/webAdapter';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const claims=await getWebTrustedClaims();
 if(!claims)return NextResponse.json({error:'ログインしてください。'},{status:401});
 const adapter=getPhotoRegistrationWebAdapter();
 if(!adapter)return NextResponse.json({error:'画像の保存先を確認できません。'},{status:503});
 const id=new URL(request.url).searchParams.get('id');
 if(!id||id.length>180)return NextResponse.json({error:'画像が指定されていません。'},{status:400});
 const result=await adapter.downloadAsset(id,claims,new URL(request.url).searchParams.get("variant")??"processed");
 if(!result.ok)return NextResponse.json({error:result.message},{status:result.error==='PERMISSION_DENIED'?403:404,headers:{'cache-control':'no-store'}});
 return NextResponse.redirect(result.value,{status:302,headers:{'cache-control':'no-store'}});
}
