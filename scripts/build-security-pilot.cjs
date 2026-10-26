const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, ".."), target = path.join(root, "tools/bello-security-pilot"), out = path.join(target, "dist");
const assets = path.join(root, "public/security-assets");
fs.mkdirSync(assets, {recursive:true});
fs.mkdirSync(out, {recursive:true});
fs.mkdirSync(path.join(target,'photo-dist'),{recursive:true});
Promise.all([
 esbuild.build({entryPoints:[path.join(root,'amplify/functions/photo-registration/httpHandler.ts')],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:path.join(target,'photo-dist/photo.js'),logLevel:'warning'}),
 esbuild.build({entryPoints:[path.join(target,"handler.ts")],bundle:true,platform:"node",target:"node22",format:"cjs",outfile:path.join(out,"handler.js"),logLevel:"warning"}),
 esbuild.build({entryPoints:[path.join(target,"browser.ts")],bundle:true,platform:"browser",target:["safari16","chrome110"],format:"iife",outfile:path.join(out,"app.js"),logLevel:"warning"}),
 esbuild.build({entryPoints:[path.join(root,"lib/security/browserWorker.ts")],bundle:true,platform:"browser",target:["safari16","chrome110"],format:"iife",outfile:path.join(root,"public/security-worker.js"),logLevel:"warning"})
]).then(()=>{for(const name of ["index.html","app.css"])fs.copyFileSync(path.join(target,name),path.join(out,name));for(const name of ["app.js","app.css"])fs.copyFileSync(path.join(out,name),path.join(assets,name));console.log("Built security UI and request-signing worker (no production configuration).")}).catch(()=>process.exitCode=1);
