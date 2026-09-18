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

const REQUIRED_HEADINGS = ["◎商品のご紹介", "◎商品詳細", "◎発送について", "◎コンディション", "◎返品・返金対応について", "◎お取り置きについて"];
function assertAllHeadingsPresent(description: string | null, label: string): void {
  assert.ok((description ?? "").trim().length > 0, `${label}: PaidAIBudgetError時に商品説明の本文が空になってはいけない`);
  for (const heading of REQUIRED_HEADINGS) {
    assert.ok((description ?? "").includes(heading), `${label}: 見出し「${heading}」が欠落しています`);
  }
}

// 1. 従来からのケース(寸法・傷の記録あり、ruleSections未指定)。
//    課金ゲート自体は迂回せず(generateStructuredは実際に1回呼ばれ、
//    PaidAIBudgetErrorとして拒否されている=state.calls参照)、それでも
//    本文は6見出しすべてを含む実用的な内容で埋まること。
const page = await generateProductPage({
  inventoryId: "synthetic", name: "テーブルランプ", categoryName: "照明",
  width: "20", depth: "20", height: "40", damageNotes: "台座に傷があります。", archive: [], styleProfile: null,
});
assert.equal(page.ok, false);
assert.notEqual(page.sections?.introduction, "", "AI不使用時も「◎商品のご紹介」を空のままにしてはいけない");
assert.match(page.sections?.introduction ?? "", /テーブルランプ/);
assert.match(page.sections?.conditionSection ?? "", /傷/);
assertAllHeadingsPresent(page.fullDescription, "寸法/傷ありケース");
assert.equal(page.modelName, null);
assert.match(page.failureReason ?? "", /自動作成/);
assert.equal(state.calls, 1);

// 2. 2026年に実際に発生した回帰の直接再現: 寸法・傷・コンディション評価の
//    どれも登録されていない(facts側が空の)在庫。以前はここで
//    introduction/dimensionsSection/conditionSectionが全て空文字列になり、
//    旧composeFullDescriptionへ直接渡していたため本文がほぼ空になっていた。
const emptyFactsPage = await generateProductPage({
  inventoryId: "synthetic-empty", name: "無題の椅子", categoryName: null,
  width: null, depth: null, height: null, damageNotes: null, note: null, conditionRating: null,
  archive: [], styleProfile: null,
});
assert.equal(emptyFactsPage.ok, false);
assertAllHeadingsPresent(emptyFactsPage.fullDescription, "facts全空ケース");
assert.equal(state.calls, 2);

// 3. 本番経路(canonical.ts)と同じ形——ruleSectionsが渡されている場合。
//    AIのintroductionが空でも、◎商品詳細/◎発送についてはruleSections
//    (寸法・配送ランク等から機械的に確定済みの値)がそのまま残ること。
//    旧実装はここを完全に無視して旧composeFullDescriptionを呼んでいたため、
//    ruleSectionsの内容が丸ごと消えていた。
const ruleSectionsPage = await generateProductPage({
  inventoryId: "synthetic-rules", name: "ソファ", categoryName: "ソファ",
  width: "180", depth: "80", height: "70", damageNotes: null, note: null, conditionRating: null,
  archive: [], styleProfile: null,
  ruleSections: {
    productDetail: "幅:180cm\n奥行:80cm\n高さ:70cm",
    shipping: "埼玉県より、らくらく家財便Bランク、または、自社での配送を予定しております。",
    condition: "目立つ傷や汚れは見受けられません。",
  },
});
assert.equal(ruleSectionsPage.ok, false);
assertAllHeadingsPresent(ruleSectionsPage.fullDescription, "ruleSectionsありケース");
assert.match(ruleSectionsPage.fullDescription ?? "", /らくらく家財便Bランク/);
assert.match(ruleSectionsPage.fullDescription ?? "", /目立つ傷や汚れは見受けられません/);
assert.equal(state.calls, 3);

await assert.rejects(generateListingCopy({ name: "テーブルランプ" }), /未作成/);
assert.equal(state.calls, 4);
const original = "送料は3000円です。9月20日の配送は未定です。台座に傷があります。";
const keigo = await rewriteAsKeigo({ original, messages: [] });
assert.equal(keigo.ok, true);
assert.ok(keigo.text?.endsWith(original));
assert.equal(keigo.modelName, null);
assert.ok(keigo.ambiguityNotes.some(note => note.includes("原文を保持")));
assert.equal(state.calls, 5);
const reply = await generateReplyDraft({ channel: "test", inquiryBody: "送料0円で明日届きますか", shippingFee: null });
assert.match(reply, /確認のうえ/);
assert.doesNotMatch(reply, /0円|明日/);
assert.equal(state.calls, 6);
state.budget = false;
await assert.rejects(generateReplyDraft({ channel: "test", inquiryBody: "test" }), /synthetic denial/);
assert.equal(state.calls, 7);
console.log("PASS: budget fallback assertions; no paid retry, deterministic non-empty listing description (all 6 headings) built from facts, manual-review status and null model metadata.");
