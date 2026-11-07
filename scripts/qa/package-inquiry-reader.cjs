const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
(async()=>{
 const out=path.resolve('artifacts/whole-instruction-20261107/inquiry-reader');fs.mkdirSync(out,{recursive:true});
 for(const name of ['inquiryCloudWorker','inquiryLogin'])await esbuild.build({entryPoints:[`tools/bello-mercari-bridge/src/${name}.mjs`],outfile:path.join(out,name+'.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',minify:false});
 const root=path.join(process.env.LOCALAPPDATA,'BELLO','InquiryReader');
 const config={origin:'https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com',root:path.join(root,'Queue'),belloProfileDir:path.join(root,'BELLOChrome'),profileDir:path.join(root,'ShopsChrome'),playwrightModulePath:require.resolve('playwright/package.json'),shopId:'evkhihBFFNn5hukMS9s36H'};
 fs.writeFileSync(path.join(out,'config.json'),JSON.stringify(config,null,2));
 for(const [file,script] of [['1-Login.cmd','inquiryLogin'],['2-Read-once.cmd','inquiryCloudWorker'],['3-Start.cmd','inquiryCloudWorker']])fs.writeFileSync(path.join(out,file),'@echo off\r\ncd /d "%~dp0"\r\nnode "'+script+'.mjs" "config.json"'+(file==='2-Read-once.cmd'?' --once':'')+'\r\npause\r\n');
 fs.copyFileSync('docs/inquiry-runtime-20261108.md',path.join(out,'Readme.md'));
 fs.writeFileSync(path.join(out,'version.json'),JSON.stringify({version:'2026-11-08',mode:'READ_ONLY',customerSending:false,requiresDedicatedLogin:true,requiresNode:'>=24',dedicatedSessionEndToEndVerified:false},null,2));
 console.log('Packaged read-only worker; login and unattended-session acceptance still required.');
})().catch(e=>{console.error(e.name);process.exitCode=1;});
