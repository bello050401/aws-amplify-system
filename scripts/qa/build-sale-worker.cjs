const path=require('path'),fs=require('fs');
const aliases={
 'server-only':'amplify/functions/inquiry-runtime/server-only.ts',
 '@/lib/amplify/dataClient':'amplify/functions/inquiry-runtime/dataClient.ts',
 '@/lib/inventory/mutationSession':'amplify/functions/inquiry-runtime/webBoundary.ts',
 '@/lib/amplify/serverUtils':'amplify/functions/inquiry-runtime/webBoundary.ts',
 '@/lib/saleCandidates/store':'amplify/functions/sale-automation/store.ts',
 '@/lib/listing/ecImage':'amplify/functions/sale-automation/noPublishImages.ts',
};
// Relative imports of store are intercepted by their resolved file, not a global web auth alias.
require('esbuild').build({entryPoints:['amplify/functions/sale-automation/handler.ts'],bundle:true,platform:'node',target:'node22',format:'cjs',minify:true,metafile:true,outfile:'artifacts/sale-automation-20261108/worker/index.cjs',external:['@aws-sdk/*'],alias:Object.fromEntries(Object.entries(aliases).filter(([k])=>!k.startsWith('.')).map(([k,v])=>[k,path.resolve(v)])),plugins:[{name:'sale-worker-config',setup(b){b.onResolve({filter:/^(?:\.\/store|\.\.\/\.\.\/lib\/saleCandidates\/store)$/},a=>a.importer.includes('saleCandidates')?{path:path.resolve('amplify/functions/sale-automation/store.ts')}:undefined);}}]}).then(r=>{fs.writeFileSync('artifacts/sale-automation-20261108/worker-meta.json',JSON.stringify(r.metafile));console.log('worker built');}).catch(()=>process.exitCode=1);
