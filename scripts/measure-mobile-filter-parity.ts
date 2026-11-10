import {performance} from 'node:perf_hooks';
import {mkdirSync,writeFileSync} from 'node:fs';
import {QuickSearchCatalog} from '../mobile/src/domain/quickSearch';
import {cachedSearchFields} from '../mobile/src/domain/search';
import {previewItems} from '../mobile/src/preview/fixture';
const results=[];
for(const count of [6000,18000]){
 const data=Array.from({length:count},(_,i)=>({...previewItems[i%3],id:'test-'+i,name:'チェア '+i,quantity:i%10}));
 const c=new QuickSearchCatalog();c.replace(data,0);const fields=cachedSearchFields(data,{sales:true,ecListing:true});
 const elapsed=[];const bytes=Buffer.byteLength(JSON.stringify(c.state()));
 for(let i=0;i<1000;i++){const start=performance.now();const result=c.search({q:String(i%37),advanced:{combinator:'AND',conditions:[{id:'qty',field:'quantity',operator:'eq',value:String(i%10)}]}},fields);if(!result)throw Error('No result');elapsed.push(performance.now()-start);}
 const warm=elapsed.slice(1).sort((a,b)=>a-b);const percentile=(p:number)=>+warm[Math.ceil(warm.length*p)-1].toFixed(3);
 results.push({items:count,trials:1000,firstMs:elapsed[0],p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),catalogBytes:bytes,additionalPersistedCatalogs:0});
}
const output={environment:'Windows Node; synthetic records; matching + sorting + pagination only, excludes network, React and physical iPhone',results};
mkdirSync('artifacts/pc-mobile-parity-20261110',{recursive:true});
writeFileSync('artifacts/pc-mobile-parity-20261110/filter-benchmark.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
