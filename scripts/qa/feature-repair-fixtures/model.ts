import { initialYahooAmounts, editYahooAmounts, yahooAmountError } from '../../../lib/procurement/yahooAmounts';
import { trefacLot, completeTrefacLot } from '../../../lib/procurement/trefac';
import { completeRestageDraft } from '../../../lib/procurement/restageDraft';
import { createQuickSearchMatcher } from '../../../lib/inventory/advancedSearch';
import { normalizeImageRecord, resolveTopImage, effectiveListThumbnailKey } from '../../../lib/inventory/imageTypes';
import { catalogCategories, publicCatalogItem } from '../../../lib/inventory/partnerCatalog/policy';
import { queryAnalysis } from '../../../lib/inventory/analysis/query';
import type { AnalysisBuild, Fact } from '../../../lib/inventory/analysis/types';
import { buildUsedGoodsLedger } from '../../../lib/inventory/usedGoodsLedger';
export const scopes = ['procurement-yahoo-local','procurement-trefac-local','procurement-restage-local','inventory-search-local','inventory-images-local','partner-sharing-local','sales-analysis-local','inventory-analysis-local','antique-ledger-local'] as const;
export type Scope = typeof scopes[number];
export interface FixtureOutput {title:string;inputLabel:string;inputValue:string;summary:string;columns:string[];rows:(string|number)[][];actual:Record<string,unknown>;image?:{label:string;color:string}}
const title:Record<Scope,string> = {'procurement-yahoo-local':'Yahoo仕入れ','procurement-trefac-local':'トレファク仕入れ','procurement-restage-local':'リステージ仕入れ','inventory-search-local':'在庫検索','inventory-images-local':'在庫画像','partner-sharing-local':'パートナー共有','sales-analysis-local':'売上分析','inventory-analysis-local':'在庫分析','antique-ledger-local':'古物台帳'};
function analysisBuild(quantity:number):AnalysisBuild {
 const unknown={amount:0,cost:0,quantity:0,category:0,kind:0,lot:0,channel:0,origin:0,date:0};
 const fact=(id:string,amount:number,quantity:number):Fact=>({id,inventoryId:id,title:id==='fixture-chair'?'サンプル椅子':'サンプル机',imageRef:null,sku:id,date:'2026-11-10',category:id==='fixture-chair'?'chair':'desk',kindId:id,holding:'single',holdingBand:'1',lot:'single',lotBand:'1',lotId:id,amount,quantity,kindCount:1,lotCount:1,unknown:{...unknown}});
 const facts=[fact('fixture-chair',5000*quantity,quantity),fact('fixture-desk',5000,1)];
 return {metadata:{version:1,generation:'2026-11-23T00:00:00.000Z',asOf:'2026-11-23T00:00:00.000Z',timezone:'Asia/Tokyo',scopeId:'synthetic-fixture',amountBasis:'synthetic fixed unit cost',metadataVersions:{},coverageStart:'2026-01-01',coverageEnd:'2026-11-23',accuracy:'captured-current-source',sourceRecordCount:2,unlocatedAcquisitionRecords:0},inventoryValue:{version:2,asOf:'2026-11-23T00:00:00.000Z',total:0,quantity:0,count:0,groups:[],other:[],issues:[],issueCount:0,excluded:[],unpricedCount:0},categories:[{id:'chair',label:'椅子'},{id:'desk',label:'机'}],inventory:facts,sales:facts,acquisitions:[],retailReference:[],referenceExclusions:{unknownChannel:0,unknownCost:0,unverifiedOrigin:0,excluded:0,salesAmount:0}};
}
export function baselineInput(scope:Scope):string{return scope==='inventory-search-local'?'椅子':scope==='inventory-images-local'?'A':'2';}
export function changedInput(scope:Scope):string{return scope==='inventory-search-local'?'机':scope==='inventory-images-local'?'B':scope==='partner-sharing-local'?'0':'4';}
export function computeFeatureFixture(scope:Scope,input=baselineInput(scope)):FixtureOutput {
 if(!scopes.includes(scope))throw Error('Unknown synthetic fixture');
 const quantity=Number(input),base={title:title[scope],inputLabel:scope==='inventory-search-local'?'検索語':scope==='inventory-images-local'?'メイン画像 A または B':'数量',inputValue:input};
 if(scope==='procurement-yahoo-local'){
  const amounts=editYahooAmounts(initialYahooAmounts({quantity:2,itemTotal:10000,shipping:1000}),'count',input);const error=yahooAmountError(amounts);if(error)throw Error(error);
  return {...base,summary:`仕入れ数量 ${amounts.count}点 / 送料込み単価 ${amounts.unitPrice}円`,columns:['商品金額','送料','数量','単価'],rows:[[Number(amounts.total),Number(amounts.postage),Number(amounts.count),Number(amounts.unitPrice)]],actual:{quantity:Number(amounts.count),unitPrice:Number(amounts.unitPrice),total:Number(amounts.total)+Number(amounts.postage)}};
 }
 if(scope==='procurement-trefac-local'){
  const lot=completeTrefacLot(trefacLot({status:'落札',available:true,count:1,dispnum:1,id:'fixture-document',label:'サンプル椅子セット',endprice:10000,number:1,saledate:'2026-11-10T00:00:00Z',images:[]},'synthetic-account'),quantity);
  return {...base,summary:`仕入れ数量 ${lot.quantity}点 / 仕入れ単価 ${lot.purchasePrice}円`,columns:['落札金額','点数','単価','購入合計'],rows:[[lot.hammerPrice,lot.quantity!,lot.purchasePrice!,lot.purchaseTotal]],actual:{quantity:lot.quantity,unitPrice:lot.purchasePrice,total:lot.purchaseTotal}};
 }
 if(scope==='procurement-restage-local'){
  const lot=completeRestageDraft({goodsId:'fixture-restage',date:'2026-11-10',name:'サンプル椅子',sourceQuantity:'2',quantity,unit:'脚',hammerPrice:10000,purchasePrice:null,isBundle:true,itemType:'椅子',imageUrl:'',lotNumber:'1',issues:[]});
  return {...base,summary:`仕入れ数量 ${lot.quantity}点 / 仕入れ単価 ${lot.purchasePrice}円`,columns:['落札金額','数量','単価'],rows:[[lot.hammerPrice,lot.quantity,lot.purchasePrice]],actual:{quantity:lot.quantity,unitPrice:lot.purchasePrice}};
 }
 if(scope==='inventory-search-local'){
  const records=[{id:'fixture-chair',name:'サンプル椅子',sku:'CHAIR',quantity:2,customFields:null},{id:'fixture-desk',name:'サンプル机',sku:'DESK',quantity:1,customFields:null}];const rows=records.filter(createQuickSearchMatcher(input));
  return {...base,summary:`検索結果 ${rows.length}件 / 在庫合計 ${rows.reduce((sum,row)=>sum+row.quantity,0)}点`,columns:['商品名','数量'],rows:rows.map(row=>[row.name,row.quantity]),actual:{names:rows.map(row=>row.name),quantity:rows.reduce((sum,row)=>sum+row.quantity,0)}};
 }
 if(scope==='inventory-images-local'){
  if(!['A','B'].includes(input))throw Error('A または B を指定してください。');
  const images=['A','B'].map((label,index)=>normalizeImageRecord({storageKey:`inventory/fixture-${label}.svg`,thumbnailKey:`inventory/fixture-${label}-thumb.svg`,sortOrder:index,type:'NORMAL',isPrimary:input===label}));const top=resolveTopImage(images)!;const label=top.storageKey.includes('fixture-A')?'A':'B';
  return {...base,summary:`メイン画像 ${label}`,columns:['画像','選択されたサムネイル'],rows:[[label,effectiveListThumbnailKey(top)]],actual:{selected:label,thumbnail:effectiveListThumbnailKey(top)},image:{label:`合成画像 ${label}`,color:label==='A'?'#447d68':'#a46c47'}};
 }
 if(scope==='partner-sharing-local'){
  const categories=catalogCategories([{id:'fixture-listing',name:'出品待ち'}]);const item=publicCatalogItem({id:'fixture-chair',name:'【作業注記】サンプル椅子',sku:'FIXTURE',quantity,categoryId:'fixture-listing',images:[]},categories,'fixture-token');
  return {...base,summary:`共有対象 ${item?1:0}件`,columns:['公開名','数量','工程'],rows:item?[[item.name,item.quantity,item.stageLabel]]:[],actual:{count:item?1:0,name:item?.name??null,quantity:item?.quantity??0}};
 }
 if(scope==='sales-analysis-local'||scope==='inventory-analysis-local'){
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>100)throw Error('数量は1〜100で指定してください。');
  const result=queryAnalysis(analysisBuild(quantity),{target:scope==='sales-analysis-local'?'sales':'inventory'});if(result.status!=='ok')throw Error('Synthetic aggregate failed');const totals=result.summary;
  return {...base,summary:`集計金額 ${totals.amount}円 / 集計数量 ${totals.quantity}点`,columns:['カテゴリ','金額','数量'],rows:(totals.dimensions.category??[]).map(row=>[row.label,row.amount,row.quantity]),actual:{amount:totals.amount,quantity:totals.quantity,categoryAmount:(totals.dimensions.category??[]).reduce((sum,row)=>sum+row.amount,0)}};
 }
 if(!Number.isSafeInteger(quantity)||quantity<1||quantity>100)throw Error('数量は1〜100で指定してください。');
 const ledger=buildUsedGoodsLedger([{id:'fixture-ledger',sku:'FIXTURE-LEDGER',name:'サンプル椅子',quantity,transactionDate:'2026-11-10',transactionType:'購入',purchaseQuantity:2,purchasePrice:10500,usedGoodsItemType:'椅子',counterpartyName:'架空仕入先',counterpartyAddress:'架空住所',counterpartyOccupation:'家具業',identityVerificationMethod:'架空確認書類',shippingCost:1000,customFields:{__yahooPurchaseImport:{auctionId:'fixture-auction',orderId:'fixture-order',itemTotal:20000,shipping:1000}}}],2026,'2026-11-23T00:00:00.000Z');
 return {...base,summary:`台帳 ${ledger.rows.length}行 / 数量 ${ledger.rows[0]?.quantity??0}点 / 合計 ${ledger.rows[0]?.total??0}円`,columns:['取引日','商品名','数量','合計'],rows:ledger.rows.map(row=>[row.date,row.name,row.quantity??0,row.total??0]),actual:{rowCount:ledger.rows.length,quantity:ledger.rows[0]?.quantity,total:ledger.rows[0]?.total}};
}
