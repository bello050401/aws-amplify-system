import {sha} from './sources';
import {EXTRACTION_VERSION,type ExtractionResult} from './types';

/** Joining is allowed only after the staff explicitly selected the source
 * hashes for this product. No attachment/row association is inferred by title. */
export function combineSelectedResults(results:ExtractionResult[]):ExtractionResult{
 if(!results.length||results.length>3)throw Error('SOURCE_SELECTION_INVALID');
 const first=results[0],identity=JSON.stringify(first.source.identity);
 if(results.some(r=>JSON.stringify(r.source.identity)!==identity||r.version!==EXTRACTION_VERSION))throw Error('SOURCE_IDENTITY_MISMATCH');
 const joined:ExtractionResult={version:EXTRACTION_VERSION,source:{...first.source,hash:sha(results.map(r=>r.source.hash).join('|')),format:'restage-selected-documents-v1',complete:results.every(r=>r.source.complete),targetVerified:results.every(r=>r.source.targetVerified),blocks:[],issues:[]},state:'REVIEW',dimensions:[],defects:[],remarks:[],issues:[]};
 results.forEach((r,i)=>{const id=(s:string)=>'p'+i+'-'+s;
  joined.source.blocks.push(...r.source.blocks.map(b=>({...b,id:id(b.id),page:i+1,imageId:b.imageId||r.source.hash})));
  joined.dimensions.push(...r.dimensions.map(d=>({...d,id:id(d.id),blockId:id(d.blockId)})));
  joined.defects.push(...r.defects.map(d=>({...d,id:id(d.id),blockId:id(d.blockId)})));
  joined.remarks!.push(...(r.remarks||[]).map(d=>({...d,blockId:id(d.blockId)})));
  joined.issues.push(...r.issues.map(s=>'資料'+(i+1)+'：'+s));
 });
 for(const axis of new Set(joined.dimensions.map(d=>d.axis))){const rows=joined.dimensions.filter(d=>d.axis===axis&&d.disposition==='ACCEPT');if(new Set(rows.map(d=>d.mm)).size>1)rows.forEach(d=>{d.disposition='REVIEW';d.reason='複数の資料で同じ項目の寸法が一致しません';});}
 joined.source.issues=[...joined.issues];return joined;
}
