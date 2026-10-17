const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "mobile", "dist");
const target = path.join(root, "public", "staff-app");
if (!fs.existsSync(path.join(source, "index.html"))) throw new Error("Export the staff app before packaging it.");
fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log("Staff app packaged for BELLO's authenticated origin.");
