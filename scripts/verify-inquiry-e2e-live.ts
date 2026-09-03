/**
 * 実データで問い合わせ処理を一気通貫で確かめる(2026-09-03 利用者指示)。
 *
 *   BASE商品特定 → 在庫特定/統合 → BASE商品説明から配送情報取得
 *   → 配送先と合わせて想定送料算出 → 値下げ判断 → 通知文面 → 返信案
 *
 * **通知は送らない。** 文面を組み立てて中身を確かめるところまで。
 *
 * Run with:
 *   NODE_ENV=production AWS_PROFILE=Bello CONVERSATION_TABLE_NAME=... \
 *     npm run verify:inquiry-e2e-live
 */
import { runWithDirectData } from "@/lib/amplify/dataClient";
import { resolveProductFromInquiry } from "@/lib/inquiry/productResolver";
import { buildResolvedProductContext } from "@/lib/inquiry/productContext";
import { decideUrlRequest, identificationBasis } from "@/lib/inquiry/productIdentification";
import { extractIntents } from "@/lib/inquiry/intent";

const CASES = [
  {
    label: "Elba(BASE 156144635) 値下げ交渉",
    text: "https://bellointeri.base.shop/items/156144635\n\n埼玉県でこちら3万円になりませんか",
  },
  {
    label: "HAYスツール(BASE 155832757) 3辺が揃わない商品",
    text: "https://bellointeri.base.shop/items/155832757\n\n埼玉県でこちら2脚で6万円になりませんか",
  },
];

async function main() {
  await runWithDirectData(async () => {
    for (const c of CASES) {
      console.log("\n" + "=".repeat(66));
      console.log(c.label);
      console.log("=".repeat(66));

      const resolution = await resolveProductFromInquiry({ messageText: c.text });
      const base = resolution.baseProducts[0] ?? null;
      console.log(`BASE商品      : ${base ? `RESOLVED  ${base.baseItemId}  ${base.title.slice(0, 40)}` : "NOT_FOUND"}`);
      console.log(`在庫          : ${resolution.status}  候補${resolution.candidates.length}件`);
      for (const cand of resolution.candidates) {
        console.log(`   ${cand.displayInventoryId}  ${String(cand.confidence.toFixed(2))}  ${cand.name.slice(0, 40)}`);
        for (const r of cand.mergedRows ?? []) console.log(`      統合: ${r.displayInventoryId} ${r.quantity ?? "?"}点  ${r.name.slice(0, 30)}`);
      }
      console.log(`同期未反映疑い: ${resolution.inventorySyncSuspected}  (最終同期 ${resolution.zaicoLastSyncedAt ?? "-"})`);
      console.log(`販売中カテゴリ: ${resolution.onSaleCategoryResolved ? "解決済み" : "解決できず"}`);

      const ctx = await buildResolvedProductContext({
        inventory: null,
        baseProduct: base
          ? { baseItemId: base.baseItemId, title: base.title, price: base.price, itemUrl: base.itemUrl, description: base.description, source: base.source }
          : null,
        baseItemId: base?.baseItemId ?? null,
      });
      console.log(`配送ランク    : ${ctx.shipping.rank ?? "不明"}  出所=${ctx.shipping.rankSource ?? "-"}`);
      console.log(`寸法          : ${JSON.stringify({ w: ctx.dimensions.width?.value ?? null, d: ctx.dimensions.depth?.value ?? null, h: ctx.dimensions.height?.value ?? null })}`);

      const intents = extractIntents(c.text);
      const basis = identificationBasis({
        status: resolution.status,
        references: resolution.references,
        fromOperatorOrConversation: false,
        candidateCount: resolution.candidates.length,
      });
      const url = decideUrlRequest({
        basis,
        status: resolution.status,
        candidateCount: resolution.candidates.length,
        // 商品固有の質問として扱い、URL再要求のガードを実際に通す。
        requiresProduct: true,
        customerAlreadySentUrl: true,
        baseProductResolved: resolution.baseProducts.length > 0,
      });
      console.log(`判定          : ${intents.join("・")}`);
      console.log(`URL再要求     : ${url.requestUrl ? "する（NG）" : "しない（OK）"} — ${url.reason}`);
      for (const n of ctx.completionNotes) console.log(`   補完: ${n}`);
    }
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
