const {getDefaultConfig}=require("expo/metro-config");
const path=require("node:path");
const config=getDefaultConfig(__dirname);
// Share BELLO's pure sales/date calculations with the staff client.
config.watchFolders=[path.resolve(__dirname,"../lib/inventory")];
config.resolver.nodeModulesPaths=[path.resolve(__dirname,"node_modules")];
module.exports=config;
