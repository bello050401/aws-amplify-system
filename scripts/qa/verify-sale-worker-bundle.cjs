const {build}=require('esbuild'),path=require('node:path'),assert=require('node:assert/strict'),fs=require('node:fs');
const aliases={
 'server-only':'amplify/functions/inquiry-runtime/server-only.ts',
 '@/lib/amplify/dataClient':'amplify/functions/inquiry-runtime/dataClient.ts',
 '@/lib/inventory/mutationSession':'amplify/functions/inquiry-runtime/webBoundary.ts',
 '@/lib/amplify/serverUtils':'amplify/functions/inquiry-runtime/webBoundary.ts',
 '@/lib/saleCandidates/store':'amplify/functions/sale-automation/store.ts',
 '@/lib/listing/ecImage':'amplify/functions/sale-automation/noPublishImages.ts',
};
build({entryPoints:['amplify/functions/sale-automation/handler.ts'],bundle:true,platform:'node',target:'node22',minify:true,write:false,metafile:true,external:['@aws-sdk/*'],alias:Object.fromEntries(Object.entries(aliases).map(([k,v])=>[k,path.resolve(v)])),plugins:[{name:'no-generated-web-config',setup(b){b.onResolve({filter:/amplify_outputs\.json$/},()=>{throw Error('Backend build must not require generated frontend outputs');});}}]}).then(r=>{
 const inputs=Object.keys(r.metafile.inputs).map(file=>file.replaceAll('\\','/'));
 for(const file of ['amplify/functions/sale-automation/handler.ts','amplify/functions/sale-automation/store.ts','lib/saleCandidates/desktopJobs.ts','lib/saleCandidates/desktopImages.ts','lib/saleCandidates/yahooSettlementContinuationServer.ts'])assert(inputs.includes(file),'Actual worker dependency must be bundled: '+file);
 for(const file of ['lib/saleCandidates/store.ts','lib/inventory/listImageUrls.ts','lib/saleCandidates/desktopImagePreviews.ts'])assert(!inputs.includes(file),'Web-only dependency leaked into worker: '+file);
 console.log(JSON.stringify({result:'PASS',check:'production-worker-no-frontend-config',frontendOutputsPresent:fs.existsSync('amplify_outputs.json'),bytes:r.outputFiles[0].contents.length,inputs:inputs.length}));
}).catch(e=>{console.error(e.message);process.exitCode=1;});
