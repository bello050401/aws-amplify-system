const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, ".."), target = path.join(root, "tools/bello-security-pilot"), out = path.join(target, "dist");
fs.mkdirSync(out, {recursive:true});
Promise.all([
 esbuild.build({entryPoints:[path.join(target,"handler.ts")],bundle:true,platform:"node",target:"node22",format:"cjs",outfile:path.join(out,"handler.js"),logLevel:"warning"}),
 esbuild.build({entryPoints:[path.join(target,"browser.ts")],bundle:true,platform:"browser",target:["safari16","chrome110"],format:"iife",outfile:path.join(out,"app.js"),logLevel:"warning"})
]).then(()=>{for(const name of ["index.html","app.css"])fs.copyFileSync(path.join(target,name),path.join(out,name));console.log("Built isolated security pilot (no production configuration).")}).catch(()=>process.exitCode=1);
