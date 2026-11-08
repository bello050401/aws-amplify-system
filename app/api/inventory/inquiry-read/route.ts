import {NextRequest,NextResponse} from 'next/server';
import {getInventoryRole,getCurrentInventoryUserSub} from '@/lib/amplify/requireInventoryUser';
import {claimInquiryRead,finishInquiryRead} from '@/lib/inquiry/runtime/readJobs';
import {bridgePostHeaderFailure} from '@/lib/listing/mercariBridge/postGuard';
export const dynamic='force-dynamic';
const reply=(body:Record<string,unknown>,status=200)=>NextResponse.json({...body,serverTime:Date.now()},{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
/** Dedicated read worker authenticates with BELLO's normal approved ADMIN session. */
export async function POST(request:NextRequest){
  const headerFailure=bridgePostHeaderFailure({origin:request.headers.get('origin'),requestOrigin:request.nextUrl.origin,configuredPublicOrigin:process.env.MERCARI_BRIDGE_PUBLIC_ORIGIN,contentType:request.headers.get('content-type'),hasNextAction:request.headers.has('next-action')});
  if(headerFailure)return reply({ok:false,code:headerFailure},403);
  if(request.headers.get('x-bello-inquiry-read')!=='1')return reply({ok:false,code:'READ_HEADER_REQUIRED'},403);
  try{
    if(await getInventoryRole()!=='ADMIN')return reply({ok:false,code:'BELLO_AUTH_REQUIRED'},403);
    const actor=await getCurrentInventoryUserSub();if(!actor)return reply({ok:false,code:'BELLO_AUTH_REQUIRED'},403);
    const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>300000))return reply({ok:false},413);
    const text=await request.text();if(Buffer.byteLength(text)>300000)return reply({ok:false},413);
    const input=JSON.parse(text);
    if(input.action==='CLAIM')return reply({ok:true,job:await claimInquiryRead(actor)});
    if(input.action==='COMPLETE'||input.action==='FAIL')return reply({ok:true,...await finishInquiryRead(actor,input.jobId,input.leaseId,input.snapshot,input.action==='FAIL'?input.reason:undefined)});
    return reply({ok:false},400);
  }catch(e){
    const code=e instanceof Error?e.message:'';
    return reply({ok:false,code:['READ_LEASE_EXPIRED','READ_OWNER_REQUIRED','READ_IDENTITY_MISMATCH','STALE_READ_RESULT','INCOMPLETE_READ_RESULT','INVALID_READ_MESSAGE','READ_HISTORY_TOO_LARGE'].includes(code)?code:'READ_NOT_ACCEPTED'},409);
  }
}
