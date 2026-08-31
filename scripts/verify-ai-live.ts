/**
 * AI文章生成の**実接続**確認。他の verify:* と違い、これは実際に
 * Amazon Bedrock を呼ぶ（＝わずかだが課金が発生する）。
 *
 * Run with: npm run verify:ai-live
 *
 * ## なぜ別スクリプトなのか
 *
 * `npm run verify:ai-gateway` はProvider選択やプロンプト構築の**純粋ロジック**を
 * 固定するだけで、モデルへは一切繋がない。「AIで下書きを生成」が実際に
 * 動くかどうかは、それでは分からない——実際、用途申請エラーで機能が死んで
 * いた間も verify:ai-gateway は全green だった。
 *
 * ## 何を通しているか
 *
 * 画面が呼ぶ関数そのもの（`generateListingCopy` / `generateReplyDraft`）を
 * 呼ぶ。プロンプト・ツール定義・品質ゲート・tier・AIUsageLog記録まで
 * 本番と同じ経路を通る。ここを自前で組み直すと「スクリプトは通るが画面は
 * 通らない」を作り込むため、意図的に本番の関数だけを使う。
 *
 * AIUsageLogの書き込みはAppSync(ログイン前提)なのでローカルからは失敗するが、
 * `recordAIUsage` が失敗を握り潰す設計なので生成結果には影響しない。
 *
 * ## 実行に必要なもの
 *
 * Bedrockを呼べるAWS資格情報（例: `AWS_PROFILE=Bello npm run verify:ai-live`）。
 * 資格情報が無い場合は、成功を装わずそのまま失敗させる。
 */
import { resolveProviderId } from "@/lib/ai/gateway/gateway";
import { generateListingCopy, generateReplyDraft } from "@/lib/ai/ecCopy";

let failures = 0;

function ok(label: string, detail: string) {
  console.log(`✓ ${label}\n    ${detail}`);
}
function ng(label: string, err: unknown) {
  failures++;
  console.error(`✗ FAIL ${label}\n    ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
}

async function checkListingCopy() {
  const label = "generateListingCopy: 実モデルが構造化出力(title/description/conditionText)を返す";
  try {
    const t0 = Date.now();
    const out = await generateListingCopy({
      name: "BoConcept コーヒーテーブル Granville",
      brand: "BoConcept",
      maker: null,
      model: null,
      dimensions: "幅103cm 奥行70cm 高さ32cm",
      categoryName: "テーブル",
      conditionNote: "天板に小傷あり、補修済み",
      note: null,
    });
    const ms = Date.now() - t0;
    if (!out.title?.trim()) throw new Error("titleが空");
    if (!out.description?.trim()) throw new Error("descriptionが空");
    if (!out.conditionText?.trim()) throw new Error("conditionTextが空");
    ok(label, `${ms}ms title="${out.title}" description=${out.description.length}文字 sellingPoints=${out.sellingPoints?.length ?? 0}件`);
  } catch (err) {
    ng(label, err);
  }
}

async function checkReplyDraft() {
  const label = "generateReplyDraft: 実モデルが日本語の返信案を返す";
  try {
    const t0 = Date.now();
    const out = await generateReplyDraft({
      channel: "LINE",
      inquiryBody: "このソファはまだ在庫がありますか。配送は可能でしょうか。",
      productName: "BoConcept 3人掛けソファ",
      productCondition: "使用感の少ない中古",
      sellingPrice: 148000,
      stockQuantity: 1,
      // 送料は未確定のまま渡す。AIが金額を作り出さないことを下で検査するため。
      shippingFee: null,
      conversationHistory: [],
    });
    const ms = Date.now() - t0;
    if (!out.trim()) throw new Error("返信案が空");
    // 送料未確定なので、AIが金額を勝手に案内していないこと（品質ゲートの実効確認）。
    if (/送料[はが]?\s*¥?\d[\d,]*円/.test(out)) throw new Error("送料未確定なのに具体的な金額を案内している");
    ok(label, `${ms}ms ${out.length}文字 先頭="${out.slice(0, 60).replace(/\n/g, " ")}…"`);
  } catch (err) {
    ng(label, err);
  }
}

async function main() {
  console.log(`AI_GATEWAY_PROVIDER=${process.env.AI_GATEWAY_PROVIDER ?? "(未設定)"} ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "設定あり" : "(未設定)"}`);
  console.log(`resolveProviderId() => ${resolveProviderId()}\n`);

  await checkListingCopy();
  await checkReplyDraft();

  console.log(`\n${2 - failures} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
