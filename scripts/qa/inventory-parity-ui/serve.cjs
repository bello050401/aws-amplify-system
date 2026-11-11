// Development-only bundle aliases: the application components use an anonymous
// in-memory store, with no AWS credentials or external side effects.
const path=require('node:path'),fs=require('node:fs'),http=require('node:http'),esbuild=require('esbuild');
const here=__dirname,existing=path.resolve(here,'../inventory-edit-ui'),out=path.resolve('artifacts/inventory-parity-20261110/ui');
fs.mkdirSync(out,{recursive:true});
const buildBundle=()=>esbuild.build({entryPoints:[path.join(here,'main.tsx')],bundle:true,outfile:path.join(out,'ui.js'),platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'no-external-imports',setup(b){b.onResolve({filter:/^\.\/ImportWizard$/},()=>({path:'import',namespace:'qa'}));b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:'export function ImportWizard(){return null}',loader:'js'}));}}],alias:{
  'next/navigation':path.join(here,'navigation.tsx'),'next/link':path.join(here,'navigation.tsx'),
  '@/app/actions/inventoryEditJobs':path.join(existing,'store.ts'),'@/app/actions/inventoryBulkEdit':path.join(existing,'store.ts'),
  '@/app/inventory/InventoryThumbnail':path.join(existing,'thumbnail.tsx')
  ,'@/app/actions/inventoryCount':path.join(here,'quantity.ts')
}});
const build=async()=>{await buildBundle();const css=await require('postcss')([require('tailwindcss')({content:['app/inventory/**/*.tsx','scripts/qa/inventory-parity-ui/*.tsx']})]).process(fs.readFileSync('app/globals.css','utf8'),{from:'app/globals.css'});fs.writeFileSync(path.join(out,'style.css'),css.css);};
const html='<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BELLO 一覧・編集の確認</title><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/ui.js"></script></html>';
if(process.argv.includes('--build-only'))build().catch(e=>{console.error(e);process.exitCode=1;});
else build().then(()=>http.createServer((req,res)=>{if(req.method!=='GET'){res.writeHead(405);return res.end();}const file=req.url.split('?')[0];if(file==='/qa-late-image-error'){return setTimeout(()=>{res.writeHead(404,{'Content-Type':'text/plain'});res.end('Synthetic delayed image failure');},1800);}res.setHeader('Cache-Control','no-store');if(file==='/ui.js'||file==='/style.css'){res.setHeader('Content-Type',file.endsWith('js')?'text/javascript':'text/css');return fs.createReadStream(path.join(out,file.slice(1))).pipe(res);}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);}).listen(43138,'127.0.0.1',()=>console.log('http://127.0.0.1:43138')));
