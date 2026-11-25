import {createHash} from 'node:crypto';
import {splitCategoryNames} from '../categories';
import {selectInventoryValueRow} from '../inventoryValue';
import {mapZaicoOptionalAttributes} from '../zaicoMapping';
import type {ArchivedStock, InventoryWindow} from '../inventoryValueHistory';
import {buildAnalysis} from './aggregate';
import {dateOnly, jstDay} from './period';
import {isAnalysisGeneration} from './publicationFormat';
import type {AnalysisBuild, AnalysisSource} from './types';

/** Identity references only. Today's business values must never enter a historical build. */
export interface ArchiveIdentity {id:string; sku?:string|null; createdAt:string; basis:'historical-baseline'|'immutable-current-link'; linkable:boolean}

/** Use one genuine full observation on the requested JST day. This is deliberately
 * not a midnight balance or a claim to reconstruct every historical BELLO edit.
 * Later current quantities, inferred original lots and incomplete field logs are
 * never used as substitutes for the archive's observed physical quantity. */
export function reconstructArchivedInventory(
  window:InventoryWindow, requestedDay:string, identities:ReadonlyMap<string,ArchiveIdentity>, reconstructedAt:string,
):AnalysisBuild {
  dateOnly(requestedDay);
  const asOf=Number.isFinite(Date.parse(window.end))?new Date(window.end).toISOString():'';
  if(!window.full || !isAnalysisGeneration(asOf) || jstDay(window.end)!==requestedDay ||
    !isAnalysisGeneration(reconstructedAt) || reconstructedAt<asOf || !window.key) throw Error('ARCHIVE_HISTORY_ANCHOR');
  const seen=new Set<string>(), linked=new Set<string>(), names=new Set<string>(), rows:AnalysisSource[]=[];
  let unmatched=0,historicalIdentityRecords=0,currentIdentityRecords=0;
  const unlinkedIds=new Set<string>();
  for(const source of window.remote){
    const sourceId=String(source.id);
    if(!Number.isSafeInteger(source.id)||source.id<=0||seen.has(sourceId))throw Error('ARCHIVE_HISTORY_DUPLICATE_SOURCE');
    seen.add(sourceId);
    if(!Number.isFinite(Date.parse(source.updated_at))||Date.parse(source.updated_at)>Date.parse(window.end))throw Error('ARCHIVE_HISTORY_FUTURE_ROW');
    const candidate=identities.get(sourceId);
    const identity=candidate&&Number.isFinite(Date.parse(candidate.createdAt))&&Date.parse(candidate.createdAt)<=Date.parse(window.end)?candidate:undefined;
    if(identity){if(!identity.id||linked.has(identity.id))throw Error('ARCHIVE_HISTORY_DUPLICATE_LINK');linked.add(identity.id);}
    else unmatched++;
    if(identity?.basis==='historical-baseline')historicalIdentityRecords++;
    if(identity?.basis==='immutable-current-link')currentIdentityRecords++;
    if(identity&&!identity.linkable)unlinkedIds.add(identity.id);
    const labels=splitCategoryNames(source.category??'');
    labels.forEach(label=>names.add(label));
    const mapped=mapZaicoOptionalAttributes(Object.entries(source.optional_attributes??{}).map(([name,value])=>({name,value})),true);
    const quantity=archivedQuantity(source);
    rows.push({id:identity?.id??`archive:zaico:${sourceId}`,sku:identity?.sku??null,name:source.title,
      quantity,purchasePrice:mapped.coreFields.purchasePrice??null,saleEndDate:mapped.extendedFields.saleEndDate,
      categoryIds:labels,deletedAt:source.deleted?window.end:null});
  }
  const categories=[...names].map(name=>({id:name,name})),masters=new Map(categories.map(c=>[c.id,c.name]));
  const unknownQuantityRecords=rows.filter(row=>row.quantity===null&&selectInventoryValueRow({...row,quantity:1},masters).eligible).length;
  const build=buildAnalysis(rows,categories,[],asOf,asOf);
  // The archive is an inventory observation. Never expose inferred historical sales/acquisitions.
  build.sales=[];build.acquisitions=[];build.retailReference=[];
  for(const fact of build.inventory)if(fact.inventoryId?.startsWith('archive:zaico:')||unlinkedIds.has(fact.inventoryId??''))fact.inventoryId=null;
  build.metadata.accuracy='reference-reconstructed';
  build.metadata.inventoryHistory={basis:'archived-source',sourceSystem:'ZAICO',sourceCapturedAt:asOf,reconstructedAt,
    sourceKeyDigest:createHash('sha256').update(window.key).digest('hex'),sourceRecordCount:window.remote.length,
    unmatchedSourceRecords:unmatched,skuBasis:'historical-baseline-and-immutable-link',historicalIdentityRecords,currentIdentityRecords,unknownQuantityRecords,limitations:[
      '当日のZAICO全件保存から復元した参考値です。保存時刻以降の変更は含みません。',
      '数量・購入単価・作業区分・商品名は当時の保存値です。BELLOのみの変更は一致しない場合があります。',
      'SKUは当時のBELLO保存記録と、変更不可のSKU・作成日時を確認できた連携先を使用しています。未連携の商品はSKU不明です。',
      ...(unknownQuantityRecords?[`数量を確認できない在庫${unknownQuantityRecords}件は、金額・数量・SKUの集計から除外しています。`]:[]),
    ]};
  return build;
}

function archivedQuantity(row:ArchivedStock):number|null {
  if(row.quantity===null||String(row.quantity).trim()==='')return null;
  const quantity=Number(String(row.quantity).normalize('NFKC').replace(/,/g,''));
  if(!Number.isSafeInteger(quantity)||quantity<0)throw Error('ARCHIVE_HISTORY_QUANTITY');
  return quantity;
}
