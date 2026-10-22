import {NextResponse} from 'next/server';
import {getMobileSession} from '@/lib/mobile/session';
import {deleteInventoryPhotoAssetAction} from '@/app/actions/photoRegistration';
export const dynamic='force-dynamic';
export async function DELETE(request:Request,{params}:{params:{id:string;photoId:string}}){
 const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
 const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers});
 const session=await getMobileSession();if(!session.ok)return reply({error:session.error},session.status);
 const origin=request.headers.get('origin');
 if(session.role==='VIEWER'||process.env.BELLO_MOBILE_WRITES_ENABLED!=='true'||request.headers.get('x-bello-mobile')!=='1'||request.headers.get('sec-fetch-site')==='cross-site'||(origin&&origin!==(process.env.BELLO_MOBILE_PUBLIC_ORIGIN||new URL(request.url).origin)))return reply({error:'FORBIDDEN'},403);
 if(!/^[a-f0-9-]{36}$/i.test(params.id)||!/^photo-[a-f0-9-]{36}$/i.test(params.photoId))return reply({error:'INVALID_INPUT'},422);
 try{const result=await deleteInventoryPhotoAssetAction(params.id,params.photoId.slice(6));
 if(!result.ok)return reply({error:result.code,message:result.message},result.code==='ASSET_IN_USE'?409:422);
 return reply({owner:session.owner,deletedId:params.photoId});
 }catch{return reply({error:'UNCONFIRMED',message:'削除結果を確認できません。商品詳細を開き直してください。'},503);}
}
