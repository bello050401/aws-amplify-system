import {NextResponse} from 'next/server';
import {adminCredential,NO_STORE} from '@/lib/invoicing/gateway';
import {listInventorySimpleSearch} from '@/lib/inventory/queries';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 try{if(!await adminCredential())return NextResponse.json({error:'管理者のみ利用できます。'},{status:403,headers:NO_STORE});
 const q=new URL(request.url).searchParams.get('q')?.trim()||'';if(q.length<1||q.length>150)return NextResponse.json({items:[]},{headers:NO_STORE});
 const page=await listInventorySimpleSearch({q},{offset:0,limit:20});
 return NextResponse.json({items:page.items.map(p=>({id:p.id,name:p.name,sku:p.sku,displayId:p.displayId,price:p.salePrice??p.plannedSalePrice??null})),total:page.total},{headers:NO_STORE});
 }catch{return NextResponse.json({error:'商品を取得できませんでした。'},{status:503,headers:NO_STORE});}
}
