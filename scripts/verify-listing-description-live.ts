/**
 * 2026-09-04 EC出品改修指示書 §26/§29: 実在庫1件で商品説明を生成して見る。
 *
 *   AWS_PROFILE=Bello npm run verify:listing-description-live -- <inventoryId|SKU>
 *
 * 画面の「AIで下書きを生成」と**同じ関数**(generateCanonicalProductPage)を
 * 呼ぶ。生成物は保存しない —— このスクリプトは ReplyDraft も
 * GeneratedProductPage も書かず、標準出力へ出すだけ。
 *
 * ── 何を確かめるのか ────────────────────────────────────────────
 *
 *   ・§4 のセクション構成で出るか
 *   ・◎商品詳細の寸法・座面寸法がZAICOの値そのままか
 *   ・◎発送について に家財おまかせ便のランクが入るか(判定不能なら印)
 *   ・◎コンディション がメンテナンス記録と状態から作られているか
 *   ・§21 足りない情報が警告として出るか
 */
import { ensureConversationTableName } from "./lib/resolveStagingTables";

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error("使い方: npm run verify:listing-description-live -- <inventoryId または SKU>");
    process.exit(1);
  }
  await ensureConversationTableName();

  const { runWithDirectData } = await import("@/lib/amplify/dataClient");
  const { generateCanonicalProductPage } = await import("@/lib/ai/productPage/canonical");
  const { formatSagawaSize } = await import("@/lib/shipping/sagawaSize");
  const { serverDataClient, inventoryAuthMode } = await import("@/lib/amplify/dataClient");

  await runWithDirectData(async () => {
    // SKUで指定された場合はIDへ引き直す(担当者はSKUで覚えている)。
    let inventoryId = key;
    if (/^B\d{6}$/i.test(key)) {
      const { data } = await serverDataClient.models.Inventory.list({
        filter: { sku: { eq: key.toUpperCase() } },
        limit: 1000,
        ...inventoryAuthMode,
      });
      const hit = (data as unknown as { id: string; sku: string }[]).find((r) => r.sku === key.toUpperCase());
      if (!hit) throw new Error(`SKU ${key} の在庫が見つかりません。`);
      inventoryId = hit.id;
    }

    console.log(`[verify-listing-description-live] 在庫 ${inventoryId} で生成します`);
    const result = await generateCanonicalProductPage(inventoryId);

    console.log("\n════ 確定した事実(ルール側) ════");
    console.log(`商品名        : ${result.inventoryName}`);
    console.log(`ブランド      : ${result.facts.brand ?? "-"}`);
    console.log(`材質          : ${result.facts.material ?? "-"}`);
    console.log(`寸法          : 幅${result.facts.width ?? "-"} 奥行${result.facts.depth ?? "-"} 高さ${result.facts.height ?? "-"}`);
    console.log(
      `座面寸法      : ${result.facts.seat.hasAny ? `幅${result.facts.seat.width ?? "-"} 奥行${result.facts.seat.depth ?? "-"} 高さ${result.facts.seat.height ?? "-"} (出所: ${result.facts.seat.source})` : "未登録"}`,
    );
    console.log(
      `家財おまかせ便: ${result.facts.shippingRank ?? "判定不可"}${result.facts.shippingSumCm != null ? ` (3辺合計${result.facts.shippingSumCm}cm)` : ""}`,
    );
    console.log(`佐川急便      : ${formatSagawaSize(result.facts.sagawa) ?? "判定不可"} — ${result.facts.sagawa.note}`);
    console.log(
      `メンテナンス  : ${
        result.facts.maintenance.hasAny
          ? result.facts.maintenance.evidence.map((e) => `${e.kind}(${e.field})`).join(" / ")
          : "記録なし"
      }`,
    );
    console.log(`良好の根拠    : ${result.facts.goodConditionEvidence ? "あり" : "なし"}`);

    if (result.warnings.length > 0) {
      console.log("\n════ §21 警告 ════");
      for (const w of result.warnings) console.log(`  ${w}`);
    }
    if (result.ruleNotes.length > 0) {
      console.log("\n════ コンディション文の根拠 ════");
      for (const n of result.ruleNotes) console.log(`  ・${n}`);
    }
    if (result.completionNotes.length > 0) {
      console.log("\n════ BASEからの補完 ════");
      for (const n of result.completionNotes) console.log(`  ・${n}`);
    }

    console.log(`\n════ 生成結果 (ok=${result.ok}) ════`);
    if (result.failureReason) console.log(`失敗理由: ${result.failureReason}`);
    for (const v of result.violations) console.log(`品質検査: ${v.detail}`);
    console.log(`タイトル: ${result.sections?.title ?? "-"}`);
    console.log(`\n--- 商品説明(${result.fullDescription?.length ?? 0}文字) ---`);
    console.log(result.fullDescription ?? "(生成できませんでした)");
  });
}

void main().catch((err) => {
  console.error(`[verify-listing-description-live] 失敗: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
