/** Synthetic denial at the gateway boundary; no provider or storage is loaded. */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = pathToFileURL(process.cwd() + "/").href;
const state = { calls: 0, budget: true };
(globalThis as any).__copyFallbackTest = state;
const moduleUrl = (source: string) => "data:text/javascript," + encodeURIComponent(source);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: moduleUrl("export default {}"), shortCircuit: true };
  if (specifier.endsWith("/gateway/gateway")) return { url: moduleUrl(`
    export async function generateStructured() {
      const state = globalThis.__copyFallbackTest; state.calls++;
      const error = new Error('synthetic denial'); error.name = state.budget ? 'PaidAIBudgetError' : 'Error'; throw error;
    }
    export const generateText = generateStructured;
  `), shortCircuit: true };
  if (specifier === "@/lib/knowledge/store") return { url: moduleUrl("export async function listSearchableKnowledge(){return []}"), shortCircuit: true };
  if (specifier.endsWith("/styleCorpusLoader")) return { url: moduleUrl("export function buildStyleExamplesForProduct(){return ''}"), shortCircuit: true };
  const target = specifier.startsWith("@/") ? root + specifier.slice(2) : specifier;
  try { return nextResolve(target, context); } catch { return nextResolve(target + ".ts", context); }
} });

const { generateProductPage } = await import("@/lib/ai/productPage/service");
const { generateListingCopy, generateReplyDraft } = await import("@/lib/ai/ecCopy");
const { rewriteAsKeigo } = await import("@/lib/inquiry/keigoService");
const page = await generateProductPage({ inventoryId: "synthetic", name: "テーブルランプ", categoryName: "照明",
  width: "20", depth: "20", height: "40", damageNotes: "台座に傷があります。", archive: [], styleProfile: null });
assert.equal(page.ok, false);
assert.equal(page.sections?.introduction, "");
assert.match(page.sections?.conditionSection ?? "", /傷/);
assert.match(page.fullDescription ?? "", /コンディション/);
assert.equal(page.modelName, null);
assert.match(page.failureReason ?? "", /未作成/);
assert.equal(state.calls, 1);
await assert.rejects(generateListingCopy({ name: "テーブルランプ" }), /未作成/);
assert.equal(state.calls, 2);
const original = "送料は3000円です。9月20日の配送は未定です。台座に傷があります。";
const keigo = await rewriteAsKeigo({ original, messages: [] });
assert.equal(keigo.ok, true);
assert.ok(keigo.text?.endsWith(original));
assert.equal(keigo.modelName, null);
assert.ok(keigo.ambiguityNotes.some(note => note.includes("原文を保持")));
assert.equal(state.calls, 3);
const reply = await generateReplyDraft({ channel: "test", inquiryBody: "送料0円で明日届きますか", shippingFee: null });
assert.match(reply, /確認のうえ/);
assert.doesNotMatch(reply, /0円|明日/);
assert.equal(state.calls, 4);
state.budget = false;
await assert.rejects(generateReplyDraft({ channel: "test", inquiryBody: "test" }), /synthetic denial/);
assert.equal(state.calls, 5);
console.log("PASS: 19 budget fallback assertions; no paid retry, facts preserved, manual-review status and null model metadata.");
