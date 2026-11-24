const {build}=require('esbuild'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
 const real=new Set(['./app/api/sale-candidates/desktop-jobs/route','@/lib/saleCandidates/desktopBoundary','@/lib/saleCandidates/desktopIdentification','@/lib/saleCandidates/recordedMercariSale','@/lib/saleCandidates/desktopJobModel','./desktopJobModel','../listing/econveni/manualSyncModel','@/lib/listing/econveni/manualSyncModel','@/lib/listing/mercariBridge/postGuard']);
 const built=await build({stdin:{contents:"export {POST} from './app/api/sale-candidates/desktop-jobs/route';export {newDesktopJob,claimDesktopJob,finishDesktopJob,recordDesktopIssue} from '@/lib/saleCandidates/desktopJobModel';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'actual-identification-route',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'||real.has(a.path)?undefined:{path:a.path,external:true});}}]});
 let job,candidate,item,binding,soldRows,evidence,reports,issues,finishes,links,holds;
 const modules={
  'node:crypto':require('node:crypto'),'@aws-sdk/lib-dynamodb':require('@aws-sdk/lib-dynamodb'),
  'next/server':{NextResponse:{json:(body,options)=>new Response(JSON.stringify(body),options)}},
  '@/lib/inventory/mutationSession':{inventoryMutationSession:async()=>({role:'ADMIN',owner:'admin'})},
  '@/lib/inventory/categoryPersistence':{inventoryTable:n=>n,getInventoryRaw:async()=>item,inventoryDdb:{send:async()=>{if(soldRows===null)throw Error('PRIVATE_STORAGE_DETAIL');return {Items:soldRows};}}},
  '@/lib/listing/econveni/runtimeStore':{ECONVENI_WORKFLOW_TABLE:'ec',econveniStore:()=>({read:async()=>null})},
  '@/lib/listing/econveni/manualSync':{readManualSync:async()=>({links:[{inventoryId:item.id,productId:'product-1',revision:1,baseline:{MERCARI_SHOPS:{listingId:binding}}}]})},
  '@/lib/listing/econveni/saleAdjustment':{reviewSaleBinding:async()=>({remote:{productId:'product-1',channels:{MERCARI_SHOPS:{listingId:binding}}}})},
  '@/lib/listing/econveni/saleBindingError':{SaleBindingError:class extends Error{}},
  '@/lib/listing/econveni/httpSession':{EconveniHttpError:class extends Error{}},
  '@/lib/listing/econveni/workflowStore':{EconveniWorkflowError:class extends Error{}},
  '@/lib/saleCandidates/desktopImagePreviews':{signDesktopImage:async()=>'/synthetic.jpg'},
  '@/lib/saleCandidates/desktopJobs':{desktopImageKeys:async()=>['inventory/natural.jpg'],desktopCompletionWakes:async()=>[],refreshDesktopJobAfterYahooPayment:async j=>j,holdRecordedMercariIdentification:async()=>{holds++;job={...job,state:'ATTENTION',reason:'MERCARI_ORDER_ALREADY_RECORDED'};},desktopJobs:{get:async()=>job,recordIssue:async(id,actor,lease,code)=>{job=module.exports.recordDesktopIssue(job,actor,lease,code,Date.now());issues.push(code);return job;},finish:async(id,actor,lease,e,checks)=>{finishes++;assert(checks.some(w=>w.ConditionCheck?.TableName==='Inventory'));assert(checks.some(w=>w.Put?.Item?.mercariDesktopIdentity));job=module.exports.finishDesktopJob(job,actor,lease,e,Date.now());return job;}}},
  '@/lib/saleCandidates/store':{candidateConfig:()=>({tableName:'candidates'}),candidateBuildRelease:()=> 'cab3e2fd',candidateStore:()=>({get:async()=>candidate})},
  '@/lib/invoicing/gateway':{NO_STORE:{'cache-control':'no-store'},bodyLimited:r=>r.json()},
  '@/lib/saleCandidates/saleBinding':{ensureAutomaticSaleBinding:async()=>{links++;return true;}},
  '@/lib/saleCandidates/errorReporting':{reportSaleAutomationFailure:async(id,phase,reason)=>{reports.push({id,phase,reason});return true;}},
 };
 const module={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:name=>{if(!(name in modules))throw Error('Unexpected dependency '+name);return modules[name];},Date,Map,Set,URL,Request,Response,console,process:{env:{}}});
 function reset(){
  const at=new Date().toISOString(),title='Magis Tom The Wild Bunch';
  candidate={id:'a'.repeat(64),state:'PENDING',channel:'MERCARI',source:'GMAIL',senderAuthenticated:true,name:title,quantity:1,unitPrice:24800,orderId:'order-fixture',orderLineId:'',mercariOrderUrl:'https://mercari-shops.com/seller/shops/shop/orders/fixture',mercariShopId:'shop',updatedAt:at};
  item={id:'inventory-natural',name:'【在庫5】Magis Tom - The Wild Bunch',updatedAt:at};binding='mercari-natural';soldRows=[];reports=[];issues=[];finishes=0;links=0;holds=0;
  job=module.exports.claimDesktopJob(module.exports.newDesktopJob({purpose:'IDENTIFY_SALE',candidateId:candidate.id,inventoryId:'UNRESOLVED',inventoryVersion:'UNRESOLVED',externalId:'ORDER:'+candidate.orderId,title,imageKeys:[],orderId:candidate.orderId,orderLineId:'',orderUrl:candidate.mercariOrderUrl,shopId:candidate.mercariShopId,soldQuantity:1,unitPrice:24800},Date.now()),'admin',Date.now());
  evidence={snapshot:job.snapshot,externalId:binding,inventoryId:item.id,inventoryVersion:item.updatedAt,orderId:candidate.orderId,orderLineId:'',observedTitle:title,expectedImageKey:'inventory/natural.jpg',titleMatched:true,imageMatched:true,observedEvidenceRef:'screenshots/fixture-order.jpg',observedAt:new Date().toISOString()};
 }
 const post=()=>module.exports.POST(new Request('http://localhost/api/sale-candidates/desktop-jobs',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json','x-bello-sale-desktop':'1'},body:JSON.stringify({id:job.id,action:'finish',lease:job.lease,evidence})}));
 reset();let response=await post(),body=await response.json();assert.equal(response.status,200);assert.equal(body.job.state,'COMPLETE');assert.equal(finishes,1);assert.equal(links,1);assert.equal(reports.length,0);
 for(const [change,code,issue] of [
  [()=>{binding='mercari-black';},'DESKTOP_BINDING_REQUIRED','BINDING_REQUIRED'],
  [()=>{item.name='Magis Tom Black';},'DESKTOP_TITLE_MISMATCH','TITLE_MISMATCH'],
  [()=>{item.updatedAt='new-version';},'DESKTOP_STALE_INVENTORY','INVENTORY_CHANGED'],
  [()=>{evidence.expectedImageKey='inventory/black.jpg';},'DESKTOP_IMAGE_CHANGED','IMAGE_CHANGED'],
  [()=>{candidate.quantity=2;},'DESKTOP_ORDER_CHANGED','ORDER_CHANGED'],
  [()=>{soldRows=null;},'MERCARI_RECORDED_SALE_CHECK_UNAVAILABLE','RECORDED_SALE_CHECK_FAILED'],
 ]){
  reset();change();response=await post();body=await response.json();assert.equal(response.status,409);assert.equal(body.code,code);assert.equal(body.reported,true);assert.deepEqual(issues,[issue]);assert.equal(reports[0].reason,'DESKTOP_'+issue);assert.equal(finishes,0);assert.equal(links,0);assert.equal(holds,0);assert(!JSON.stringify(body).includes('mercari-black'));
 }
 reset();candidate.state='DONE';candidate.result={sourceId:item.id,soldId:item.id,remainingQuantity:5,soldQuantity:1,updatedAt:item.updatedAt};response=await post();body=await response.json();assert.equal(response.status,409);assert.equal(body.code,'DESKTOP_ORDER_ALREADY_COMPLETED');assert.equal(finishes,0);assert.equal(reports.length,0);
 reset();soldRows=[{id:'separate-legacy-manual-sale',market:'メルカリSHOP',externalProductId:candidate.orderId,saleEndDate:'2026-11-23'}];response=await post();body=await response.json();assert.equal(response.status,409);assert.equal(body.code,'DESKTOP_ORDER_ALREADY_RECORDED');assert.equal(holds,1);assert.equal(job.state,'ATTENTION');assert.equal(candidate.state,'PENDING');assert.equal(finishes,0);assert.equal(links,0);assert.equal(reports.length,0);
 console.log('PASS: actual IDENTIFY route accepts only bound separator variation; rejects variant/binding/photo/version/order changes with saved diagnostics; completed or legacy manually recorded orders hold without candidate/stock/EC writes. Synthetic data only.');
})().catch(error=>{console.error(error);process.exitCode=1;});
