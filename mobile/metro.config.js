const {getDefaultConfig}=require("expo/metro-config");
const path=require("node:path");
const fs=require("node:fs");
const config=getDefaultConfig(__dirname);
// Share BELLO's pure sales/date calculations with the staff client.
config.watchFolders=[path.resolve(__dirname,"../lib/inventory"),path.resolve(__dirname,"../lib/outbound"),path.resolve(__dirname,"../lib/invoicing"),path.resolve(__dirname,"../lib/saleCandidates"),path.resolve(__dirname,"../components/sales"),path.resolve(__dirname,"../components/invoicing"),path.resolve(__dirname,"../app/inventory/(protected)/outbound")];
config.watchFolders.push(path.resolve(__dirname,"../lib/listing"));
config.watchFolders.push(path.resolve(__dirname,"../components/inventory"));
// Windows worktrees share dependencies through a junction. Metro must see its real target.
const dependencyRoot=fs.realpathSync(path.resolve(__dirname,"node_modules"));
if(dependencyRoot!==path.resolve(__dirname,"node_modules"))config.watchFolders.push(dependencyRoot);
config.resolver.nodeModulesPaths=[dependencyRoot];
// Shared web components must use the app's React instance, not the PC bundle's.
config.resolver.resolveRequest=(context,moduleName,platform)=>{
 if(moduleName==='react'||moduleName.startsWith('react/'))return context.resolveRequest({...context,originModulePath:path.join(__dirname,'index.ts')},moduleName,platform);
 return context.resolveRequest(context,moduleName,platform);
};
module.exports=config;
