import {NextResponse} from 'next/server';
import {adminCredential,invokeIssuer,sameOrigin,bodyLimited,NO_STORE} from '@/lib/invoicing/gateway';
import {validateInvoice,UNKNOWN_RESULT} from '@/lib/invoicing/model';
export const dynamic='force-dynamic';export const maxDuration=90;
export async function POST(request:Request,{params}:{params:{action:string}}){
 const reply=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:NO_STORE});
 try{
  if(!sameOrigin(request))return reply({ok:false,message:'許可されていない操作です。'},403);
  const token=await adminCredential();if(!token)return reply({ok:false,message:'管理者のみ利用できます。'},403);
  if(!['status','prepare','issue','pdf'].includes(params.action))return reply({ok:false,message:'許可されていない操作です。'},403);
  const body=await bodyLimited(request);
  const input=params.action==='issue'?validateInvoice(body.input):undefined;
  const result=await invokeIssuer(token,params.action,{...(input?{input}:{}),...(typeof body.ticket==='string'?{ticket:body.ticket}:{})});
  if(params.action==='pdf'&&result.ok&&typeof result.pdf==='string')return new Response(Buffer.from(result.pdf,'base64'),{headers:{...NO_STORE,'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="BELLO-invoice.pdf"'}});
  return reply(result,result.ok?200:result.code==='FORBIDDEN'?403:409);
 }catch{return reply({ok:false,code:params.action==='issue'?'UNKNOWN':'UNAVAILABLE',message:params.action==='issue'?UNKNOWN_RESULT:'処理を完了できませんでした。再度確認してください。'},503);}
}
