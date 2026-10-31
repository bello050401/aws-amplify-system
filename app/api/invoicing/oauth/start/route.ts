import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {adminCredential,invokeIssuer,sameOrigin,NO_STORE} from '@/lib/invoicing/gateway';
export async function POST(request:Request){try{
 if(!sameOrigin(request))throw new Error();const token=await adminCredential();if(!token)throw new Error();
 const result=await invokeIssuer(token,'oauth-start');if(!result.ok)return NextResponse.json(result,{status:409,headers:NO_STORE});
 (await cookies()).set('__Host-bello-mf-state',result.state,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:600});
 return NextResponse.json({ok:true,url:result.url},{headers:NO_STORE});
 }catch{return NextResponse.json({ok:false,message:'連携認証を開始できませんでした。'},{status:403,headers:NO_STORE});}}
