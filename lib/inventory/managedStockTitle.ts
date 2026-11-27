type Row=Record<string,unknown>;
export function titleCustomFields(value:unknown):Row {
  if(typeof value==='string'){try{return titleCustomFields(JSON.parse(value));}catch{throw Error('在庫タイトルの管理情報を読み取れません。');}}
  return value&&typeof value==='object'&&!Array.isArray(value)?{...value}:{};
}
export function stockTitleQuantity(quantity:unknown):number {
  if(typeof quantity!=='number'||!Number.isSafeInteger(quantity)||quantity<0)throw Error('在庫数量は0以上の整数で指定してください。不明な数量は確認が必要です。');
  return quantity;
}
const prefixFor=(q:number)=>q>=2?`【在庫${q}】`:'';
export const STOCK_TITLE_META='__belloStockTitle';
const salePrefixFor=(meta:Row)=>typeof meta.salePrefix==='string'&&/^【(?:BASE|ヤフオク|メルカリショップ)】$/.test(meta.salePrefix)?meta.salePrefix:
 typeof meta.prefix==='string'?meta.prefix.match(/^【(?:BASE|ヤフオク|メルカリショップ)】/)?.[0]??'':'';
/** Provenance-managed count markers can move when staff prepend dates/notes.
 * Only whole, top-level numeric markers belong to the generated title syntax. */
function withoutManagedMarkers(title:string,meta:Row):string {
 const salePrefix=salePrefixFor(meta);
 let depth=0,base='',removedSalePrefix=false;
 for(let i=0;i<title.length;){
  // Only the first top-level generated channel marker belongs to this prefix.
  // A nested occurrence is part of a human note, not title-management syntax.
  if(depth===0&&salePrefix&&!removedSalePrefix&&title.startsWith(salePrefix,i)){
   i+=salePrefix.length;removedSalePrefix=true;continue;
  }
  const marker=depth===0?title.slice(i).match(/^【在庫[0-9]+】/):null;
  if(marker){i+=marker[0].length;continue;}
  const character=title[i++];
  if(character==='【')depth++;else if(character==='】')depth=Math.max(0,depth-1);
  base+=character;
 }
 return base;
}
export function managedTitleBase(title:string,row:Row):string {
 const meta=titleCustomFields(titleCustomFields(row.customFields)[STOCK_TITLE_META]);
 return meta?.version===1&&typeof meta.baseName==='string'&&typeof meta.prefix==='string'?withoutManagedMarkers(title,meta):title;
}
export function hasManagedStockTitle(row:Row):boolean{return titleCustomFields(titleCustomFields(row.customFields)[STOCK_TITLE_META]).version===1;}
/** Only this explicit provenance grants permission to replace a prefix. */
export function importedStockTitle(baseName:string,quantity:unknown,unit:string,source:string) {
  const q=stockTitleQuantity(quantity);
  if(!baseName.trim()||!unit.trim())throw Error('商品名と数量の単位を確認してください。');
  return {name:prefixFor(q)+baseName,metadata:{version:1,baseName,prefix:prefixFor(q),lastQuantity:q,sourceQuantity:q,unit,source}};
}
export function managedStockTitleChange<T extends Row>(input:T,current?:Row):T & Row {
  const oldCustom=titleCustomFields(current?.customFields),nextCustom=input.customFields===undefined?oldCustom:titleCustomFields(input.customFields);
  const meta=titleCustomFields(oldCustom[STOCK_TITLE_META]??nextCustom[STOCK_TITLE_META]);
  if(meta?.version!==1||typeof meta.baseName!=='string'||typeof meta.prefix!=='string')return input;
  const q=stockTitleQuantity(input.quantity===undefined?current?.quantity:input.quantity);
  const title=input.name===undefined?String(current?.name??meta.prefix+meta.baseName):String(input.name);
  const base=withoutManagedMarkers(title,meta);
  const salePrefix=salePrefixFor(meta);
  const next={...meta,baseName:base,prefix:salePrefix+prefixFor(q),lastQuantity:q};
  return {...input,name:next.prefix+base,customFields:JSON.stringify({...nextCustom,[STOCK_TITLE_META]:next})};
}
