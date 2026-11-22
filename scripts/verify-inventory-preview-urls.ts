import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Offline signing only. A real AWS credential must never be needed by this test.
process.env.AWS_ACCESS_KEY_ID = "PREVIEW_TEST_ONLY";
process.env.AWS_SECRET_ACCESS_KEY = "PREVIEW_TEST_ONLY";
delete process.env.AWS_SESSION_TOKEN;

async function main() {
  // Compile the real signer with two explicit test-only ports. Generated live
  // configuration is never read, and the actual AWS presigner runs offline.
  const signerFile = fileURLToPath(new URL('../lib/inventory/listImageUrls.ts', import.meta.url));
  const result = await build({entryPoints:[signerFile],bundle:true,platform:'node',format:'cjs',packages:'external',write:false,plugins:[{name:'offline-preview-resource',setup(builder){
    builder.onResolve({filter:/^(?:server-only|.*amplify_outputs\.json)$/}, args=>{
      assert.equal(args.importer,signerFile,'only the real signer may use these offline ports');
      assert.ok(args.path==='server-only'||args.path==='../../amplify_outputs.json');
      return {path:args.path,namespace:'offline-preview-resource'};
    });
    builder.onLoad({filter:/.*/,namespace:'offline-preview-resource'},args=>({contents:args.path==='server-only'?'export {};':'export default {storage:{aws_region:"us-west-2",bucket_name:"synthetic-preview-fixture-only"}};',loader:'js'}));
  }}]});
  const module={exports:{} as typeof import('../lib/inventory/listImageUrls')};
  vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url),URL,Map,Set,console,process});
  const { signInventoryPreviews, signInventoryListKey } = module.exports;
  const { normalizeImageRecord } = await import("../lib/inventory/imageTypes");
  const images = [normalizeImageRecord({ storageKey: "inventory/test/original.jpg", thumbnailKey: "inventory/test/small.jpg", mediumKey: "inventory/test/medium.jpg", sortOrder: 0 })];
  const urls = await signInventoryPreviews(images);
  assert.deepEqual(Object.keys(urls).sort(), ["inventory/test/medium.jpg", "inventory/test/small.jpg"]);
  assert.equal(urls[images[0].storageKey], undefined, "Do not prefetch or sign the original when previews exist");
  for (const value of Object.values(urls)) {
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname,"synthetic-preview-fixture-only.s3.us-west-2.amazonaws.com");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
    assert.equal(url.searchParams.get("response-cache-control"), "private, max-age=900");
  }
  assert.equal(await signInventoryListKey("other/private.jpg"), null);
  assert.equal(await signInventoryListKey("inventory/../private.jpg"), null);
  const fallback = await signInventoryPreviews([normalizeImageRecord({ storageKey: "inventory/test/legacy.jpg", sortOrder: 0 })]);
  assert.ok(fallback["inventory/test/legacy.jpg"], "Legacy records without derivatives remain visible");
  console.log("preview signing: private 15-minute URLs, preview-only, legacy fallback, unsafe keys rejected");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
