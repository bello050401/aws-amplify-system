import {NextResponse} from 'next/server';
import {requireMobileFeature} from '@/lib/mobile/session';
import {loadWholesale,saveWholesale,validWholesaleRequest} from '@/lib/listing/wholesaleServer';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
const writesEnabled=()=>process.env.BELLO_MOBILE_WRITES_ENABLED==='true';
export async function GET(){
 const session=await requireMobileFeature('ecListing');
 if(!session.ok)return NextResponse.json({error:session.error},{status:session.status,headers});
 try{const data=await loadWholesale(session.role);return NextResponse.json({...data,canEdit:data.canEdit&&writesEnabled()},{headers});}
 catch{return NextResponse.json({error:'業販一覧を取得できませんでした。再読み込みしてください。'},{status:503,headers});}
}
export async function POST(request:Request){
 const session=await requireMobileFeature('ecListing');
 if(!session.ok)return NextResponse.json({error:session.error},{status:session.status,headers});
 const origin=request.headers.get('origin'),expectedOrigin=process.env.BELLO_MOBILE_PUBLIC_ORIGIN||new URL(request.url).origin;
 if(session.role==='VIEWER'||!writesEnabled()||request.headers.get('x-bello-mobile')!=='1'||request.headers.get('sec-fetch-site')==='cross-site'||origin&&origin!==expectedOrigin)
  return NextResponse.json({error:'変更する権限がありません。'},{status:403,headers});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return NextResponse.json({error:'入力内容を確認してください。'},{status:422,headers});
 let body:unknown;
 try{
  if(!request.body)throw Error();const reader=request.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>30000){await reader.cancel();throw Error();}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 }catch{return NextResponse.json({error:'入力内容を確認してください。'},{status:422,headers});}
 if(!validWholesaleRequest(body))return NextResponse.json({error:'一度に100件まで選択してください。'},{status:422,headers});
 try{return NextResponse.json(await saveWholesale(session.role,session.owner,body),{headers});}
 catch(error){return NextResponse.json({error:error instanceof Error?error.message:'保存できませんでした。'},{status:503,headers});}
}
