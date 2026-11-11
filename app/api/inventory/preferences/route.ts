import {NextResponse} from 'next/server';
import {createPreferenceStore} from '@/lib/inventory/preferenceStore';
import {inventoryVerifiedReadSession} from '@/lib/inventory/mutationSession';
import {inventoryDdb} from '@/lib/inventory/categoryPersistence';
import {inventoryEditConfig} from '@/lib/inventory/editJobs';
import {isOutboundRequestOriginAllowed} from '@/lib/outbound/requestOrigin';
const headers={'Cache-Control':'no-store'};
export async function GET(){
 const s=await inventoryVerifiedReadSession();if(!s)return NextResponse.json({error:'ログインが必要です。'},{status:401,headers});
 try{const sections=await createPreferenceStore(inventoryDdb,inventoryEditConfig().table).get(s.owner);return NextResponse.json({owner:s.owner,sections},{headers});}
 catch{return NextResponse.json({error:'端末間の設定を読み込めません。'},{status:503,headers});}
}
export async function PATCH(request:Request){
 const s=await inventoryVerifiedReadSession();if(!s)return NextResponse.json({error:'ログインが必要です。'},{status:401,headers});
 if(!isOutboundRequestOriginAllowed(request))return NextResponse.json({error:'不正な送信元です。'},{status:403,headers});
 try{const raw=await request.text();if(raw.length>200000)throw Error('設定の容量が大きすぎます。');
  const {section,revision,value}=JSON.parse(raw);const result=await createPreferenceStore(inventoryDdb,inventoryEditConfig().table).save(s.owner,section,revision,value);
  return NextResponse.json(result,{headers});
 }catch(error){const conflict=(error as Error).name==='ConditionalCheckFailedException';return NextResponse.json({error:conflict?'別端末で設定が更新されました。再読み込みしてから変更してください。':'設定を保存できません。再読み込みして確認してください。'},{status:conflict?409:400,headers});}
}
