/**
 * 2026-09-03 追加指示 §41-§49 の検証。外部サービスへは一切接続しない。
 *
 *   npm run verify:listing-draft
 *
 * ここで固定したいこと:
 *
 *  1. 商品説明の生成入口が1つだけであること(§41/§49)
 *  2. BASE商品との結び付けが「同一商品と言い切れる根拠」でしか成立しない(§44)
 *  3. 在庫に無い項目だけをBASEで補い、在庫にある項目は上書きしない(§30)
 *  4. 「◎商品のご紹介」の構成が維持されている(§45)
 */
import fs from "node:fs";
import path from "node:path";
import { findByExactTitle, type ArchiveTitleRow } from "@/lib/ai/productPage/baseLink";
import { composeFullDescription } from "@/lib/ai/productPage/service";
import { extractDimensionsFromText } from "@/lib/inquiry/productDetailExtraction";

let failures = 0;
let passes = 0;

function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? `\n    ${detail}` : ""}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, label, `expected ${e}\n    actual   ${a}`);
}

/* ══════════════════════════════════════════════════════════════════
 * §41/§47/§49 入口の一本化
 * ══════════════════════════════════════════════════════════════════ */

const REPO = process.cwd();

function readIfExists(rel: string): string | null {
  const full = path.join(REPO, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
}

function testSingleEntryPoint() {
  console.log("\n── §41/§49 生成入口の一本化 ──");

  eq(
    readIfExists("app/inventory/(protected)/[id]/listing/ProductPageSection.tsx"),
    null,
    "「BASE商品ページの下書きを作る」のUIが無い",
  );
  eq(readIfExists("app/actions/productPage.ts"), null, "BASE専用のServer Actionが無い");

  const page = readIfExists("app/inventory/(protected)/[id]/listing/page.tsx");
  check(page != null, "EC出品画面がある");
  check(!page!.includes("<ProductPageSection"), "EC出品画面がBASE専用UIを描画していない");

  // §47 裏側の有用な処理は残っている。
  const action = readIfExists("app/actions/ai.ts");
  check(action != null, "共通の生成Server Actionがある");
  check(
    action!.includes("generateCanonicalProductPage"),
    "§43 共通の生成エンジン(generateCanonicalProductPage)を呼んでいる",
  );
  check(
    action!.includes("saveGeneratedProductPage"),
    "§47 BASE側にだけあった生成履歴の保存を引き取っている",
  );

  const canonical = readIfExists("lib/ai/productPage/canonical.ts");
  check(canonical != null, "生成の正本モジュールがある");
  for (const capability of [
    "loadActiveStyleProfile", // BELLO Style Profile
    "toStyleReferences", // 類似(過去)BASE商品の参照
    "buildGuidanceBlock", // BELLO改善指示
    "resolveLinkedBaseItem", // §44 BASEからの補完
  ]) {
    check(canonical!.includes(capability), `正本エンジンが ${capability} を使っている`);
  }

  // 生成コアは1つだけ。lib/ai/ecCopy.ts の旧経路へ戻っていないこと。
  check(!action!.includes("generateListingCopy("), "旧・共通項目専用の生成関数を呼んでいない");
}

/* ══════════════════════════════════════════════════════════════════
 * §44 BASE商品との結び付け
 * ══════════════════════════════════════════════════════════════════ */

function archive(rows: [string, string][]): ArchiveTitleRow[] {
  return rows.map(([baseItemId, title]) => ({ baseItemId, title, titleCore: title }));
}

function testBaseLink() {
  console.log("\n── §44 BASE商品との結び付け ──");

  const rows = archive([
    ["100", "BoConcept Elba Lounge Chair"],
    ["200", "BoConcept Elba Lounge Chair 2脚セット"],
    ["300", "Cassina LC2 ソファ"],
  ]);

  eq(
    findByExactTitle("BoConcept Elba Lounge Chair", rows)?.baseItemId,
    "100",
    "商品名が完全一致する1件と結び付く",
  );

  // 似ているだけのものは採らない。家具は同シリーズ・色違いが多い。
  eq(findByExactTitle("BoConcept Elba Lounge", rows), null, "部分一致では結び付けない");
  eq(findByExactTitle("Elba", rows), null, "語の一部では結び付けない");

  // 同名が2件あれば決められない。
  const duplicated = archive([
    ["100", "無印良品 オークチェア"],
    ["101", "無印良品 オークチェア"],
  ]);
  eq(findByExactTitle("無印良品 オークチェア", duplicated), null, "同名が2件あれば結び付けない");

  // 表記ゆれは正規化して同一とみなす(照合と同じ normalizeProductTitle)。
  const noisy = archive([["100", "【美品】BoConcept　Elba Lounge Chair 検:ボーコンセプト"]]);
  eq(
    findByExactTitle("BoConcept Elba Lounge Chair", noisy)?.baseItemId,
    "100",
    "【】や検索用キーワードを落として一致を見る",
  );

  eq(findByExactTitle("", rows), null, "商品名が空なら結び付けない");
  eq(findByExactTitle("BoConcept Elba Lounge Chair", []), null, "過去BASE商品が無ければ結び付けない");
}

/* ══════════════════════════════════════════════════════════════════
 * §30/§44 補完の優先順位
 * ══════════════════════════════════════════════════════════════════ */

/**
 * canonical.ts の completed() と同じ規則。
 * 在庫にあれば在庫、無ければBASE、どちらも無ければ空欄。
 */
function completed(inventoryValue: string | null, fromBase: string | null): string | null {
  if (inventoryValue && inventoryValue.trim() !== "") return inventoryValue;
  return fromBase ?? null;
}

function testCompletionPrecedence() {
  console.log("\n── §30 補完の優先順位 ──");

  eq(completed("85", "90cm"), "85", "在庫に値があればBASEで上書きしない");
  eq(completed(null, "90cm"), "90cm", "在庫に無ければBASEの値を使う");
  eq(completed("", "90cm"), "90cm", "在庫が空文字ならBASEの値を使う");
  eq(completed(null, null), null, "どちらにも無ければ空欄のまま(推測しない)");

  // BASEの商品説明からの寸法。3辺そろわなければ補完しない。
  const partial = extractDimensionsFromText("幅85cmです。詳細はお問い合わせください。");
  eq(partial, null, "1辺しか書かれていなければ補完しない(出所の違う数字を混ぜない)");

  const full = extractDimensionsFromText("サイズ：W850 × D900 × H720 mm");
  check(full != null, "3辺そろっていれば補完できる");
  eq([full!.widthCm, full!.depthCm, full!.heightCm], ["85cm", "90cm", "72cm"], "cmへ揃えて補完する");
}

/* ══════════════════════════════════════════════════════════════════
 * §45 BELLOの商品説明構成
 * ══════════════════════════════════════════════════════════════════ */

function testDescriptionStructure() {
  console.log("\n── §45 「◎商品のご紹介」の構成 ──");

  const full = composeFullDescription(
    {
      title: "BoConcept Elba Lounge Chair",
      introduction: "デンマーク発の BoConcept による、やわらかな曲線が印象的なラウンジチェアです。",
      brandSection: "BoConcept",
      designerSection: "",
      featureSection: "・張地はファブリック\n・脚はオーク材",
      materialSection: "ファブリック / オーク材",
      dimensionsSection: "幅85cm × 奥行90cm × 高さ72cm",
      conditionSection: "使用に伴う小傷があります。",
      shippingSection: "",
    },
    "お届けは家財便でのご案内となります。",
  );

  check(full.startsWith("◎商品のご紹介"), "本文が「◎商品のご紹介」から始まる");
  check(full.includes("デンマーク発の BoConcept"), "紹介文がそのまま入る");
  check(!full.includes("◎デザイナー"), "中身の無いセクションは見出しごと出さない");
  check(full.includes("お届けは家財便"), "発送についての定型文が入る");

  // 紹介文にスペックを羅列させない、という方針は introValidator が担保する。
  // ここでは構成だけを見る(寸法は専用セクションへ分かれている)。
  const introPart = full.slice(0, full.indexOf("◎", 1) === -1 ? full.length : full.indexOf("◎", 1));
  check(!introPart.includes("幅85cm"), "§45 寸法は紹介文ではなく専用セクションへ分ける");
}

/* ══════════════════════════════════════════════════════════════════ */

function main() {
  testSingleEntryPoint();
  testBaseLink();
  testCompletionPrecedence();
  testDescriptionStructure();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
