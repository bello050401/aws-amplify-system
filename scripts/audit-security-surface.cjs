/** Read-only static migration inventory; flags are review targets, not exploit claims. */
const fs=require('node:fs'),path=require('node:path');
const sources=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){if(!['node_modules','dist','.next','generated'].includes(e.name))walk(p);}else if(/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)&&!/(test|spec)\./.test(e.name))sources.push(p);}}
for(const d of ['app','lib','mobile/src','amplify'])if(fs.existsSync(d))walk(d);
const rules={
  browserStorageDirect:/from ["']aws-amplify\/storage["']/,
  legacySession:/fetchAuthSession|runWithAmplifyServerContext|runWithUserPoolServerContext/,
  directDataPermission:/inventoryVerifiedReadSession|inventoryMutationSession|getInventoryRole|requireInventoryUserOrRedirect|getMobileSession|requireMobileFeature/,
  publicDataRule:/allow\.publicApiKey\(\)/,
  browserTokenAccess:/from ["']aws-amplify\/auth["']/,
};
const matches={};for(const [name,pattern]of Object.entries(rules)){matches[name]=[];for(const file of sources){const lines=fs.readFileSync(file,'utf8').split(/\r?\n/);lines.forEach((line,i)=>{if(pattern.test(line)&&!line.trim().startsWith('//'))matches[name].push({file:file.replace(/\\/g,'/'),line:i+1});});}}
const report={at:new Date().toISOString(),staticOnly:true,productionChanged:false,scannedFiles:sources.length,routeHandlers:sources.filter(f=>/app[\\/]api[\\/].*[\\/]route\.ts$/.test(f)).length,matches,
  blockers:['既存Cognitoクライアント・AppSync・Identity Pool・S3の直接経路は未切替','本番業務APIの端末拒否と既存機能の回帰試験が必要','iPhone/Windows Helloで実物のパスキー確認が必要'],
  clarification:'文字列一致は移行対象の棚卸しであり、各経路に脆弱性があることを断定する検査ではありません。'};
fs.mkdirSync('artifacts/security-20261026',{recursive:true});fs.writeFileSync('artifacts/security-20261026/migration-surface.json',JSON.stringify(report,null,2));console.log(JSON.stringify({files:report.scannedFiles,routeHandlers:report.routeHandlers,counts:Object.fromEntries(Object.entries(matches).map(([k,v])=>[k,v.length]))}));
