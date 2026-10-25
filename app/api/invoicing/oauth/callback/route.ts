import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {adminCredential,invokeIssuer,NO_STORE} from '@/lib/invoicing/gateway';
export async function GET(request:Request){let connected=false;
 try{const u=new URL(request.url);const state=u.searchParams.get('state');const saved=(await cookies()).get('__Host-bello-mf-state')?.value;(await cookies()).delete('__Host-bello-mf-state');
 if(!state||state!==saved)throw new Error();const token=await adminCredential();if(!token)throw new Error();const result=await invokeIssuer(token,'oauth-finish',{ticket:state,code:u.searchParams.get('code')});connected=result.ok===true;
 }catch{}
 return NextResponse.redirect(new URL('/inventory/documents?connection='+(connected?'connected':'failed'),process.env.BELLO_MOBILE_PUBLIC_ORIGIN||request.url),{status:303,headers:NO_STORE});
}
