import {NextRequest} from 'next/server';
import {getInventoryRole} from '@/lib/amplify/requireInventoryUser';
import {extractionRepository} from '@/lib/procurement/extraction/server';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
 if(!await getInventoryRole())return new Response('Unauthorized',{status:401});
 const id=request.nextUrl.searchParams.get('inventoryId')||'',index=Number(request.nextUrl.searchParams.get('index'));
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!Number.isInteger(index)||index<0||index>11)return new Response('Invalid',{status:400});
 try{const repo=extractionRepository(),[job,row]=await Promise.all([repo.get(id),repo.inventory(id)]);if(!row||row.deletedAt)return new Response('Not found',{status:404});const source=job?.sources?.[index];if(!source)return new Response('Not found',{status:404});
 const bytes=await repo.object(source.key);const mime=['image/jpeg','image/png','application/pdf','application/json'].includes(source.mime)?source.mime:'application/octet-stream';
 return new Response(new Uint8Array(bytes),{headers:{'Content-Type':mime,'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':mime.startsWith('image/')?'inline':'attachment; filename="supplier-source.json"'}});
 }catch{return new Response('Source unavailable',{status:503,headers:{'Cache-Control':'no-store'}});}
}
