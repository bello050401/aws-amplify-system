const {build}=require('esbuild'),path=require('node:path');
const aliases={
 'server-only':'amplify/functions/inquiry-runtime/server-only.ts',
 '@/lib/amplify/dataClient':'amplify/functions/inquiry-runtime/dataClient.ts',
 '@/lib/inventory/mutationSession':'amplify/functions/inquiry-runtime/webBoundary.ts',
 '@/lib/amplify/serverUtils':'amplify/functions/inquiry-runtime/webBoundary.ts',
 '@/lib/saleCandidates/store':'amplify/functions/sale-automation/store.ts',
 '@/lib/listing/ecImage':'amplify/functions/sale-automation/noPublishImages.ts',
};
build({entryPoints:['amplify/functions/sale-automation/handler.ts'],bundle:true,platform:'node',target:'node22',minify:true,write:false,external:['@aws-sdk/*'],alias:Object.fromEntries(Object.entries(aliases).map(([k,v])=>[k,path.resolve(v)])),plugins:[{name:'no-generated-web-config',setup(b){b.onResolve({filter:/amplify_outputs\.json$/},()=>{throw Error('Backend build must not require generated frontend outputs');});}}]}).then(r=>console.log('PASS production worker bundle; no frontend configuration dependency; bytes',r.outputFiles[0].contents.length)).catch(e=>{console.error(e.message);process.exitCode=1;});
