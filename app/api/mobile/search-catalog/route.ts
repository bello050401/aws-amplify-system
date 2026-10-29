import {NextResponse} from 'next/server';
import {getMobileSession} from '@/lib/mobile/session';
import {listCategories,listLocations,listStatuses} from '@/lib/inventory/queries';
import {readSearchCatalog,cachedSearchCatalog} from '@/lib/mobile/searchCatalog';
import {buildCatalogDelta} from '@/lib/mobile/catalogDelta';
import {validCatalogHashes} from '@/mobile/src/domain/catalogProtocol';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
export async function GET(){
 const session=await getMobileSession();
 if(!session.ok)return NextResponse.json({error:session.error},{status:session.status,headers});
 try{
  const [categories,locations,statuses]=await Promise.all([listCategories(),listLocations(),listStatuses()]);
  const items=await readSearchCatalog({categories,locations,statuses});
  return NextResponse.json({owner:session.owner,items,fetchedAt:new Date().toISOString()},{headers});
 }catch{return NextResponse.json({error:'CATALOG_UNAVAILABLE'},{status:503,headers});}
}

/** Read-only synchronization. POST keeps the bounded manifest out of URL/access logs. */
export async function POST(request:Request){
 const session=await getMobileSession();
 if(!session.ok)return NextResponse.json({error:session.error},{status:session.status,headers});
 let input:{hashes?:string[];fresh?:boolean};
 try{
  if(Number(request.headers.get('content-length')??0)>6000)throw Error();
  const raw=await request.text();if(raw.length>6000)throw Error();input=JSON.parse(raw);
  if(!input||typeof input!=='object'||(input.hashes!==undefined&&!validCatalogHashes(input.hashes))||(input.fresh!==undefined&&typeof input.fresh!=='boolean'))throw Error();
 }catch{return NextResponse.json({error:'INVALID_CATALOG_QUERY'},{status:400,headers});}
 try{
  const [categories,locations,statuses]=await Promise.all([listCategories(),listLocations(),listStatuses()]);
  const {items,checkedAt}=await cachedSearchCatalog({categories,locations,statuses},input.fresh===true);
  return NextResponse.json({owner:session.owner,...buildCatalogDelta(items,input.hashes,checkedAt)},{headers});
 }catch{return NextResponse.json({error:'CATALOG_UNAVAILABLE'},{status:503,headers});}
}
