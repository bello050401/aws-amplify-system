import {NextResponse} from 'next/server';
export async function GET(_request:Request,{params}:{params:Promise<{token:string}>}){
 const {token}=await params;
 if(token==='expired')return NextResponse.json({ok:false,error:'unavailable'},{status:404});
 if(token==='error')return NextResponse.json({ok:false,error:'unavailable'},{status:503});
 const stages=['repair','photo','listing'] as const,labels=['補修待ち','撮影待ち','出品待ち'] as const;
 const names=['ヴィンテージ オーク材 ダイニングチェア 張り地はグレージュ・アーム付きのゆったりとした一脚（商品名が長い場合も全文を表示）','ウォールナット サイドボード','ソファ 2シーター','ラウンドテーブル','写真準備中のラウンジチェア','サイドテーブル'];
 const items=token==='empty'?[]:names.map((name,i)=>({id:String(i),name,managementNumber:`QA-BELLO-${100+i}`,quantity:i+1,dimensions:{width:i===4?null:'80',depth:'50',height:'75'},stage:stages[i%3],stageLabel:labels[i%3],imageUrl:i===4?null:'/fixture-furniture.svg',images:i===4?[]:['/fixture-furniture.svg','/fixture-detail.svg']}));
 return NextResponse.json({ok:true,title:'BELLO 商品カタログ',updatedAt:'2026-11-20T14:30:00Z',checkedAt:new Date().toISOString(),expiresAt:'2027-02-18T14:30:00Z',items},{headers:{'Cache-Control':'no-store'}});
}
