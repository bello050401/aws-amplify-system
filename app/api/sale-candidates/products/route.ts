import {NextResponse} from 'next/server';
import {inventoryMutationSession} from '@/lib/inventory/mutationSession';
import {listCategories,toListRow} from '@/lib/inventory/queries';
import {searchInventoryFast} from '@/lib/inventory/inventorySearchFast';
import {saleProductScope} from '@/lib/saleCandidates/search';
import {inventoryThumbnails} from '@/lib/mobile/inventoryThumbnails';
import {NO_STORE} from '@/lib/invoicing/gateway';
import {candidateStore} from '@/lib/saleCandidates/store';
import {exactListingInventoryIds} from '@/lib/saleCandidates/listingMatch';
import {getInventoryRaw} from '@/lib/inventory/categoryPersistence';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 try{
  if((await inventoryMutationSession())?.role!=='ADMIN')return NextResponse.json({error:'管理者のみ利用できます。'},{status:403,headers:NO_STORE});
  const url=new URL(request.url),q=(url.searchParams.get('q')||'').trim(),offset=Number(url.searchParams.get('offset')||0);
  if(q.length>2000||!Number.isSafeInteger(offset)||offset<0||offset>20000)return NextResponse.json({items:[],total:0},{headers:NO_STORE});
  const masters=await listCategories(),scope=saleProductScope(masters);if(!scope.categoryIds.length)throw Error('CATEGORY_UNAVAILABLE');
  const soldIds=masters.filter(c=>c.name==='売り切れ').map(c=>c.id);
  const candidateId=url.searchParams.get('candidate');let exact:NonNullable<Awaited<ReturnType<typeof getInventoryRaw>>>[]=[],match='NAME';
  if(candidateId&&/^[a-f0-9]{64}$/.test(candidateId)&&url.searchParams.get('by')!=='name'){
   const c=await candidateStore().get(candidateId);
   if(c?.state==='PENDING'&&(c.channel==='BASE'||c.channel==='YAHOO')&&c.externalListingId){
    const ids=await exactListingInventoryIds(c.channel,c.externalListingId);exact=(await Promise.all(ids.map(getInventoryRaw))).filter((p):p is NonNullable<typeof p>=>{if(!p||p.isDeleted||p.deletedAt||p.listingPartition==='MERGED'||Number(p.quantity)<=0)return false;const row=toListRow(p as never);return !!scope.label(row)&&!row.categoryIds?.some(id=>soldIds.includes(id));});
    match=ids.length===1&&exact.length===1?'ID':ids.length>1?'AMBIGUOUS':'MISSING';
   }
  }
  const page=match==='ID'?{rawItems:exact,total:exact.length}:q?await searchInventoryFast({q,saleRelevance:true,saleExcludeCategoryIds:masters.filter(c=>c.name==='売り切れ').map(c=>c.id),categoryPriority:scope.priority,filters:{categoryIds:scope.categoryIds}},{offset,limit:20}):{rawItems:[],total:0};if(!page)throw Error('SEARCH_UNAVAILABLE');
  const rows=page.rawItems.map(p=>toListRow(p as never)).filter(p=>scope.label(p)&&p.quantity>0&&!p.categoryIds?.some(id=>soldIds.includes(id)));
  const photos=new Map((await inventoryThumbnails(rows)).map(p=>[p.id,p.thumbnailUrl]));
  return NextResponse.json({items:rows.map(p=>({id:p.id,name:p.name,quantity:p.quantity,sku:p.sku,displayId:p.displayId,updatedAt:p.updatedAt,market:p.market,price:p.salePrice??p.plannedSalePrice??null,category:scope.label(p),thumbnailUrl:photos.get(p.id)||null})),total:page.total,match},{headers:NO_STORE});
 }catch{return NextResponse.json({error:'商品検索を完了できませんでした。再度お試しください。'},{status:503,headers:NO_STORE});}
}
