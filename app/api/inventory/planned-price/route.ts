import {NextResponse} from 'next/server';
import {revalidatePath} from 'next/cache';
import {getMobileSession} from '@/lib/mobile/session';
import {isOutboundRequestOriginAllowed} from '@/lib/outbound/requestOrigin';
import {listPriceEntry,updatePriceEntry} from '@/lib/inventory/plannedPriceService';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
export async function GET(){
 const session=await getMobileSession();if(!session.ok)return NextResponse.json({error:session.error},{status:session.status,headers});
 if(!['ADMIN','EDITOR'].includes(session.role))return NextResponse.json({error:'編集する権限がありません。'},{status:403,headers});
 try{return NextResponse.json({items:await listPriceEntry()},{headers});}catch{return NextResponse.json({error:'一覧を取得できませんでした。通信を確認して再度読み込んでください。'},{status:503,headers});}
}
export async function POST(request:Request){
 const session=await getMobileSession();if(!session.ok)return NextResponse.json({error:session.error},{status:session.status,headers});
 if(!['ADMIN','EDITOR'].includes(session.role)||!isOutboundRequestOriginAllowed(request))return NextResponse.json({error:'編集する権限または送信元を確認してください。'},{status:403,headers});
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return NextResponse.json({error:'保存形式を確認してください。'},{status:415,headers});
 try{const reader=request.body?.getReader();if(!reader)throw Error('保存内容を確認してください。');let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>131072){await reader.cancel();throw Error('入力内容が長すぎます。');}chunks.push(next.value);}}finally{reader.releaseLock();}
  const item=await updatePriceEntry(JSON.parse(Buffer.concat(chunks).toString('utf8')),session.owner);revalidatePath('/inventory');revalidatePath('/inventory/'+item.id);return NextResponse.json({item},{headers});
 }catch(error){const code=(error as {code?:string})?.code??'UNCONFIRMED';return NextResponse.json({error:code==='UNCONFIRMED'?'保存結果を確認できません。入力内容を保持したまま再確認してください。':error instanceof Error?error.message:'保存できませんでした。',code},{status:code==='UNCONFIRMED'?503:code==='INVALID_INPUT'?422:409,headers});}
}
