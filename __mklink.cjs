const fs = require("fs");
const path = require("path");
const target = "C:\\Users\\win\\Documents\\GitHub\\aws-amplify-system\\node_modules";
const linkPath = path.join(__dirname, "node_modules");
console.log("exists before:", fs.existsSync(linkPath));
if (!fs.existsSync(linkPath)) {
  fs.symlinkSync(target, linkPath, "junction");
}
console.log("exists after:", fs.existsSync(linkPath));
console.log("entries:", fs.readdirSync(linkPath).length);
