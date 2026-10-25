import {inventoryCategoryIds,type CategoryRecord} from '../inventory/categories';
export function normalizeSaleName(s:string){return s.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/g,' ').trim();}
export function suggestedSaleQuery(s:string){const clean=s.normalize('NFKC').replace(/【[^】]*】/g,' ').split(/\s+\/\s+/)[0].trim();return clean||s.trim();}
export function saleNameScore(name:string,q:string){
 const n=normalizeSaleName(name),raw=normalizeSaleName(q),key=normalizeSaleName(suggestedSaleQuery(q));
 if(n===raw)return 10000;if(normalizeSaleName(suggestedSaleQuery(name))===key)return 9000;
 if(n.includes(raw))return 8000;if(n.includes(key))return 7000;
 const words=key.split(/[\s/]+/).filter(w=>w.length>1);if(!words.length)return 0;
 const hits=words.filter(w=>n.includes(w)).length;return hits>=Math.min(2,words.length)?Math.round(hits/words.length*1000):0;
}
export function saleProductScope(masters:readonly {id:string;name:string}[]){
 const names=[['販売中','出品中'],['出品待ち'],['撮影待ち'],['補修待ち']];
 const priority=names.map(ns=>masters.filter(m=>ns.includes(m.name)).map(m=>m.id));
 const rank=(r:CategoryRecord)=>priority.findIndex(ids=>ids.some(id=>inventoryCategoryIds(r).includes(id)));
 return {priority,categoryIds:priority.flat(),rank,label:(r:CategoryRecord)=>['販売中','出品待ち','撮影待ち','補修待ち'][rank(r)]??null};
}
