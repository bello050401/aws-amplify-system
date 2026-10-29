import {NextResponse} from 'next/server';
import {getMobileSession} from '@/lib/mobile/session';
import {listCategories,listLocations,listStatuses} from '@/lib/inventory/queries';
import {readSearchCatalog} from '@/lib/mobile/searchCatalog';
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
