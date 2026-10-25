const assert=require('node:assert/strict'),esbuild=require('esbuild'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');let f;
function reset(){f={row:null,remote:null,events:[],failSend:false,failVerify:false,actor:'admin',prepared:{fields:{products_name:'テスト',products_price:'999999',products_quantity:'2',mercariShops_name:'テスト',mercariShops_price:'999999'},refs:[{storageKey:'one.jpg'}],fingerprint:'hash',option:{},shippingLabel:'佐川急便',quantity:2}};}
const mocks={
 'server-only':'',sharp:'export default ()=>({metadata:async()=>({format:"jpeg"})});',
 '../service':'export const getListingDraftForInventory=async()=>({id:"draft"});export const getChannelListing=async()=>null;',
 '@/lib/inventory/queries':'export const getInventoryDetail=async()=>({id:"inventory-one",quantity:5,displayId:"B001"});',
 '@/app/actions/yahooAuctionPreparation':'export const getYahooAuctionPreparationAction=async()=>({ok:true,context:{canPrepare:true,saved:null}});',
 '../mercari/csv/buildExportRows':'export const resolveListingImageDownloadUrl=async()=>"https://owned.test/one.jpg";',
 './credentials':'export const econveniCredentialStore={credentials:async()=>({loginId:"fixture",password:"fixture"})};',
 './mapping':'export class EconveniPreparationError extends Error{};export const prepareEconveniProduct=()=>structuredClone(f().prepared);',
 './runtimeStore':`export const econveniStore=()=>({read:async()=>structuredClone(f().row),acquire:async()=>{f().events.push('lock')},release:async()=>{},stop:async()=>{},commit:async(p,n,send=false)=>{if(send)f().events.push('reserve');f().row=structuredClone({...n,revision:(p?.revision??0)+1});return structuredClone(f().row)}});`,
 './httpSession':`export class EconveniHttpError extends Error{constructor(code){super(code);this.code=code}};export class EconveniHttpSession{
 async login(){f().events.push('login')}dispose(){}async readInventory(){return structuredClone(f().remote)}async assertNoExistingTitle(){}async preflightSave(){}
 async registrationForm(){return {fields:[{name:'yahoo_setting_id',options:[{label:'佐川急便',value:'22024'}]},{name:'yahoo_information_id',options:[{label:'テンプレ',value:'8297'}]},{name:'mercariShops_setting_id',options:[{label:'名前配送',value:'133'}]}]}}
 async ensureYahooOption(){assert.equal(f().row.save.state,'PENDING');f().events.push('option');return '24829'}
 async saveProduct(id,op,fields,files){assert.equal(f().row.save.state,'PENDING');assert.equal(f().row.save.expected.fields.yahoo_setting_id,'24829');f().events.push('save');f().remote={productId:'123',operationId:op,url:'https://smart.e-conveni.net/product.php?action=product_update&products_id=123',channels:f().remote?.channels??{YAHOO:{state:'INACTIVE',listingId:null,listingUrl:null},MERCARI_SHOPS:{state:'INACTIVE',listingId:null,listingUrl:null}}}}
 async verifySavedProduct(){return !f().failVerify}
 async publicationPreview(x){f().events.push('preview:'+x.channel+':'+x.operation);return x}
 async executeCommand(x){assert.equal(f().row.channels[x.channel].state,'PENDING');f().events.push('send:'+x.channel+':'+x.operation);if(f().failSend)throw new EconveniHttpError('NETWORK');f().remote.channels[x.channel]={state:x.operation==='PUBLISH'?'ACTIVE':'INACTIVE',listingId:'external-'+x.channel,listingUrl:'https://example.test/'+x.channel}}
 }`,
};
async function main(){
 const result=await esbuild.build({entryPoints:[path.join(root,'lib/listing/econveni/service.ts')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',plugins:[{name:'fixtures',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'fixture'}:null);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js'}));}}]});
 const sandbox={module:{exports:{}},exports:{},require,Buffer,AbortSignal,structuredClone,console,assert,f:()=>f,fetch:async()=>new Response(Buffer.from('test-image'))};sandbox.exports=sandbox.module.exports;vm.runInNewContext(result.outputFiles[0].text,sandbox);const api=sandbox.module.exports;
 reset();assert.equal((await api.saveEconveniDraft('inventory-one')).status,'DONE');assert.equal(f.events.filter(e=>e==='save').length,1);assert.ok(!f.events.some(e=>e.startsWith('send:')),'Saving a draft must never publish');
 assert.equal((await api.saveEconveniDraft('inventory-one')).status,'DONE');assert.equal(f.events.filter(e=>e==='save').length,1);
 const yahoo=await api.econveniOperation('inventory-one','YAHOO','PUBLISH','admin'),shops=await api.econveniOperation('inventory-one','MERCARI_SHOPS','PUBLISH','admin');assert.equal(yahoo.status,'READY');assert.equal(shops.status,'READY');
 assert.equal((await api.econveniOperation('inventory-one','YAHOO','PUBLISH','other',yahoo.token,true)).status,'BLOCKED');
 assert.equal((await api.econveniOperation('inventory-one','YAHOO','PUBLISH','admin',yahoo.token,false)).status,'BLOCKED');
 assert.equal((await api.econveniOperation('inventory-one','YAHOO','PUBLISH','admin',yahoo.token,true)).status,'DONE');
 assert.equal((await api.econveniOperation('inventory-one','MERCARI_SHOPS','PUBLISH','admin',shops.token)).status,'DONE');
 assert.equal(f.events.filter(e=>e==='save').length,1,'One saved product prepares both channels');
 const stop=await api.econveniOperation('inventory-one','MERCARI_SHOPS','STOP','admin');assert.match(stop.message,/削除/);
 assert.equal((await api.econveniOperation('inventory-one','MERCARI_SHOPS','STOP','admin',stop.token)).status,'DONE');assert.equal(f.row.channels.YAHOO.remoteStatus,'ACTIVE','Individual stop must not affect the other EC');
 await api.econveniOperation('inventory-one','MERCARI_SHOPS','STOP','admin',stop.token);assert.equal(f.events.filter(e=>e==='send:MERCARI_SHOPS:STOP').length,1);
 f.prepared.fingerprint='changed';assert.equal((await api.econveniOperation('inventory-one','YAHOO','PUBLISH','admin',yahoo.token,true)).status,'BLOCKED');
 reset();await api.saveEconveniDraft('inventory-one');const approval=await api.econveniOperation('inventory-one','YAHOO','PUBLISH','admin');f.failSend=true;
 await api.econveniOperation('inventory-one','YAHOO','PUBLISH','admin',approval.token,true);await api.econveniOperation('inventory-one','YAHOO','PUBLISH','admin',approval.token,true);
 assert.equal(f.events.filter(e=>e==='send:YAHOO:PUBLISH').length,1,'Unknown sends only reconcile');
 reset();f.failVerify=true;assert.equal((await api.saveEconveniDraft('inventory-one')).status,'BLOCKED');await api.saveEconveniDraft('inventory-one');assert.equal(f.events.filter(e=>e==='save').length,1,'Failed save verification cannot cause a new product');
 console.log('PASS: draft save prepares without publishing; unchanged save reuses; one product prepares both ECs; actor/terms/source guards; per-EC stop preserves other EC; repeat/timeout sends once; failed verification never claims success');
}
main().catch(e=>{console.error(e);process.exitCode=1});
