import {NextResponse} from 'next/server';
import {getMobileSession} from '@/lib/mobile/session';
import {registerSoldOut} from '@/app/actions/soldOut';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params:Promise<{id:string}>}) {
  const params = await context.params;

  const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
  const fail=(error:string,status:number)=>NextResponse.json({error},{status,headers});
  const session=await getMobileSession();
  if(!session.ok)return fail(session.error,session.status);
  if(session.role!=='ADMIN'||process.env.BELLO_MOBILE_WRITES_ENABLED!=='true')return fail('売却は管理者のみ実行できます。',403);
  if(!session.features.sales||!session.features.ecListing)return fail('販売情報を編集する権限がありません。',403);
  const origin=request.headers.get('origin');
  if(request.headers.get('x-bello-mobile')!=='1'||request.headers.get('sec-fetch-site')==='cross-site'||(origin&&origin!==(process.env.BELLO_MOBILE_PUBLIC_ORIGIN||new URL(request.url).origin)))return fail('許可されていない操作です。',403);
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return fail('入力内容を確認してください。',415);
  let body;
  try {
    const reader=request.body?.getReader();if(!reader)return fail('入力内容を確認してください。',400);
    const chunks:Uint8Array[]=[];let size=0;
    try {while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>16384){await reader.cancel();return fail('入力内容が長すぎます。',413);}chunks.push(next.value);}}finally{reader.releaseLock();}
    body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{return fail('入力内容を確認してください。',400);}
  if(body?.inventoryId!==params.id)return fail('商品を確認してください。',422);
  const outcome=await registerSoldOut(body);
  return NextResponse.json({...outcome,owner:session.owner,mutationId:body.mutationId},{status:outcome.ok?200:outcome.code==='FORBIDDEN'?403:outcome.code==='CONFLICT'?409:outcome.code==='INVALID'?422:503,headers});
}
