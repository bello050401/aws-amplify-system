import {ledgerAddressPlaceholder,ledgerDescription,ledgerFeature,ledgerPublicName,legacyRecordedAmount,purchaseMemo,resolveLedgerSources} from './usedGoodsLedgerEvidence';
/** Read-only ledger projection. Never infer acquisition quantities from current stock. */
export type LedgerSource = Record<string, unknown>;
export interface UsedGoodsLedgerRow {
  inventoryId: string; managementNumber: string; direction: '受入れ' | '払出し';
  date: string; transactionType: string; name: string; itemType: string;
  quantity: number | null; feature: string; counterpartyName: string;
  counterpartyAddress: string; counterpartyOccupation: string;
  verification: string; unitPrice: number | null; recordedTotal: number | null;
  purchaseAmount: number | null; shipping: number | null; total: number | null; amountBasis: string;
  transactionKey: string; market: string; issues: string[];
  evidence?:string[]; memoKey?:string; memoAmount?:number; memoQuantity?:number; memoMinimumQuantity?:number;
}
export interface LedgerTransaction {
  key: string; date: string; counterpartyName: string; itemTypes: string;
  quantity: number | null; purchaseAmount: number | null; shipping: number | null; total: number | null; products: number; issues: string[];
}
export interface LedgerIssue { inventoryId: string; managementNumber: string; name: string; date: string; message: string }
export interface LedgerSupplierDay {
  key:string;date:string;counterpartyName:string;counterpartyAddress:string;counterpartyOccupation:string;verification:string;
  transactionType:string;itemTypes:string;references:string;products:number;quantity:number|null;purchaseAmount:number|null;shipping:number|null;total:number|null;amountBasis:string;issues:string[];
}
export interface UsedGoodsLedger {
  year: number; generatedAt: string; rows: UsedGoodsLedgerRow[];
  transactions: LedgerTransaction[]; supplierDays:LedgerSupplierDay[]; issues: LedgerIssue[]; omittedSplits: number;
}
export const LEDGER_SOURCE_FIELDS = [
  'id','sku','name','quantity','unit','sourceSystem','sourceInventoryId','transactionDate',
  'usedGoodsItemType','purchaseQuantity','transactionType','identityVerificationMethod',
  'counterpartyName','counterpartyOccupation','counterpartyAddress','purchasePrice',
  'dailyPurchaseTotal','shippingCost','categoryId','categoryIds','saleEndDate','salePrice','market','customFields','deletedAt','listingPartition','createdAt',
  'note','barcode',
] as const;
export function ledgerObject(raw: unknown): Record<string, unknown> {
  let v = raw;
  for (let i=0; i<5 && typeof v==='string'; i++) { try { v=JSON.parse(v); } catch { return {}; } }
  return v && typeof v==='object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
const str = (v: unknown) => typeof v==='string' ? v.trim() : typeof v==='number' ? String(v) : '';
const number = (v: unknown): number | null => (typeof v==='number'||typeof v==='string'&&v.trim()!=='') && Number.isFinite(Number(v)) && Number(v)>=0 ? Number(v) : null;
const blank = (v:unknown) => v===null||v===undefined||typeof v==='string'&&v.trim()==='';
const money = (v:unknown) => {const n=number(v);return n!==null&&Number.isSafeInteger(n)?n:null;};
const sum = (values:(number|null)[]) => values.every(v=>v!==null) ? values.reduce<number>((n,v)=>n+v!,0) : null;
/** Workflow tags and staff memos are not descriptions of the goods. */
export function ledgerItemDescription(source:LedgerSource):string {
  return ledgerDescription(source);
}
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
  const fields: [unknown,string][] = [[row.transactionType,'取引区分'],[row.itemType,'品目'],[row.quantity && row.quantity>0,'数量'],[row.feature,'古物の特徴'],[row.counterpartyName,'相手方氏名・名称'],[row.counterpartyAddress,'相手方住所'],[row.counterpartyOccupation,'相手方職業']];
  if(row.direction==='受入れ') fields.push([row.verification,'本人確認方法']);
  return fields.filter(([value])=>!value).map(([,label])=>label+'が未記録');
}
/** No grouping by title/barcode: separate acquisitions can legitimately share both. */
export function buildUsedGoodsLedger(sources: LedgerSource[], selectedYear: number, generatedAt=new Date().toISOString()): UsedGoodsLedger {
  const year=ledgerYear(selectedYear), prefix=String(year)+'-';
  const rows: UsedGoodsLedgerRow[]=[], issues: LedgerIssue[]=[], transactions=new Map<string,LedgerTransaction>();
  const seenImports=new Map<string, string>(); let omittedSplits=0;
  const resolved=resolveLedgerSources(sources),evidence=new Map(resolved.map(r=>[str(r.source.id),r.references]));
  const sorted=resolved.map(r=>r.source).sort((a,b)=>str(a.createdAt).localeCompare(str(b.createdAt))||str(a.id).localeCompare(str(b.id)));
  const byId=new Map(sources.map(r=>[str(r.id),r]));
  for (const source of sorted) {
    const c=ledgerObject(source.customFields), restage=ledgerObject(c.__restageImport), yahoo=ledgerObject(c.__yahooPurchaseImport), split=ledgerObject(c.__belloStockSplit);
    const id=str(source.id), managementNumber=management(source), name=ledgerPublicName(source.name);
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
        // Yahoo's stored unit price already includes allocated shipping and can be rounded.
        // Use the exact acquisition amounts, not unitPrice * quantity + shipping.
        const shipping=!blank(source.shippingCost)?money(source.shippingCost):yahoo.auctionId?money(yahoo.shipping):0;
        const legacy=legacyRecordedAmount(source),memo=!imported?purchaseMemo(source):null;
        const purchaseAmount=yahoo.auctionId ? money(yahoo.itemTotal) : restage.goodsId?null:legacy.amount;
        const row: UsedGoodsLedgerRow={inventoryId:id,managementNumber,direction:'受入れ',date,
          transactionType:str(source.transactionType),name,itemType:ledgerItemDescription(source),quantity,
          feature:ledgerFeature(source),counterpartyName:str(source.counterpartyName),counterpartyAddress:str(source.counterpartyAddress),
          counterpartyOccupation:str(source.counterpartyOccupation),
          verification:str(source.identityVerificationMethod),unitPrice:money(source.purchasePrice),
          recordedTotal:money(source.dailyPurchaseTotal),purchaseAmount,shipping,total:purchaseAmount===null?null:sum([purchaseAmount,shipping]),
          amountBasis:yahoo.auctionId?'購入通知の商品金額＋配分済み送料（送料込み単価から再加算しません）':restage.goodsId?'開催日の確定購入金額で集計':legacy.basis,transactionKey:key,market:'',issues:[],evidence:evidence.get(id)||[]};
        // A memo shared by the same acquisition barcode is a lot total, not a total
        // to add on every split page. Require recorded price corroboration as well.
        if(memo&&str(source.barcode)&&row.unitPrice!==null&&row.counterpartyName&&!/^(ヤフオク!?|Yahoo!?オークション|メルカリ(?:Shops)?|BASE)$/i.test(row.counterpartyName.replace(/\s/g,''))){
          const unit=memo.amount/memo.quantity,multiple=unit>0?row.unitPrice/unit:0;
          if(multiple>=1&&multiple<=memo.quantity&&Math.abs(row.unitPrice-Math.round(multiple)*unit)<=1){
            row.memoKey=JSON.stringify([date,str(source.counterpartyName),str(source.barcode),memo.quantity,memo.amount]);
            row.memoAmount=memo.amount;row.memoQuantity=memo.quantity;row.memoMinimumQuantity=Math.round(multiple)*Math.max(1,number(source.quantity)||1);
            row.evidence!.push(`備考：${memo.excerpt}（購入価格と照合）`);
          }
        }
        row.issues.push(...missing(row));
        if(row.counterpartyAddress==='履歴あり')row.issues.push('住所欄は「履歴あり」のみ。保存済みの同一仕入先の履歴から実住所を一意に復元できません。');
        else if(ledgerAddressPlaceholder(row.counterpartyAddress))row.issues.push(`住所欄の「${row.counterpartyAddress}」は実住所の記録ではありません。`);
        if(source.deletedAt)row.issues.push('削除済み商品に残っている取引記録');
        if(source.listingPartition==='MERGED')row.issues.push('在庫合算後の元商品に残っている取引記録');
        rows.push(row);
        if(key) {
          const groupPurchase=restage.goodsId ? money(auctionLedger.purchaseTotal) : purchaseAmount;
          const total=sum([groupPurchase,shipping]);
          const groupQuantity=restage.goodsId ? number(auctionLedger.quantity) : quantity;
          const old=transactions.get(key);
          if(!old)transactions.set(key,{key,date,counterpartyName:row.counterpartyName,itemTypes:row.itemType,quantity:groupQuantity,purchaseAmount:groupPurchase,shipping,total,products:1,issues:[]});
          else {
            old.products++;
            old.itemTypes+='\n\n'+row.itemType;
            if(restage.goodsId) {
              if(old.purchaseAmount!==groupPurchase||old.quantity!==groupQuantity||old.date!==date||old.counterpartyName!==row.counterpartyName) {
                old.issues.push('同じ開催日の仕入れ合計に不一致があります。');old.purchaseAmount=null;old.quantity=null;
              }
            } else {
              old.purchaseAmount=sum([old.purchaseAmount,groupPurchase]);
              old.quantity=old.quantity===null||groupQuantity===null?null:old.quantity+groupQuantity;
              if(old.date!==date||old.counterpartyName!==row.counterpartyName) old.issues.push('同一注文の取引日・相手方を確認してください。');
            }
            old.shipping=sum([old.shipping,shipping]);old.total=sum([old.purchaseAmount,old.shipping]);
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
        itemType:ledgerItemDescription(source),quantity:number(sale.physicalQuantity??source.quantity),feature:ledgerFeature(source),
        counterpartyName:str(c.saleCounterpartyName),counterpartyAddress:str(c.saleCounterpartyAddress),counterpartyOccupation:str(c.saleCounterpartyOccupation),
        verification:'',unitPrice:null,recordedTotal:number(source.salePrice),purchaseAmount:null,shipping:null,total:number(source.salePrice),amountBasis:'販売価格',transactionKey:'',market:str(source.market),issues:[]};
      row.issues=missing(row);
      // Generic explanations belong in the sheet introduction, not one warning per sale.
      rows.push(row);
    } else if(source.saleEndDate && !saleDate) issue('販売終了日の形式が不正のため払出しの対象年を判定できません。',str(source.saleEndDate));
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.managementNumber.localeCompare(b.managementNumber)||a.direction.localeCompare(b.direction));
  for(const row of rows) if(row.issues.length) issues.push({inventoryId:row.inventoryId,managementNumber:row.managementNumber,name:row.name,date:row.date,message:`${row.direction}：${row.issues.join('／')}`});
  const groups=[...transactions.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.key.localeCompare(b.key));
  const supplierDays=groupLedgerBySupplierDay(rows,groups);
  for(const group of supplierDays)if(group.issues.length)issues.push({inventoryId:'',managementNumber:'日次集計',name:group.counterpartyName,date:group.date,message:group.issues.join('／')});
  return {year,generatedAt,rows,transactions:groups,supplierDays,issues,omittedSplits};
}

/** Summarize a supplier's day while keeping every product in the detail sheet.
 * A stored daily total/transaction total is a total, never a per-product amount.
 */
export function groupLedgerBySupplierDay(rows:UsedGoodsLedgerRow[],transactions:LedgerTransaction[]):LedgerSupplierDay[] {
  const buckets=new Map<string,UsedGoodsLedgerRow[]>(),byTransaction=new Map(transactions.map(t=>[t.key,t]));
  const normalizeSupplier=(name:string)=>name.normalize('NFKC').replace(/[\s　]+/g,' ').trim();
  // A marketplace name alone does not identify the actual seller.
  const unidentifiedSupplier=(name:string)=>!name||/^(ヤフオク!?|Yahoo!?オークション|メルカリ(?:Shops)?|BASE)$/i.test(name.replace(/\s/g,''));
  for(const row of rows.filter(r=>r.direction==='受入れ')) {
    const supplier=normalizeSupplier(row.counterpartyName);
    const key=JSON.stringify([row.date,unidentifiedSupplier(supplier)?`仕入先未特定:${row.inventoryId}`:supplier]);
    buckets.set(key,[...(buckets.get(key)??[]),row]);
  }
  const unique=(values:string[])=>[...new Set(values.filter(Boolean))];
  return [...buckets.entries()].map(([key,items])=>{
    const first=items[0],issues:string[]=[];
    const text=(field:keyof UsedGoodsLedgerRow)=>unique(items.map(r=>str(r[field]))).join('\n');
    let quantity:number|null=null,purchaseAmount:number|null=null,shipping:number|null=sum(items.map(r=>r.shipping)),total:number|null=null,amountBasis='購入金額未確定';
    const allImported=items.every(r=>r.transactionKey&&byTransaction.has(r.transactionKey));
    if(allImported) {
      const groups=unique(items.map(r=>r.transactionKey)).map(k=>byTransaction.get(k)!);
      const consistent=groups.every(g=>!g.issues.length&&g.date===first.date&&normalizeSupplier(g.counterpartyName)===normalizeSupplier(first.counterpartyName));
      total=consistent&&groups.every(g=>g.total!==null)?groups.reduce((s,g)=>s+g.total!,0):null;
      purchaseAmount=consistent?sum(groups.map(g=>g.purchaseAmount)):null;
      shipping=consistent?sum(groups.map(g=>g.shipping)):null;
      quantity=consistent&&groups.every(g=>g.quantity!==null)?groups.reduce((s,g)=>s+g.quantity!,0):null;
      amountBasis='仕入取引の確定購入金額＋送料（注文・開催日ごとに1回）';issues.push(...unique(groups.flatMap(g=>g.issues)));
    }else{
      const totals=[...new Set(items.map(r=>r.recordedTotal).filter((v):v is number=>v!==null))];
      if(totals.length===1){
        // Yahoo batch daily totals already include shipping. A mixed legacy group cannot
        // safely assign that shipping to each product; preserve the recorded total once.
        if(items.some(r=>r.transactionKey.startsWith('YAHOO:'))){
          total=totals[0];shipping=null;amountBasis='送料込みの登録済み日次合計（重複加算なし）';
          issues.push('ヤフオク取込と元記録が混在しています。送料内訳・重複の有無を確認してください。');
        }else{
          purchaseAmount=totals[0];total=sum([purchaseAmount,shipping]);amountBasis='登録済みの購入日次合計を1回＋各商品の送料';
        }
      }
      else if(totals.length>1){amountBasis='日次合計が不一致';issues.push('同じ日・仕入先に異なる日次合計があります。原票を確認してください。');}
      // This field was entered for a whole purchase/auction, not current on-hand stock.
      const quantities=[...new Set(items.map(r=>r.quantity).filter((v):v is number=>v!==null))];
      if(quantities.length===1)quantity=quantities[0];
      else if(quantities.length>1)issues.push(`仕入台帳の数量が不一致：${quantities.join('／')}。在庫の各記録を照合しましたが、取引全体の数量を特定できません。`);
      if(totals.length===0&&items.every(r=>!r.transactionKey)){
        const amounts:(number|null)[]=[],seenMemos=new Set<string>();
        for(const r of items){
          if(r.memoKey&&r.memoAmount!==undefined){
            if(!seenMemos.has(r.memoKey)){
              const members=items.filter(item=>item.memoKey===r.memoKey),minimum=members.reduce((n,item)=>n+(item.memoMinimumQuantity||1),0);
              if(minimum>(r.memoQuantity||0)){amounts.push(null);issues.push(`備考の仕入数量を関連在庫の数量が超えています：${members.map(m=>m.managementNumber).join('、')}`);}
              else amounts.push(r.memoAmount);
              seenMemos.add(r.memoKey);
            }
          }else amounts.push(r.purchaseAmount);
        }
        purchaseAmount=sum(amounts);total=sum([purchaseAmount,shipping]);
        amountBasis=seenMemos.size?'備考の仕入合計と購入価格を照合。同じ仕入れの合計は1回＋送料':'商品別の仕入数量・購入金額が確定する記録を合計＋送料';
      }
      if(items.some(r=>r.transactionKey)&&!items.some(r=>r.transactionKey.startsWith('YAHOO:')))issues.push('取込データと手動登録が混在しています。仕入れの重複と日次合計を確認してください。');
    }
    if(total===null)issues.push(`在庫・備考を照合しても金額内訳が確定しない記録：${items.filter(r=>r.purchaseAmount===null&&!r.memoKey).map(r=>`${r.managementNumber}（${r.amountBasis}）`).join('、')||amountBasis}。現在庫数で仕入数量を推測していません。`);
    if(quantity===null&&!issues.some(i=>i.startsWith('仕入台帳の数量が不一致')))issues.push('取引数量を確定できる記録がありません。現在庫数は仕入数量として代用していません。');
    for(const field of ['counterpartyAddress','counterpartyOccupation','verification'] as const)if(unique(items.map(r=>r[field])).length>1)issues.push(`${field==='counterpartyAddress'?'相手方住所':field==='verification'?'本人確認方法':'職業'}に複数の記録があります。明細を確認してください。`);
    if(unidentifiedSupplier(normalizeSupplier(first.counterpartyName)))issues.push('実際の仕入先名が未記録、または販売サイト名のみのため、他の商品とはまとめていません。');
    return {key,date:first.date,counterpartyName:first.counterpartyName,counterpartyAddress:text('counterpartyAddress'),counterpartyOccupation:text('counterpartyOccupation'),verification:text('verification'),transactionType:text('transactionType'),itemTypes:unique(items.map(r=>r.itemType)).join('・'),references:items.map(r=>r.managementNumber).join('\n'),products:items.length,quantity,purchaseAmount,shipping,total,amountBasis,issues};
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.counterpartyName.localeCompare(b.counterpartyName));
}
