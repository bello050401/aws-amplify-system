/** Only the stock count inside an internal memo changes. Preserve all other notes and units. */
export function stockCountTitle(title:string,quantity:number):string {
 if(!Number.isSafeInteger(quantity)||quantity<0)return title;
 return title.replace(/【[^【】]*】/gu,note=>note.replace(/(在庫\s*[:：]?\s*)[0-9０-９]+/gu,(_match,prefix:string)=>prefix+quantity));
}
