import { parse } from 'parse5';
import { procurementPurchasePrice } from './pricing';
import { procurementLedgerDetails } from './ledgerDetails';

export const RESTAGE_ORIGIN = 'https://real.next-restage.co.jp';
export {completeRestageDraft,RESTAGE_ITEM_TYPES} from './restageDraft';
export type {RestageLot,RestageDraft,RestageEdit} from './restageDraft';
import {completeRestageDraft,type RestageLot,type RestageDraft} from './restageDraft';
type Node = {tagName?:string;nodeName?:string;value?:string;attrs?:{name:string;value:string}[];childNodes?:Node[]};
const attr=(n:Node,key:string)=>n.attrs?.find(a=>a.name===key)?.value??'';
const walk=(n:Node):Node[]=>[n,...(n.childNodes??[]).flatMap(walk)];
const text=(n:Node):string=>n.nodeName==='#text'?n.value??'':(n.childNodes??[]).map(text).join('');
const clean=(n:Node)=>text(n).replace(/\s+/g,' ').trim();

export function assertAuctionDate(value:string) {
  const parsed=new Date(value+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value) throw Error('開催日を選択してください。');
  if(value>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})) throw Error('未来の開催日は取得できません。');
}
export function classifyItem(name:string):string {
  const groups=[['テーブル',/テーブル|デスク|机|table|desk/i],['椅子',/チェア|椅子|スツール|ソファ|ベンチ|chair|stool|sofa|bench/i],['棚',/棚|ラック|キャビネット|サイドボード|ローボード|食器棚|チェスト|書庫|シェルフ|cabinet|shelf/i],['照明',/照明|ランプ|ライト|シャンデリア|lamp|light/i]] as const;
  const matches=groups.filter(([,pattern])=>pattern.test(name));
  if(matches.some(([label])=>label==='照明')) return '照明';
  return matches.length===1?matches[0][0]:'その他';
}
export function lotQuantity(name:string,sourceQuantity:string) {
  const title=name.normalize('NFKC'), raw=sourceQuantity.normalize('NFKC').replace(/\s/g,'');
  // A bare "1山" is a lot count, never the number of individual pieces.
  const pattern=/(\d[\d,]*)\s*(点|脚|台|個|枚|本|組|セット|式)\s*(?:まとめて\s*)?(?:一山|山)/g;
  const candidates=[...title.matchAll(pattern),...raw.matchAll(pattern)];
  if(new Set(candidates.map(m=>Number(m[1].replace(/,/g,'')))).size>1)throw Error('一山の数量表記が複数あります。数量を入力してください。');
  const bundle=candidates[0];
  if((/一山|(?:点|脚|台|個|枚|本|組|セット|式)\s*山|\d\s*山/.test(title)||/山$/.test(raw))&&!bundle) throw Error('一山の点数が不明です。数量を入力してください。');
  const match=bundle??raw.match(/^([\d,]+)(台|脚|点|個|枚|本|組|セット|式)$/);
  const quantity=Number(match?.[1].replace(/,/g,''));
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>100000) throw Error('落札数量を読み取れません。');
  return {quantity,isBundle:!!bundle,unit:match![2]};
}
export function purchaseUnitPrice(hammerPrice:number,quantity:number,isBundle:boolean) {
  if(!Number.isSafeInteger(hammerPrice)||hammerPrice<=0||hammerPrice>100000000||!Number.isSafeInteger(quantity)||quantity<1) throw Error('落札価格または数量が不正です。');
  return procurementPurchasePrice('RESTAGE',hammerPrice,quantity,isBundle);
}
export function validateImageUrl(raw:string,goodsId:string) {
  const url=new URL(raw,RESTAGE_ORIGIN+'/restage/goodslist.action');
  if(url.origin!==RESTAGE_ORIGIN||url.pathname!=='/restage/common.action'||url.searchParams.get('action')!=='get_image'||url.searchParams.get('imageKey')!==goodsId+'/1.png') throw Error('1枚目の写真を確認できません。');
  return url.href;
}
export function parseRestageLots(html:string,date:string) {
  assertAuctionDate(date);
  const nodes=walk(parse(html) as Node), byId=(id:string)=>nodes.find(n=>attr(n,'id')===id);
  if(attr(byId('listCbn')??{},'value')!=='5'||attr(byId('conditionDate')??{},'value')!==date.replaceAll('-','/')) throw Error('自社落札・開催日の絞り込みを確認できません。登録を中止しました。');
  const maxPage=Number(attr(byId('maxPage')??{},'value')),page=Number(attr(byId('page')??{},'value'));
  if(!Number.isInteger(maxPage)||maxPage<0||maxPage>50||!Number.isInteger(page)||page<1) throw Error('落札一覧のページ数を確認できません。');
  const body=nodes.find(n=>n.tagName==='tbody'&&attr(n,'class').includes('table-body'));
  const rows=(body?.childNodes??[]).filter(n=>n.tagName==='tr');
  if(rows.length%2) throw Error('落札一覧の形式が変わっています。登録を中止しました。');
  const lots:RestageLot[]=[],drafts:RestageDraft[]=[],errors:{goodsId:string;name:string;error:string}[]=[];
  for(let i=0;i<rows.length;i+=2){
    const cells=(rows[i].childNodes??[]).filter(n=>n.tagName==='td'),sub=(rows[i+1].childNodes??[]).filter(n=>n.tagName==='td');
    const goodsId=clean(cells[0]??{}),name=clean(cells[6]??{});
    try{
      // Own-winning-lots also includes accepted one-chance purchases. Both
      // statuses have a confirmed hammer price; unsold/unauctioned rows do not.
      if(cells.length!==11||sub.length!==7||!/^\d{1,12}$/.test(goodsId)||clean(cells[1])!==date.replaceAll('-','/')||!['落札','ワンチャンス'].includes(clean(cells[9]))||!name) throw Error('開催日・商品ID・落札結果を確認できません。');
      const sourceQuantity=clean(cells[7]),price=clean(sub[5]).normalize('NFKC'),issues:string[]=[];
      let q:{quantity:number|null;isBundle:boolean;unit:string}={quantity:null,isBundle:/山/.test(name+' '+sourceQuantity),unit:'点'};
      try{q=lotQuantity(name,sourceQuantity);}catch(e){issues.push((e as Error).message);}
      const hammerPrice=/^[\d,]+円$/.test(price)?Number(price.replace(/[円,]/g,'')):null;
      if(!hammerPrice||!Number.isSafeInteger(hammerPrice)||hammerPrice>100000000)issues.push('落札価格を確認して入力してください。');
      const img=walk(cells[4]).find(n=>n.tagName==='img');
      const draft:RestageDraft={goodsId,date,name,sourceQuantity,...q,hammerPrice,purchasePrice:null,itemType:classifyItem(name),imageUrl:validateImageUrl(attr(img??{},'src'),goodsId),lotNumber:clean(sub[0]),issues};
      if(!issues.length){const lot=completeRestageDraft(draft);lots.push(lot);draft.purchasePrice=lot.purchasePrice;}
      drafts.push(draft);
    }catch(error){errors.push({goodsId,name,error:error instanceof Error?error.message:'読取エラー'});}
  }
  if(!body&&!nodes.some(n=>n.tagName==='div'&&clean(n)==='対象商品が見つかりませんでした。')) throw Error('落札一覧を取得できません。ログイン状態を確認してください。');
  return {lots,drafts,errors,maxPage,page};
}

export function restageInventoryFields(lot:RestageLot){
  return {name:lot.name,quantity:lot.quantity,unit:lot.unit,purchasePrice:lot.purchasePrice,transactionDate:lot.date,purchaseQuantity:lot.quantity,usedGoodsItemType:lot.itemType,transactionType:'買受',...procurementLedgerDetails(lot.name),counterpartyName:'リステージオークション',counterpartyAddress:'履歴あり',
    adminMemo:`リステージ 商品ID:${lot.goodsId} 出品番号:${lot.lotNumber}\n開催日:${lot.date}／落札価格:${lot.hammerPrice}円／表示数量:${lot.sourceQuantity}\n購入単価:${lot.hammerPrice}×1.188${lot.isBundle?'÷'+lot.quantity:''}（1円未満四捨五入）`};
}
