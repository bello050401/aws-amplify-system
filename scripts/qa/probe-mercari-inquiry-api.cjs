const fs=require('node:fs'),path=require('node:path');
(async()=>{
 await require('esbuild').build({entryPoints:['lib/messaging/mercari/inquiryAdapter.ts'],outfile:'artifacts/whole-instruction-20261107/mercari-api-probe.cjs',bundle:true,platform:'node',target:'node22',format:'cjs',packages:'external',alias:{'server-only':path.resolve('amplify/functions/inquiry-runtime/server-only.ts')}});
 const {configuredMercariInquiryClient}=require('../../artifacts/whole-instruction-20261107/mercari-api-probe.cjs');
 const result={at:new Date().toISOString(),operation:'account-read-only',customerMessagesSent:0,success:false};
 try {const client=await configuredMercariInquiryClient('evkhihBFFNn5hukMS9s36H');await client.verifyAccount();result.success=true;}
 catch(e){result.code=/^[A-Z0-9_]+$/.test(e.code??'')?e.code:e.name;}
 fs.writeFileSync('artifacts/whole-instruction-20261107/mercari-official-api-check.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.name);process.exitCode=1;});
