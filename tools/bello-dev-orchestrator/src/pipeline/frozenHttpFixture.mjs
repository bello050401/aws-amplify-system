import crypto from 'node:crypto';
export const FROZEN_HTTP_MODE='local-frozen-http-fixture';
export const FROZEN_HTTP_ACTIONS=Object.freeze(['navigate','reload','click','fill','screenshot']);
export const FIXTURE_OPERATIONS=Object.freeze(['claim','start-write','finish','report-error']);
export const isIsolatedLocalMode=mode=>mode==='local-next-isolated'||mode===FROZEN_HTTP_MODE;
export function validateSaleFixtureContract(s){
 const c=s?.fixtureContract,sha=v=>/^[a-f0-9]{64}$/.test(v??'');
 if(s.mode!==FROZEN_HTTP_MODE||s.framework!=='frozen-http-fixture'||s.desktopCua?.driver!=='desktop-cua'||c?.kind!=='sale-desktop-memory-v1'||c.syntheticMemoryOnly!==true||!(/^[a-f0-9]{40}$/).test(c.sourceHead??'')||c.runtimeEntry!=='runtime.cjs'||!sha(c.runtimeSha256)||!sha(c.serveSourceSha256)||!sha(c.componentSha256)||!sha(c.mainSha256)||c.projection!=='frozen-assets-unchanged-memory-handler')throw Error('Exact reviewed sale-desktop synthetic fixture contract required');
 const paths=Object.keys(c.assets??{}).sort();if(JSON.stringify(paths)!==JSON.stringify(['/','/fixture.svg','/style.css','/ui.js'])||Object.values(c.assets).some(v=>!sha(v)))throw Error('Exact frozen fixture asset hashes required');return c;
}
/** Serializable finite relay admission rule; it cannot authorize an arbitrary proxy route. */
export function admitSaleFixtureRequest(method,target,raw=''){
 const api='/api/sale-candidates/desktop-jobs';let url;try{url=new URL(target,'http://127.0.0.1');}catch{return false;}
 if(url.origin!=='http://127.0.0.1'||url.hash)return false;
 if(method==='GET'||method==='HEAD')return url.pathname===api?(url.search===''||url.search==='?inventoryId=fixture-stock'):['/','/ui.js','/style.css','/fixture.svg','/preview-status'].includes(url.pathname)&&!url.search;
 if(method!=='POST'||url.pathname!==api||url.search||Buffer.byteLength(raw)>8192)return false;
 let b;try{b=JSON.parse(raw);}catch{return false;}const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
 if(!object(b)||Object.keys(b).some(k=>!['id','action','lease','evidence','code'].includes(k))||!['1'.repeat(64),'2'.repeat(64)].includes(b.id)||!['claim','start-write','finish','report-error'].includes(b.action)||b.lease!==undefined&&b.lease!=='fixture-lease'||b.code!==undefined&&!['AUTH_REQUIRED','RATE_LIMITED','REMOTE_FORMAT_CHANGED','DESKTOP_OPERATION_FAILED'].includes(b.code))return false;
 if(!object(b.evidence))return false;const e=b.evidence,allowed=['snapshot','inventoryId','inventoryVersion','externalId','orderId','orderLineId','observedTitle','expectedImageKey','titleMatched','imageMatched','observedEvidenceRef','observedAt','observedQuantity','observedState'];if(Object.keys(e).some(k=>!allowed.includes(k)))return false;
 for(const [k,value] of Object.entries({snapshot:'fixture-snapshot',inventoryId:'fixture-stock',inventoryVersion:'v1',externalId:'fixture-mercari',orderId:'fixture-order',orderLineId:'1'}))if(e[k]!==value)return false;
 for(const k of ['observedTitle','observedEvidenceRef'])if(typeof e[k]!=='string'||e[k].length>2000||/[\x00-\x1f]/.test(e[k]))return false;
 if(!['','fixture-photo'].includes(e.expectedImageKey)||typeof e.titleMatched!=='boolean'||typeof e.imageMatched!=='boolean'||!Number.isFinite(Date.parse(e.observedAt))||e.observedQuantity!==undefined&&(!Number.isSafeInteger(e.observedQuantity)||e.observedQuantity<0||e.observedQuantity>100)||e.observedState!==undefined&&!['ACTIVE','STOPPED'].includes(e.observedState))return false;
 return true;
}
export const SALE_FIXTURE_SCHEMA_SHA256=crypto.createHash('sha256').update(admitSaleFixtureRequest.toString()).digest('hex');
export const SALE_FIXTURE_PATHS_SHA256=crypto.createHash('sha256').update(JSON.stringify(['/','/api/sale-candidates/desktop-jobs','/fixture.svg','/preview-status','/style.css','/ui.js'])).digest('hex');
