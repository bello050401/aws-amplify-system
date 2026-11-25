import {CATEGORY_COLORS,TITLE_CATEGORIES} from '../analysis/categoryFromTitle';
import {drilldownAnalysis,queryAnalysis} from '../analysis/query';
import {isSkuDimension} from '../analysis/skus';
import {withCurrentHoldingCounts} from '../analysis/holdings';
import {VALUE_GROUPS,type InventoryValue} from '../inventoryValue';
import type {AnalysisBuild,AnalysisResponse,SkuDimension,Summary,Totals} from '../analysis/types';
import type {
  AnalysisPorts,AnalysisRequest,Bucket,DetailItem,DetailResult,Dimension,DrilldownRequest,ProductFact,Target,
} from './model';

export const previewToday = '2026-11-14';
const asOf = '2026-11-14T03:00:00.000Z';
export const generation = 'synthetic-2026-11-14';
const nextGeneration = 'synthetic-published-later';
const previewClockEnd = '2026-11-14';

const categories = [
  ['bench','ベンチ・オットマン','#9b805e'],
  ['chair','ダイニングチェア','#57978a'],
  ['sofa','ソファ','#254f42'],
  ['work','ワークチェア','#596e9b'],
  ['table','テーブル・デスク','#789c60'],
  ['storage','収納家具','#b77857'],
  ['lighting','照明','#b5974c'],
  ['art','インテリア・アート','#937cab'],
  ['__unknown__','未分類','#84908a'],
] as const;

const counts = (fields:Partial<Totals['unknown']>={}):Totals['unknown'] => ({cost:0,amount:0,quantity:0,category:0,kind:0,lot:0,channel:0,origin:0,date:0,...fields});
const amountFor = (fact:ProductFact) => fact.amount ?? 0;

// Generated density fixture with invented stock counts, item names and costs.
const denseCategories = [...TITLE_CATEGORIES,{id:'__unknown__',label:'未分類'}];
const denseCounts = [1,2,3,4,5,6,7,8,9,10,11,12,13,16,35,94];
const denseRecords = [160,31,22,15,12,9,7,6,4,3,2,2,2,2,1,1];
function denseStock() {
  return denseCounts.flatMap((quantity,index)=>Array.from({length:denseRecords[index]},(_,record)=>{
    const category = denseCategories[(index+record) % denseCategories.length];
    return fact('dense-'+quantity+'-'+record,'検証用 '+category.label+' '+(record+1),category.id,(record+11)*quantity*100,quantity,{
      categoryLabel:category.label,kindId:null,kindCount:0,categoryBasis:category.id==='__unknown__'?'unknown':'title',
    });
  }));
}

function fact(id:string, title:string, category:string, amount:number|null, quantity:number|null, extra:Partial<ProductFact>={}):ProductFact {
  return {
    id,inventoryId:id,title,category,amount,quantity,sku:'SKU-'+id.toUpperCase(),
    categoryLabel:categories.find(([key])=>key===category)?.[1] ?? '未分類',
    imageRef:null,date:'2026-11-07',kindId:'kind-'+id,
    holding:'single',holdingBand:'1',lot:'single',lotBand:'1',lotId:'lot-'+id,kindCount:1,lotCount:1,
    unknown:counts({cost:amount===null?1:0,amount:amount===null?1:0,quantity:quantity===null?1:0,category:category==='__unknown__'?1:0}),
    ...extra,
  };
}

const bench = 'オーク無垢材 ベンチ 木座 ナチュラル 幅120cm 国内家具メーカー仕様';
const stock = [
  fact('bench-a',bench,'bench',60_000,6,{sku:'SKU-BENCH',kindId:'kind-bench',holding:'multiple',holdingBand:'4-8',imageRef:'fixture/bench',imageUrl:'/bench.jpg'}),
  fact('bench-b',bench,'bench',20_000,2,{sku:'SKU-BENCH',kindId:'kind-bench',holding:'multiple',holdingBand:'4-8',kindCount:0,date:'2026-10-24'}),
  fact('chair','成形合板のダイニングチェア ウォルナット色','chair',20_000,1),
];
const recent = [
  fact('recent-bench',bench,'bench',200_000,20,{holding:'multiple',holdingBand:'9+',lot:'multiple',lotBand:'9+',imageRef:'fixture/bench',imageUrl:'/bench.jpg'}),
  fact('recent-chair','ダイニングチェア ブナ材 ブラック','chair',40_000,2,{lot:'multiple',lotBand:'2-3'}),
  fact('recent-storage','収納家具 オーク材','storage',30_000,1),
];
const sales = [
  fact('sales-bench',bench,'bench',100_000,8,{lot:'multiple',lotBand:'4-8',imageRef:'fixture/bench',imageUrl:'/bench.jpg'}),
  fact('sales-chair','ダイニングチェア 本革座面','chair',60_000,1),
  fact('sales-sofa','二人掛けソファ グレー','sofa',50_000,1),
  fact('sales-work','ワークチェア ブラック','work',37_000,1),
  fact('sales-table','天板が伸長するダイニングテーブル','table',30_000,1),
  fact('sales-storage','壁面収納 キャビネット','storage',25_000,1),
  fact('sales-light','フロアスタンド 布シェード','lighting',18_000,1),
  fact('sales-art','額装ポスター','art',14_000,1,{date:'2026-10-29'}),
  fact('sales-u','商品コードのみ登録された品','__unknown__',12_000,null,{kindId:null,kindCount:0,lotId:null,lotBand:'unknown',lot:'unknown',lotCount:0}),
];

function stockWithCurrentCounts(rows:ProductFact[]):ProductFact[] {
  return withCurrentHoldingCounts(rows).map((fact,index)=>({...rows[index],...fact}));
}

function rowsFor(request:AnalysisRequest, mode:string|null) {
  if (mode==='empty') return [];
  if (mode==='unknown' && request.target==='inventory') return [
    fact('unpriced','原価未登録の商品','__unknown__',null,1,{sku:null,kindId:null,kindCount:0,holding:'unknown',holdingBand:'unknown',holdingCount:1,holdingBasis:'inventory-record'}),
  ];
  if (mode==='exact-counts' && request.target==='inventory') return stockWithCurrentCounts([
    ...stock, fact('two','在庫数が2点の商品','chair',1000,2,{kindId:null,kindCount:0}),
    fact('three','在庫数が3点の商品','storage',3000,3), fact('five','在庫数が5点の商品','lighting',5000,5),
  ]);
  if (mode==='dense-stock' && request.target==='inventory') return stockWithCurrentCounts(denseStock());
  if (request.target==='inventory') return stockWithCurrentCounts(stock);
  if (request.target==='acquisitions') return recent;
  if (request.target==='retailReference') return [
    fact('retail-bench',bench,'bench',75_000,3,{imageRef:'fixture/bench',imageUrl:'/bench.jpg'}),
    fact('retail-sofa','ファブリックソファ 2人掛け','sofa',25_000,1),
  ];
  if (mode==='known-sale' || mode==='zero-sale' || mode==='unknown-sale') {
    const amount = mode==='known-sale' ? 100_000 : mode==='zero-sale' ? 0 : null;
    return [fact('sales-coverage',bench,'bench',amount,1,{unknown:counts({cost:1,amount:amount===null?1:0})})];
  }
  if (mode==='published-sale') return [fact('published-sale',bench,'bench',888_000,1)];
  if(mode==='negative') return [...sales,fact('return','売上返品・取消','bench',-450_000,null,{lot:'multiple',lotBand:'4-8'})]
    .filter(row=>!row.date || (row.date >= (request.start??'') && row.date <= (request.end??previewToday)));
  return sales.filter(row=>!row.date || (row.date >= (request.start??'') && row.date <= (request.end??previewToday)));
}

const bucketName:Record<string,string> = {
  '1':'1点','2-3':'2〜3点','4-8':'4〜8点','9+':'9点以上',unknown:'判定不明',
};
const singleColor = '#386456', multiColor = '#76a59a', unknownColor = '#9aa49f';
function identify(dimension:Dimension,key:string):{label:string;color:string} {
  if (dimension==='category') {
    const category = categories.find(([id])=>id===key);
    return {label:category?.[1]??denseCategories.find(entry=>entry.id===key)?.label??'未分類',color:CATEGORY_COLORS[key]??category?.[2]??unknownColor};
  }
  if (dimension==='holdingCount') {
    const colors = ['#244d48','#58958d','#ae794f','#8a749b','#b9a255','#547a98','#849358','#bd8591','#9a5949','#416d78','#8a783d','#527868','#a771ac','#aa635e','#517cae','#a78b53','#698d73','#77616e'];
    const color = colors[(Number(key)-1) % colors.length] ?? unknownColor;
    return {label:key==='__unknown__'?'保有数不明':key+'点保有',color};
  }
  if (dimension==='holdingBand'||dimension==='lotBand') {
    const color = ({'1':singleColor,'2-3':multiColor,'4-8':'#708ab4','9+':'#c28959'})[key] ?? unknownColor;
    return {label:bucketName[key]??key,color};
  }
  const holding = dimension==='holding';
  if (key==='single') return {color:singleColor,label:holding?'1点だけ保有':'単品仕入れ'};
  if (key==='multiple') return {color:multiColor,label:holding?'2点以上保有':'複数仕入れ'};
  return {color:unknownColor,label:holding?'数量判定不明':'判定不明'};
}
function totals(rows:ProductFact[]):Totals {
  return {
    amount:rows.reduce((sum,row)=>sum+amountFor(row),0),
    gross:rows.reduce((sum,row)=>sum+Math.max(0,amountFor(row)),0),
    returns:rows.reduce((sum,row)=>sum+Math.min(0,amountFor(row)),0),
    quantity:rows.reduce((sum,row)=>sum+(row.quantity??0),0),
    grossQuantity:rows.reduce((sum,row)=>sum+Math.max(0,row.quantity??0),0),
    returnedQuantity:rows.reduce((sum,row)=>sum+Math.max(0,-(row.quantity??0)),0),
    kinds:rows.reduce((sum,row)=>sum+row.kindCount,0),
    lots:rows.reduce((sum,row)=>sum+row.lotCount,0),
    records:rows.length,
    unknown:counts({
      amount:rows.filter(row=>row.amount===null).length,
      cost:rows.reduce((sum,row)=>sum+row.unknown.cost,0),
      quantity:rows.filter(row=>row.quantity===null).length,
      category:rows.filter(row=>row.category==='__unknown__').length,
      kind:rows.filter(row=>!row.kindId).length,
      lot:rows.filter(row=>!row.lotId).length,
    }),
  };
}
type RecordDimension = Exclude<Dimension,SkuDimension>;
function bucketKey(row:ProductFact,dimension:RecordDimension) {
  if (dimension!=='holdingCount') return row[dimension];
  return row.holdingCount == null ? '__unknown__' : String(row.holdingCount);
}
function summarize(rows:ProductFact[],target:Target):Summary {
  const dimensions:RecordDimension[] = ['category','holding','holdingBand','lot','lotBand'];
  if (target==='inventory') dimensions.push('holdingCount');
  const buckets = Object.fromEntries(dimensions.map(dimension=>{
    const byKey = new Map<string,ProductFact[]>();
    for (const row of rows) {
      const key = bucketKey(row,dimension);
      byKey.set(key,[...byKey.get(key)??[],row]);
    }
    const data:Bucket[] = [...byKey].map(([key,items])=>({key,...identify(dimension,key),...totals(items)}));
    return [dimension,data];
  }));
  return {...totals(rows),dimensions:buckets};
}

export function stockView(rows:ProductFact[]=stock, month?:string):InventoryValue {
  const summary = totals(rows);
  const groups = VALUE_GROUPS.map(group=>{
    const items = rows.filter(row=>group.key==='selling' ? row.id!=='bench-b' : group.key==='photo' && row.id==='bench-b');
    const subtotal = totals(items);
    return {...group,amount:subtotal.amount,quantity:subtotal.quantity,count:subtotal.records};
  });
  return {version:2,asOf,total:summary.amount,quantity:summary.quantity,count:summary.records,groups,other:[],issues:[],issueCount:0,
    excluded:[],unpricedCount:summary.unknown.cost,month};
}
function periodFor(target:Target,request:AnalysisRequest):AnalysisResponse['period'] {
  if (target==='inventory') return null;
  const start = target==='retailReference'?'2026-08-17':target==='acquisitions'||request.rollingDays===30?'2026-10-16':request.start??'2026-11-01';
  const end = request.end && request.end < previewClockEnd ? request.end : previewClockEnd;
  return {start,end,cutoff:asOf,timezone:'Asia/Tokyo',partial:!request.end||request.end>=previewClockEnd};
}

export function createFixtures(mode:string|null = null):{ports:AnalysisPorts} {
  let failureCount = 0;
  const inventory = rowsFor({target:'inventory'},mode?.startsWith('comparison') ? 'exact-counts' : mode);
  const metadata:AnalysisBuild['metadata'] = {
    version:1,generation,asOf,timezone:'Asia/Tokyo',scopeId:'synthetic-fixture',
    amountBasis:'集計基準：検証用データ',metadataVersions:{},coverageStart:'2026-10-01',coverageEnd:previewToday,
    accuracy:'captured-current-source',sourceRecordCount:12,unlocatedAcquisitionRecords:1,
    ...(mode==='legacy-sku' ? {} : {inventorySkuVersion:1}),
  };
  const referenceExclusions = {unknownChannel:1,unknownCost:1,unverifiedOrigin:0,excluded:1,salesAmount:17_500};
  const build:AnalysisBuild = {
    inventory, metadata, inventoryValue:stockView(inventory), referenceExclusions,
    categories:[...new Map(inventory.filter(row=>row.category!=='__unknown__').map(row=>[row.category,{id:row.category,label:row.categoryLabel}])).values()],
    sales:[],acquisitions:[],retailReference:[],
  };
  const comparisonMode = mode?.startsWith('comparison');
  const historicDay = '2026-10-31';
  const historicGeneration = 'synthetic-inventory-'+historicDay;
  const historicInventory = stockWithCurrentCounts(inventory.filter(row=>row.id!=='bench-b' && row.id!=='three').map(row=>({...row,quantity:row.id==='bench-a'?2:row.quantity,amount:row.id==='bench-a'?20000:row.amount})));
  const historicBuild:AnalysisBuild = {...build,inventory:historicInventory,inventoryValue:stockView(historicInventory),metadata:{...metadata,
    generation:historicGeneration,asOf:historicDay+'T02:17:00.000Z',coverageStart:historicDay,coverageEnd:historicDay,
    inventorySkuVersion:mode==='comparison-legacy'?undefined:1,
  }};
  const ports:AnalysisPorts = {
    async load(request) {
      if (comparisonMode && request.target==='inventory' && request.daily) {
        if(request.daily==='2026-10-17') return {status:'error'};
        if(request.daily!==historicDay) return {status:'missing'};
        return queryAnalysis(historicBuild,request);
      }
      if (mode==='error' && failureCount++===0) return {status:'error'};
      if (mode==='wrong-generation' && request.generation===generation) {
        const wrong = await createFixtures('published-sale').ports.load({target:'sales'});
        return wrong.status==='ok' ? {...wrong,metadata:{...wrong.metadata,generation:nextGeneration}} : wrong;
      }
      if (mode==='generation-race' && request.target==='sales' && !request.generation) {
        const latest = await createFixtures('published-sale').ports.load(request);
        return latest.status==='ok' ? {...latest,metadata:{...latest.metadata,generation:nextGeneration}} : latest;
      }
      if (request.generation && request.generation!==generation) return {status:'expired'};
      if (mode==='missing' || request.daily || (request.target==='sales' && request.start && request.start<'2026-10-01')) return {status:'missing'};
      if (request.target==='inventory') return queryAnalysis(build,request);
      return {
        status:'ok',target:request.target,period:periodFor(request.target,request),
        summary:summarize(rowsFor(request,mode),request.target),
        inventoryValue:build.inventoryValue, metadata, referenceExclusions,
      };
    },
    async drill(request:DrilldownRequest):Promise<DetailResult> {
      if (comparisonMode && request.daily) {
        if(request.daily!==historicDay) return {status:'missing'};
        return drilldownAnalysis(historicBuild,request);
      }
      if (request.generation!==generation) return {status:'expired'};
      let rows = rowsFor(request,mode);
      const {dimension,key,groupKindId} = request;
      if (isSkuDimension(dimension)) {
        const result = drilldownAnalysis(build,request);
        if (result.status !== 'ok') return result;
        const addImage = (record:ProductFact) => ({...record,imageUrl:inventory.find(row=>row.id===record.id)?.imageUrl});
        return {...result,items:result.items.map(item=>{
          if (item.type==='record') return {type:'record',record:addImage(item.record)};
          const representative = addImage(item.group.representative);
          return item.type==='sku-group'
            ? {type:'sku-group',group:{...item.group,representative}}
            : {type:'group',group:{...item.group,representative}};
        })};
      }
      if (dimension && key) rows = rows.filter(row=>bucketKey(row,dimension)===key);
      const groups = new Map<string,ProductFact[]>();
      for (const row of rows) {
        if (row.kindId) groups.set(row.kindId,[...groups.get(row.kindId)??[],row]);
      }
      const items:DetailItem[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (groupKindId && row.kindId!==groupKindId) continue;
        const group = row.kindId ? groups.get(row.kindId) : undefined;
        if (!groupKindId && row.kindId && group && group.length>1) {
          if (seen.has(row.kindId)) continue;
          seen.add(row.kindId);
          items.push({type:'group',group:{kindId:row.kindId,representative:row,count:group.length,amount:totals(group).amount,quantity:totals(group).quantity}});
        } else items.push({type:'record',record:row});
      }
      const start = request.cursor ? Number(request.cursor) : 0;
      const end = start + (request.limit ?? 24);
      return {status:'ok',items:items.slice(start,end),nextCursor:end<items.length ? String(end) : null};
    },
  };
  return {ports};
}
