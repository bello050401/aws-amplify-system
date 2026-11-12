import type {UsedGoodsLedger} from './usedGoodsLedger';

/** Export-local reference numbers join the printed summary and full descriptions.
 * They are not inventory IDs, a new purchase record, or a statement of legal compliance. */
export function ledgerPresentation(ledger:UsedGoodsLedger) {
  const receipts=new Map(ledger.rows.filter(r=>r.direction==='受入れ').map(r=>[r.inventoryId,r]));
  const groups=ledger.supplierDays.map((group,index)=>{
    const members=group.inventoryIds.map(id=>receipts.get(id)).filter((r):r is NonNullable<typeof r>=>!!r);
    const flags:string[]=[];
    if(group.quantity===null)flags.push('数量の記録不正');
    if(group.total===null)flags.push('金額未確定');
    else if(group.purchaseAmount===null||group.shipping===null)flags.push('金額内訳未確定');
    if(members.some(r=>!r.counterpartyName))flags.push('仕入先未記録');
    if(members.some(r=>!r.counterpartyAddress||r.issues.some(x=>/住所/.test(x))))flags.push('住所の記録不足');
    if(members.some(r=>!r.feature))flags.push('特徴未記録');
    if(members.some(r=>!r.verification))flags.push('本人確認方法未記録');
    if(members.some(r=>!r.counterpartyOccupation))flags.push('職業未記録');
    if(members.some(r=>!r.transactionType))flags.push('取引区分未記録');
    if(group.issues.some(x=>/複数|不一致|混在|販売サイト/.test(x)))flags.push('記録の不一致');
    if(members.some(r=>r.issues.some(x=>/削除済み|在庫合算/.test(x))))flags.push('元商品の状態を照合');
    if(group.total!==null&&/商品別の仕入数量/.test(group.amountBasis)&&members.some(r=>/在庫の数量/.test(r.amountBasis)))flags.push('在庫数量で金額算出');
    return {...group,ledgerNo:`${ledger.year}-${String(index+1).padStart(3,'0')}`,recordStatus:[...new Set(flags)].join('\n')||'登録情報あり'};
  });
  const byInventoryId=new Map(groups.flatMap(g=>g.inventoryIds.map(id=>[id,g] as const)));
  const amountKnown=groups.filter(g=>g.total!==null);
  return {groups,byInventoryId,knownAmount:amountKnown.reduce((n,g)=>n+g.total!,0),unknownAmountCount:groups.length-amountKnown.length,knownAmountCount:amountKnown.length};
}
