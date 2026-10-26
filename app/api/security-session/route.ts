import {NextResponse} from 'next/server';
import {approvedServerSession} from '@/lib/security/serverSession';
import {deviceSecurityEnabled} from '@/lib/security/serverRuntime';
import {SECURITY_HEADERS} from '@/lib/security/http';
export const dynamic='force-dynamic';
export async function GET(){
 if(!deviceSecurityEnabled())return new Response(null,{status:404});
 const actor=await approvedServerSession();
 return NextResponse.json({ok:!!actor},{status:actor?200:401,headers:SECURITY_HEADERS});
}
