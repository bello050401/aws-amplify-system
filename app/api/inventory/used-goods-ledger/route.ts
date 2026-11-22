import { reportFeatureError, observeFeatureOperation } from '@/lib/systemErrors/feature';
import { inspectLedgerHealth } from '@/lib/systemErrors/health';
import { reportFeatureChecks } from '@/lib/systemErrors/healthReporting';
import {NextResponse} from 'next/server';
import {getMobileSession} from '@/lib/mobile/session';
import {ledgerYear} from '@/lib/inventory/usedGoodsLedger';
import {loadUsedGoodsLedger} from '@/lib/inventory/usedGoodsLedgerSource';
import {usedGoodsLedgerWorkbook} from '@/lib/inventory/usedGoodsLedgerWorkbook';
export const dynamic='force-dynamic';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store, max-age=0',Pragma:'no-cache',Vary:'Cookie','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request) {
  const session=await getMobileSession();
  if(!session.ok)return NextResponse.json({error:'ログイン状態を確認してください。'},{status:session.status,headers});
  if(session.role!=='ADMIN')return NextResponse.json({error:'古物台帳は管理者のみ利用できます。'},{status:403,headers});
  const query=new URL(request.url).searchParams;
  let year:number;try{year=ledgerYear(query.get('year'));}catch{return NextResponse.json({error:'出力する年を1900〜2100年で指定してください。'},{status:400,headers});}
  try{
    const ledger=await observeFeatureOperation('antique-ledger', 'export', () => loadUsedGoodsLedger(year), {reportFailure: false});
    await reportFeatureChecks('antique-ledger', 'export', inspectLedgerHealth(ledger));
    if(query.get('format')==='xlsx'){
      const bytes=await usedGoodsLedgerWorkbook(ledger);
      const filename=`BELLO_古物台帳_${year}年.xlsx`;
      return new Response(new Uint8Array(bytes),{headers:{...headers,'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="BELLO_ledger_${year}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`}});
    }
    return NextResponse.json(ledger,{headers});
  }catch(error){
    await reportFeatureError(error, 'antique-ledger', 'export');
    // Do not include row data, counterparty details or SDK payloads in logs/responses.
    return NextResponse.json({error:'台帳の取得に失敗しました。時間をおいて再実行してください。'},{status:503,headers});
  }
}
