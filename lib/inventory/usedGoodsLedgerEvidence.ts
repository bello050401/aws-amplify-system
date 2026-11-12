/** Resolve ledger evidence from inventory records. Never use current stock as acquisition quantity. */
import {procurementFeature} from '../procurement/ledgerDetails';
type Source=Record<string,unknown>;
const text=(v:unknown)=>typeof v==='string'?v.trim():'';
const object=(v:unknown):Record<string,unknown>=>{try{return typeof v==='string'?object(JSON.parse(v)):v&&typeof v==='object'&&!Array.isArray(v)?v as Source:{};}catch{return {};}};
const integer=(v:unknown):number|null=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;
export const supplierKey=(v:unknown)=>text(v).normalize('NFKC').replace(/[\s　]+/g,' ').trim();
const genericSupplier=(v:string)=>!v||/^(ヤフオク!?|Yahoo!?オークション|メルカリ(?:Shops)?|BASE)$/i.test(v.replace(/\s/g,''));
export const ledgerAddressPlaceholder=(v:unknown)=>/^(?:履歴あり|同上|新品|中古|なし|不明|未登録|[-—ー])$/.test(text(v));
export function ledgerPublicName(v:unknown){return text(v).replace(/【[^】]*】/gu,'').replace(/(?:関連|検索用|検索ワード)\s*[:：].*$/u,'').replace(/[\s　]+/gu,' ').trim().replace(/[／/（(]+$/u,'').trim();}
export function ledgerDescription(source:Source){
 const title=ledgerPublicName(source.name);
 const categories=(Array.isArray(source.categoryNames)?source.categoryNames:[]).map(text).filter(v=>v&&!/(?:販売|出品|撮影|補修|修理|移動|確認|発送|出荷|出庫|入庫|配送|売り切れ|売却|予定|完了|待ち|破棄|廃棄|備品|自宅|委託|業者間|停止|オークション|リステージ|GPT|コーディネート|無償提供|保留|さん$)/.test(v));
 const kind=ledgerKind(title);
 return [...new Set([kind||text(source.usedGoodsItemType),...categories].filter(Boolean))].join('・')||title;
}
function ledgerKind(title:string){
 if(/コートハンガー|ポールハンガー|coat\s*(?:hanger|stand)/i.test(title))return 'コートハンガー';
 if(/(?:ペンダント|デスク|テーブル|フロア|スタンド)(?:ランプ|ライト)|照明|シャンデリア|\b(?:lamp|pendant light)\b/i.test(title))return '照明';
 return procurementFeature(title).match(/品目：([^／]+)/)?.[1];
}
export function ledgerFeature(source:Source){
 const c=object(source.customFields);const registered=text(c.usedGoodsFeature);
 // Older day-wide entries sometimes contain just '椅子 デスク 棚' for every lot.
 // Use the actual title for those classifications; retain individual condition details.
 const onlyKinds=registered&&/^(?:椅子|イス|チェア|机|デスク|棚|テーブル|照明|ライト|ソファ|雑貨|家具|[\s、,・／/])+$/u.test(registered);
 const title=ledgerPublicName(source.name),kind=ledgerKind(title),feature=procurementFeature(title);
 return (!onlyKinds&&registered)||(kind?feature.replace(/品目：[^／]+/,`品目：${kind}`):feature)||title;
}
/** Only a direct purchase memo with a quantity and a yen amount, never retail/offer prices. */
export function purchaseMemo(source:Source):{quantity:number;amount:number;excerpt:string}|null {
 const lines=text(source.note).normalize('NFKC').split(/\r?\n/);
 const matches=lines.flatMap(line=>{
   if(/定価|参考|販売|値下|提案|売価|見積|送料|税別|税抜|DKK|EUR|USD|ドル/.test(line))return [];
   const m=line.trim().match(/^(?:(?:仕入|購入)(?:れ)?(?:合計)?[：:]?\s*|椅子)?(\d+)(?:個|脚|点|台|灯|つ)(?:セット)?\s*(?:で|計|合計)\s*([\d,]+)\s*(万)?円?\s*$/u);
   if(!m)return [];
   const quantity=Number(m[1]),amount=Number(m[2].replace(/,/g,''))*(m[3]?10000:1);
   return quantity>0&&Number.isSafeInteger(amount)?[{quantity,amount,excerpt:line.trim()}]:[];
 });
 return matches.length===1?matches[0]:null;
}
export interface LedgerResolution {source:Source;references:string[]}
/** A same-name supplier is not enough for inferring a blank identity. Only resolve an
 * explicit 'history exists' pointer when all earlier records agree on one address. */
export function resolveLedgerSources(sources:Source[]):LedgerResolution[]{
 const prior=new Map<string,Source[]>();
 for(const s of sources){const k=supplierKey(s.counterpartyName);if(!genericSupplier(k))prior.set(k,[...(prior.get(k)||[]),s]);}
 return sources.map(s=>{
   const source={...s},references:string[]=[];
   if(/^履歴あり$/.test(text(s.counterpartyAddress))){
     const candidates=(prior.get(supplierKey(s.counterpartyName))||[]).filter(p=>text(p.transactionDate)&&text(p.transactionDate)<=text(s.transactionDate)&&text(p.counterpartyAddress)&&!ledgerAddressPlaceholder(p.counterpartyAddress));
     const addresses=[...new Set(candidates.map(p=>text(p.counterpartyAddress)))];
     if(addresses.length===1){source.counterpartyAddress=addresses[0];const p=candidates.sort((a,b)=>text(b.transactionDate).localeCompare(text(a.transactionDate)))[0];references.push(`住所：同一仕入先の登録履歴 ${text(p.sourceInventoryId)||text(p.sku)||text(p.id)}（${text(p.transactionDate)}）`);}
   }
   // A blank may be an intentional deletion. Never rehydrate it from old snapshots.
   return {source,references};
 });
}
export function legacyRecordedAmount(source:Source):{amount:number|null;basis:string}{
 const price=integer(source.purchasePrice),memo=purchaseMemo(source);
 if(price===null)return {amount:null,basis:'購入価格が未記録'};
 if(memo&&memo.amount===price)return {amount:price,basis:`備考と購入価格が一致：${memo.excerpt}`};
 if(price===0)return {amount:0,basis:'登録購入価格0円'};
 const quantity=integer(source.quantity);
 if(quantity!==null&&quantity>0&&Number.isSafeInteger(price*quantity))return {amount:price*quantity,basis:`登録購入単価 ${price.toLocaleString()}円 × 在庫の数量 ${quantity}点（指定された集計方法）`};
 const pluralTitle=[...text(source.name).normalize('NFKC').matchAll(/(\d+)(?:個|脚|点|台|灯)(?:セット|山)/g)].some(m=>Number(m[1])>1);
 if(integer(source.purchaseQuantity)===1&&!(Number(source.quantity)>1)&&!pluralTitle)return {amount:price,basis:'購入価格×仕入数量1点（複数在庫・セット表記との矛盾なし）'};
 // Empty current quantity contributes zero to the displayed stock count, but does
 // not prove that the historical purchase itself was free.
 return {amount:null,basis:`登録購入価格 ${price.toLocaleString()}円。数量欄が空欄または0のため、元の購入金額は日次合計・取込情報・備考から確定できません`};
}

/** A date and a price alone do not constitute a completed goods-ledger entry.
 * Preserve any existing dedicated ledger information, including partial entries. */
export function hasRecordedLedgerEntry(source:Source):boolean {
 return ['transactionType','usedGoodsItemType','purchaseQuantity','dailyPurchaseTotal','counterpartyName','counterpartyAddress','counterpartyOccupation','identityVerificationMethod']
  .some(k=>source[k]!==undefined&&source[k]!==null&&String(source[k]).trim()!=='')||!!text(object(source.customFields).usedGoodsFeature);
}

/** Only positively identified ordinary furniture is eligible for automatic omission.
 * Unknown goods and statutory exceptions stay in the output. Threshold is strictly
 * below JPY 10,000 for the whole purchase, not per-unit price. */
export function ordinaryFurnitureForLedger(source:Source):boolean {
 const name=ledgerPublicName(source.name);
 if(/バイク|オートバイ|二輪|原付|室外機|室外ユニット|ヒートポンプ|電線|グレーチング|ゲーム|ソフト|\b(?:CD|DVD|Blu.?ray)\b|書籍|古本|画集|写真集|ブック|美術品|骨董|絵画|宝石|貴金属|時計/i.test(name))return false;
 return /椅子|チェア|スツール|ソファ|テーブル|デスク|机|棚|シェルフ|キャビネット|チェスト|ボード|ワゴン|照明|ランプ|ライト|ハンガー|ベッド|bench|chair|stool|sofa|table|desk|cabinet|shelf|lamp/i.test(name);
}
