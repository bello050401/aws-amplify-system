import {NextResponse} from 'next/server';
import {adminCredential,NO_STORE} from '@/lib/invoicing/gateway';
import {listCategories,listInventorySimpleSearch} from '@/lib/inventory/queries';
import {invoiceProductScope} from '@/lib/invoicing/productSearch';
import {inventoryThumbnails} from '@/lib/mobile/inventoryThumbnails';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 try{if(!await adminCredential())return NextResponse.json({error:'管理者のみ利用できます。'},{status:403,headers:NO_STORE});
 const q=new URL(request.url).searchParams.get('q')?.trim()||'';if(q.length<1||q.length>150)return NextResponse.json({items:[]},{headers:NO_STORE});
 const scope=invoiceProductScope(await listCategories());
 // An empty category filter means all inventory to the shared search, so fail closed here.
 if(!scope.categoryIds.length)return NextResponse.json({items:[],total:0},{headers:NO_STORE});
 const page=await listInventorySimpleSearch({q,categoryIds:scope.categoryIds},{offset:0,limit:20,categoryPriority:scope.priority});
 // Recheck the hydrated record in case its category changed during the search.
 const rows=page.items.filter(p=>scope.label(p)!==null);
 const images=await inventoryThumbnails(rows);
 const urls=new Map(images.map(image=>[image.id,image.thumbnailUrl]));
 return NextResponse.json({items:rows.map(p=>({id:p.id,name:p.name,sku:p.sku,displayId:p.displayId,price:p.salePrice??p.plannedSalePrice??null,category:scope.label(p),thumbnailUrl:urls.get(p.id)??null})),total:page.total},{headers:NO_STORE});
 }catch{return NextResponse.json({error:'商品を取得できませんでした。'},{status:503,headers:NO_STORE});}
}
