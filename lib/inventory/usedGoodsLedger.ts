/** Read-only ledger projection. Never infer acquisition quantities from current stock. */
export type LedgerSource = Record<string, unknown>;
export interface UsedGoodsLedgerRow {
  inventoryId: string; managementNumber: string; direction: '受入れ' | '払出し';
  date: string; transactionType: string; name: string; itemType: string;
  quantity: number | null; feature: string; counterpartyName: string;
  counterpartyAddress: string; counterpartyOccupation: string; counterpartyAge: string;
  verification: string; unitPrice: number | null; recordedTotal: number | null;
  transactionKey: string; market: string; issues: string[];
}
export interface LedgerTransaction {
  key: string; date: string; counterpartyName: string; itemTypes: string;
  quantity: number | null; total: number | null; products: number; issues: string[];
}
export interface LedgerIssue { inventoryId: string; managementNumber: string; name: string; date: string; message: string }
export interface UsedGoodsLedger {
  year: number; generatedAt: string; rows: UsedGoodsLedgerRow[];
  transactions: LedgerTransaction[]; issues: LedgerIssue[]; omittedSplits: number;
}
export const LEDGER_SOURCE_FIELDS = [
  'id','sku','name','quantity','unit','sourceSystem','sourceInventoryId','transactionDate',
  'usedGoodsItemType','purchaseQuantity','transactionType','identityVerificationMethod',
  'counterpartyName','counterpartyOccupation','counterpartyAddress','purchasePrice',
  'dailyPurchaseTotal','saleEndDate','salePrice','market','customFields','deletedAt','listingPartition','createdAt',
] as const;
export function ledgerObject(raw: unknown): Record<string, unknown> {
  let v = raw;
  for (let i=0; i<5 && typeof v==='string'; i++) { try { v=JSON.parse(v); } catch { return {}; } }
  return v && typeof v==='object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
const str = (v: unknown) => typeof v==='string' ? v.trim() : typeof v==='number' ? String(v) : '';
const number = (v: unknown): number | null => v!==null && v!==undefined && v!=='' && Number.isFinite(Number(v)) && Number(v)>=0 ? Number(v) : null;
export function ledgerDate(value: unknown): string {
  const s=str(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d=new Date(s+'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===s ? s : '';
}
export function ledgerYear(raw: unknown): number {
  if (!/^\d{4}$/.test(String(raw)) || Number(raw)<1900 || Number(raw)>2100) throw Error('出力する年を1900〜2100年で指定してください。');
  return Number(raw);
}
function management(r: LedgerSource) { return str(r.sourceSystem)==='ZAICO' && str(r.sourceInventoryId) ? str(r.sourceInventoryId) : str(r.sku)||str(r.id); }
function missing(row: UsedGoodsLedgerRow): string[] {
  const fields: [unknown,string][] = [[row.transactionType,'取引区分'],[row.itemType,'品目'],[row.quantity && row.quantity>0,'数量'],[row.feature,'古物の特徴'],[row.counterpartyName,'相手方氏名・名称'],[row.counterpartyAddress,'相手方住所'],[row.counterpartyOccupation,'相手方職業'],[row.counterpartyAge,'相手方年齢・生年月日']];
  if(row.direction==='受入れ') fields.push([row.verification,'本人確認方法']);
  return fields.filter(([value])=>!value).map(([,label])=>label+'が未記録');
}
/** No grouping by title/barcode: separate acquisitions can legitimately share both. */
export function buildUsedGoodsLedger(sources: LedgerSource[], selectedYear: number, generatedAt=new Date().toISOString()): UsedGoodsLedger {
  const year=ledgerYear(selectedYear), prefix=String(year)+'-';
  const rows: UsedGoodsLedgerRow[]=[], issues: LedgerIssue[]=[], transactions=new Map<string,LedgerTransaction>();
  const seenImports=new Map<string, string>(); let omittedSplits=0;
  const sorted=[...sources].sort((a,b)=>str(a.createdAt).localeCompare(str(b.createdAt))||str(a.id).localeCompare(str(b.id)));
  const byId=new Map(sources.map(r=>[str(r.id),r]));
  for (const source of sorted) {
    const c=ledgerObject(source.customFields), restage=ledgerObject(c.__restageImport), yahoo=ledgerObject(c.__yahooPurchaseImport), split=ledgerObject(c.__belloStockSplit);
    const id=str(source.id), managementNumber=management(source), name=str(source.name);
    const issue=(message:string,date=str(source.transactionDate))=>issues.push({inventoryId:id,managementNumber,name,date,message});
    const date=ledgerDate(source.transactionDate), saleDate=ledgerDate(source.saleEndDate);
    const hasPurchase=['transactionDate','transactionType','purchaseQuantity','counterpartyName','usedGoodsItemType'].some(k=>source[k]!=null&&source[k]!=='');
    const sourceId=str(split.sourceInventoryId);
    if(sourceId) {
      if(date.startsWith(prefix)) omittedSplits++;
      if(!byId.has(sourceId)) issue('分割元の商品が見つかりません。仕入れ記録の原本を確認してください。');
    } else if(!date && hasPurchase) {
      // Never silently assign unknown dates to the year the inventory was created.
      issue('取引日が未登録または不正です。対象年を判定できないため台帳本体には含めていません。');
    }
    if(date.startsWith(prefix) && !sourceId) {
      const importKey=restage.goodsId && restage.date ? `RESTAGE:${restage.date}:${restage.goodsId}` : yahoo.auctionId ? `YAHOO:${yahoo.auctionId}` : '';
      if(importKey && seenImports.has(importKey)) {
        issue(`同じ仕入れIDの重複記録です（先行記録：${seenImports.get(importKey)}）。二重計上を避けて受入れから除外しました。`,date);
      } else {
        if(importKey) seenImports.set(importKey,managementNumber);
        const auctionLedger=ledgerObject(restage.ledger);
        const key=restage.goodsId ? `RESTAGE:${str(restage.date)}` : yahoo.auctionId ? `YAHOO:${str(yahoo.orderId)||str(yahoo.auctionId)}` : '';
        const imported=Boolean(restage.goodsId||yahoo.auctionId);
        const quantity=imported ? number(restage.quantity??yahoo.quantity) : number(source.purchaseQuantity);
        const row: UsedGoodsLedgerRow={inventoryId:id,managementNumber,direction:'受入れ',date,
          transactionType:str(source.transactionType),name,itemType:str(source.usedGoodsItemType),quantity,
          feature:str(c.usedGoodsFeature),counterpartyName:str(source.counterpartyName),counterpartyAddress:str(source.counterpartyAddress),
          counterpartyOccupation:str(source.counterpartyOccupation),counterpartyAge:str(c.counterpartyAge)||str(c.counterpartyBirthDate),
          verification:str(source.identityVerificationMethod),unitPrice:number(source.purchasePrice),
          recordedTotal:number(source.dailyPurchaseTotal),transactionKey:key,market:'',issues:[]};
        if(imported && row.itemType) {
          // Imported item types are transaction-wide summaries; keep their meaning explicit.
          row.issues.push('品目欄は仕入取引全体の登録内容。商品は商品名・特徴で区別');
        }
        row.issues.push(...missing(row));
        if(row.counterpartyAddress==='履歴あり')row.issues.push('住所は「履歴あり」です。参照先の住所記録を確認');
        if(source.deletedAt)row.issues.push('削除済み商品に残っている取引記録');
        if(source.listingPartition==='MERGED')row.issues.push('在庫合算後の元商品に残っている取引記録');
        rows.push(row);
        if(key) {
          const total=restage.goodsId ? number(auctionLedger.purchaseTotal) : number(yahoo.itemTotal)!==null && number(yahoo.shipping)!==null ? Number(yahoo.itemTotal)+Number(yahoo.shipping) : null;
          const groupQuantity=restage.goodsId ? number(auctionLedger.quantity) : quantity;
          const old=transactions.get(key);
          if(!old)transactions.set(key,{key,date,counterpartyName:row.counterpartyName,itemTypes:row.itemType,quantity:groupQuantity,total,products:1,issues:[]});
          else {
            old.products++;
            if(restage.goodsId) {
              if(old.total!==total||old.quantity!==groupQuantity||old.itemTypes!==row.itemType) {
                old.issues.push('同じ開催日の仕入れ合計に不一致があります。');old.total=null;old.quantity=null;
              }
            } else {
              old.total=old.total===null||total===null?null:old.total+total;
              old.quantity=old.quantity===null||groupQuantity===null?null:old.quantity+groupQuantity;
              if(old.date!==date||old.counterpartyName!==row.counterpartyName) old.issues.push('同一注文の取引日・相手方を確認してください。');
            }
          }
        }
      }
    }
    if(saleDate.startsWith(prefix)) {
      // A stock split inherits old sale fields; only an actual sale split is a new disposal.
      if(sourceId && split.operation!=='SOLD_OUT' && !c.__belloSale) continue;
      if(source.listingPartition==='MERGED') continue;
      const sale=ledgerObject(c.__belloSale);
      const row:UsedGoodsLedgerRow={inventoryId:id,managementNumber,direction:'払出し',date:saleDate,transactionType:'売却',name,
        itemType:str(source.usedGoodsItemType),quantity:number(sale.physicalQuantity??source.quantity),feature:str(c.usedGoodsFeature),
        counterpartyName:str(c.saleCounterpartyName),counterpartyAddress:str(c.saleCounterpartyAddress),counterpartyOccupation:str(c.saleCounterpartyOccupation),
        counterpartyAge:str(c.saleCounterpartyAge),verification:'',unitPrice:null,recordedTotal:number(source.salePrice),transactionKey:'',market:str(source.market),issues:[]};
      row.issues=missing(row);
      row.issues.push('払出日は販売終了日。相手方情報の記録要否を品目・取引に応じて確認');
      rows.push(row);
    } else if(source.saleEndDate && !saleDate) issue('販売終了日の形式が不正のため払出しの対象年を判定できません。',str(source.saleEndDate));
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.managementNumber.localeCompare(b.managementNumber)||a.direction.localeCompare(b.direction));
  for(const row of rows) if(row.issues.length) issues.push({inventoryId:row.inventoryId,managementNumber:row.managementNumber,name:row.name,date:row.date,message:`${row.direction}：${row.issues.join('／')}`});
  return {year,generatedAt,rows,transactions:[...transactions.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.key.localeCompare(b.key)),issues,omittedSplits};
}
