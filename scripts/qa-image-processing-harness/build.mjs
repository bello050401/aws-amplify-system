// ImageProcessingPanel 実React境界試験(2026-09-13)専用ビルド。
// 本物のImageProcessingPanel.tsxをesbuildでバンドルし、Server Action
// (@/app/actions/imageProcessing)とuseInventoryImageUrlだけをこの
// ディレクトリ内のモックへ差し替える。実AWS/Next.js不要、ブラウザだけで
// 完結する合成ページを作る。
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const mockActionsPath = path.join(__dirname, "mockActions.tsx");
const mockImageUrlPath = path.join(__dirname, "mockImageUrl.tsx");

/** @type {import('esbuild').Plugin} */
const aliasPlugin = {
  name: "qa-harness-alias",
  setup(build) {
    build.onResolve({ filter: /^@\/app\/actions\/imageProcessing$/ }, () => ({ path: mockActionsPath }));
    build.onResolve({ filter: /^\.\/useInventoryImageUrl$/ }, (args) => {
      if (args.importer.replace(/\\/g, "/").endsWith("ImageProcessingPanel.tsx")) {
        return { path: mockImageUrlPath };
      }
      return undefined;
    });
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(projectRoot, args.path.slice(2));
      for (const ext of ["", ".tsx", ".ts", ".jsx", ".js"]) {
        if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return { path: base + ext };
      }
      return { path: base };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(__dirname, "entry.tsx")],
  bundle: true,
  outfile: path.join(__dirname, "dist", "bundle.js"),
  format: "iife",
  jsx: "automatic",
  resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
  plugins: [aliasPlugin],
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "warning",
});
console.log("harness bundle built");
