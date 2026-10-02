/** The real Server Action with only its external dependencies stubbed. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const state = { result: null as Record<string, unknown> | null, copyCalls: 0 };
(globalThis as typeof globalThis & { __aiActionAcceptance?: typeof state }).__aiActionAcceptance = state;
const stub = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/amplify/requireInventoryUser") return { url: stub(`
    export const canEditInventory = () => true;
    export const getInventoryRole = async () => "ADMIN";
    export const getCurrentInventoryUserEmail = async () => null;
  `), shortCircuit: true };
  if (specifier === "@/lib/ai/productPage/canonical") return { url: stub(`
    export const generateCanonicalProductPage = async () => globalThis.__aiActionAcceptance.result;
    export const toListingDraftCopy = () => {
      globalThis.__aiActionAcceptance.copyCalls++;
      return { title: "合成タイトル", description: "合成説明文", price: 0, condition: "やや傷や汚れあり" };
    };
  `), shortCircuit: true };
  if (specifier === "@/lib/ai/productPage/history") return { url: stub(`
    export const saveGeneratedProductPage = async () => ({ savedId: "synthetic-history", reason: null });
  `), shortCircuit: true };
  if (specifier === "@/lib/shipping/sagawaSize") return { url: stub(`
    export const formatSagawaSize = () => "200サイズ";
  `), shortCircuit: true };
  return nextResolve(specifier, context);
} });

const actionModule = await import(pathToFileURL(process.cwd() + "/app/actions/ai.ts").href);
const generateListingCopyAction = actionModule.generateListingCopyAction as typeof import("../app/actions/ai").generateListingCopyAction;
state.result = { ok: false, failureReason: "有料AI予算制限のため確認が必要です。",
  sections: { title: "合成タイトル" }, fullDescription: "読めるが未承認の説明文", violations: [], redactions: [] };
const rejected = await generateListingCopyAction("synthetic-inventory");
assert.equal(rejected.ok, false, "読める本文と違反0件だけでは下書きへ適用しない");
assert.match(rejected.ok ? "" : rejected.error, /予算制限/);
assert.equal(state.copyCalls, 0, "失敗結果はコピー変換にも渡さない");

state.result = { ok: true, failureReason: null, sections: { title: "合成タイトル" }, fullDescription: "合格した説明文",
  violations: [], redactions: [], missingFacts: [], usedStyleProfileVersion: null,
  referencedBaseItemIds: [], photoObservationCount: 0, photoObservationDetails: [],
  introSanitized: false, completionNotes: [], warnings: [], ruleNotes: [],
  facts: { shippingRank: null, shippingRankReason: null, shippingSumCm: null,
    sagawa: { unavailableReason: null, note: null } }, shippingMethod: "KAZAI" };
const accepted = await generateListingCopyAction("synthetic-inventory");
assert.equal(accepted.ok, true, "品質検査済みの生成文は通常どおり返す");
assert.equal(state.copyCalls, 1);
console.log("PASS: AI action returns failure for unapproved copy and success only for accepted copy.");
