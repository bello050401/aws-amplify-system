import {NextResponse} from 'next/server';
import {getMobileSession} from '@/lib/mobile/session';
import {outboundDestinations,outboundHistory,outboundProducts,getOutboundBatch,prepareOutbound,confirmOutboundSent,cancelUnsentOutbound,outboundMovementOptions,emailOutbound,acknowledgeOutboundReceipt} from '@/lib/outbound/service';
import {KAWAGOE_TEMPLATE,kawagoeAttachments} from '@/lib/outbound/kawagoe';
import {outboundCsv} from '@/lib/outbound/types';
import {isOutboundRequestOriginAllowed} from '@/lib/outbound/requestOrigin';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
export async function GET(request:Request){
  const session=await getMobileSession();if(!session.ok)return NextResponse.json({error:session.error},{status:session.status,headers});
  try{
    const query=new URL(request.url).searchParams,id=query.get('batch');
    if(query.get('movement')==='1')return NextResponse.json({movements:await outboundMovementOptions()},{headers});
    if(id){const batch=await getOutboundBatch(id);
      if(query.get('download')==='1'){
        if(['PREPARING','CANCELLING','CANCELLED'].includes(batch.status))throw new Error('このデータはダウンロードできません。');
        if(batch.templateType===KAWAGOE_TEMPLATE){const file=kawagoeAttachments(batch).find(f=>f.kind===query.get('kind'));if(!file)throw Error('ダウンロードするCSVを選択してください。');return new Response(new Uint8Array(file.data),{headers:{...headers,'Content-Type':'text/csv; charset=Shift_JIS','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`}});}
        return new Response(outboundCsv(batch.rows.filter(row=>row.status==='PENDING'||row.status==='SENT').map(row=>row.snapshot),batch.template),{headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(batch.fileName)}`}});
      }return NextResponse.json({batch},{headers});
    }
    const destination=query.get('destination');
    if(destination)return NextResponse.json({items:await outboundProducts(destination)},{headers});
    const [destinations,history]=await Promise.all([outboundDestinations(),outboundHistory()]);
    return NextResponse.json({destinations,history,canConfigure:session.role==='ADMIN',canEdit:session.role==='ADMIN'||session.role==='EDITOR'},{headers});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'読み込めませんでした。'},{status:409,headers});}
}
export async function POST(request:Request){
  const session=await getMobileSession();if(!session.ok)return NextResponse.json({error:session.error},{status:session.status,headers});
  if(!['ADMIN','EDITOR'].includes(session.role))return NextResponse.json({error:'出庫する権限がありません。'},{status:403,headers});
  if(!isOutboundRequestOriginAllowed(request))return NextResponse.json({error:'不正な送信元です。'},{status:403,headers});
  try{const input=await request.json();if(input.confirmed!==true)throw new Error('最終確認が必要です。');
    let batch=input.action==='prepare'?await prepareOutbound(input.id,input.destinationId,input.items,session.owner,input.arrivalDate):input.action==='send'?await emailOutbound(input.id,session.owner):input.action==='received'?await acknowledgeOutboundReceipt(input.id,session.owner):input.action==='sent'?await confirmOutboundSent(input.id,session.owner):input.action==='cancel'?await cancelUnsentOutbound(input.id):null;
    if(input.action==='prepare'&&batch?.sender==='EMAIL'&&batch.rows.some(r=>r.status==='PENDING'))batch=await emailOutbound(batch.id,session.owner);
    if(!batch)throw new Error('操作を確認してください。');return NextResponse.json({batch},{headers});
  }catch(error){console.error('[outbound]',error);return NextResponse.json({error:error instanceof Error?error.message:'処理結果を確認できません。履歴を確認してください。'},{status:409,headers});}
}
