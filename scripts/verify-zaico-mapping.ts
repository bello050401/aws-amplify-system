/**
 * ZAICO → BELLO field mapping の固定回帰テスト
 * (2026-09-02 追加仕様 §20「mapping regression test」)。
 *
 * fixture は **実際のZAICO APIの応答をそのまま保存したもの**
 * (`zaico-verification/fixtures/zaico-raw-items.json` — ZAICO ID
 * 73116696 / 73116698、指示書の固定実例 HAY REVOLVER BAR STOOL HIGH)。
 * 手で書いた擬似データではないので、「fixtureにも同じ架空の値を書いて
 * いたからテストが通っていた」という失敗の仕方をしない。
 *
 * ここが守るのは「input ZAICO → normalize → Inventory」の field-by-field
 * 対応で、監査(docs/zaico-field-mapping-audit-20260902.md)で重要と
 * 判断した項目を固定する。
 *
 * Run with: npm run verify:zaico-mapping
 */
import fs from "node:fs";
import path from "node:path";
import {
  mapZaicoCoreFields,
  mapZaicoOptionalAttributes,
  parseZaicoQuantity,
  resolveZaicoAttributeTarget,
  ZAICO_ATTRIBUTE_MAP,
} from "@/lib/inventory/zaicoMapping";
import { ALL_EXTENDED_FIELDS } from "@/lib/inventory/extendedFields";
import { buildMonthlyAggregates, type SalesMonthlyAggregateRow } from "@/lib/inventory/salesAggregate";
import type { SalesSourceRecord } from "@/lib/inventory/sales";
import type { ZaicoInventory } from "@/lib/zaico/client";

let failures = 0;
let passes = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}
function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

const FIXTURE = path.join(process.cwd(), "zaico-verification/fixtures/zaico-raw-items.json");
const items = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as ZaicoInventory[];
const byId = new Map(items.map((i) => [String(i.id), i]));

function main() {
  console.log("── 1. quantity: ZAICOは文字列で返す ──────────────────────");
  // 実測の根本原因: ZAICO は "2.0" / "1.0" という**文字列**を返す。
  // 以前の `typeof === "number"` 判定では常に null になり、Stagingの
  // Inventory 5,313件が全件 quantity=0 になっていた。
  const w: string[] = [];
  assertEqual(parseZaicoQuantity("2.0", w), 2, 'parseZaicoQuantity("2.0") = 2');
  assertEqual(parseZaicoQuantity("1.0", w), 1, 'parseZaicoQuantity("1.0") = 1');
  assertEqual(parseZaicoQuantity("12", w), 12, 'parseZaicoQuantity("12") = 12');
  assertEqual(parseZaicoQuantity("1,200", w), 1200, "3桁区切りのカンマを許容する");
  assertEqual(parseZaicoQuantity(3, w), 3, "数値で来た場合もそのまま通る");
  assertEqual(parseZaicoQuantity("", w), null, "空文字は null(0にしない)");
  assertEqual(parseZaicoQuantity(null, w), null, "null は null");
  const w2: string[] = [];
  assertEqual(parseZaicoQuantity("abc", w2), null, "数値化できない値は null");
  assertTrue(w2.length === 1, "数値化できなかったことは警告として残る(黙って0にしない)");
  const w3: string[] = [];
  assertEqual(parseZaicoQuantity("2.5", w3), 2, "小数は切り捨て");
  assertTrue(w3.length === 1, "小数を切り捨てたことも警告に残る");

  const item96 = byId.get("73116696")!;
  const item98 = byId.get("73116698")!;
  assertEqual(mapZaicoCoreFields(item96).fields.quantity, 2, "実応答 73116696 の数量 = 2");
  assertEqual(mapZaicoCoreFields(item98).fields.quantity, 1, "実応答 73116698 の数量 = 1");

  console.log("\n── 2. 販売予定価格(指示書§11の本丸) ──────────────────────");
  const opt96 = mapZaicoOptionalAttributes(item96.optional_attributes, true);
  const opt98 = mapZaicoOptionalAttributes(item98.optional_attributes, true);
  assertEqual(opt96.extendedFields.plannedSalePrice, 24800, "73116696 の販売予定価格 = 24800");
  assertEqual(opt98.extendedFields.plannedSalePrice, 24800, "73116698 の販売予定価格 = 24800");
  assertTrue(
    resolveZaicoAttributeTarget("☆販売予定価格（送料別大原記載）").kind === "extendedField",
    "「☆販売予定価格（送料別大原記載）」がマッピング対象になっている",
  );
  // 全角/半角括弧・装飾記号の表記ゆれで壊れないこと(過去に幅/奥行/高さが
  // これで丸ごと落ちた実績があるので、新規項目でも同じ検査をする)。
  assertEqual(
    resolveZaicoAttributeTarget("☆販売予定価格(送料別大原記載)").kind,
    "extendedField",
    "半角括弧で来ても同じ項目として解決できる",
  );

  console.log("\n── 3. 仕入・古物台帳(既存列への配線) ─────────────────────");
  assertEqual(opt96.coreFields.purchasePrice, 10989, "購入価格");
  assertEqual(opt96.extendedFields.counterpartyName, "リステージオークション", "相手氏名");
  assertEqual(opt96.extendedFields.counterpartyOccupation, "リサイクル販売業", "職業");
  assertEqual(opt96.extendedFields.counterpartyAddress, "履歴あり", "住所");
  assertEqual(opt96.extendedFields.transactionType, "買受", "取引区分");
  assertEqual(opt96.extendedFields.purchaseQuantity, 8, "数量(仕入台帳)");
  assertEqual(opt96.extendedFields.transactionDate, "2026-08-07", "取引の年月日");
  assertEqual(opt96.extendedFields.saleStartDate, "2026-08-30", "販売開始日");
  assertTrue(
    (opt96.extendedFields.identityVerificationMethod ?? "").startsWith("対面している相手の"),
    "真偽確認の措置",
  );

  console.log("\n── 4. 寸法・仕様 ─────────────────────────────────────────");
  assertEqual(opt96.extendedFields.width, "座面直径34", "幅(ZAICOの生の文字列をそのまま保持)");
  assertEqual(opt96.extendedFields.depth, "脚幅44", "奥行");
  assertEqual(opt96.extendedFields.height, "75 フットレスト高さ25.5", "高さ");
  assertEqual(opt96.extendedFields.conditionRating, "4", "コンディション評価(波ダッシュ表記ゆれを含む)");
  assertEqual(opt96.extendedFields.damageNotes?.slice(0, 5), "一部小傷や", "傷汚れ箇所等メモ");

  console.log("\n── 5. CustomField(seed済みなのに未配線だったもの) ────────");
  assertEqual(opt96.customFields.packageSize, "家財B", "梱包サイズ = 家財B(送料判定の裏付け)");
  assertEqual(opt96.customFields.usedGoodsFeature, "アルペール　ソファ　椅子　サイドボード", "古物の特徴");

  console.log("\n── 6. 出品情報(値を持つ<<見出し>>) ───────────────────────");
  // 値が空の "<<...>>" はZAICOのUI上の見出し装飾なので従来どおり無視。
  // 値を持つ場合は本文なので listingNotes へ入る。
  assertTrue(
    (opt96.extendedFields.listingNotes ?? "").includes("BASE：27,800円"),
    "出品情報の本文が listingNotes へ入る",
  );
  const decorativeOnly = mapZaicoOptionalAttributes([{ name: "<<出品情報>>", value: "" }], true);
  assertEqual(decorativeOnly.extendedFields.listingNotes, undefined, "値が空の見出しは取り込まない");
  assertEqual(decorativeOnly.unmapped.length, 0, "値が空の見出しは未マッピング警告も出さない");

  console.log("\n── 7. ★市川メモ は createOnly を維持 ────────────────────");
  const onCreate = mapZaicoOptionalAttributes(item98.optional_attributes, true);
  const onUpdate = mapZaicoOptionalAttributes(item98.optional_attributes, false);
  assertEqual(onCreate.extendedFields.adminMemo, "2026081697494", "新規作成時は市川メモを取り込む");
  assertEqual(onUpdate.extendedFields.adminMemo, undefined, "再同期では市川メモを上書きしない");

  console.log("\n── 8. 空値で既存値を壊さない(指示書§18) ─────────────────");
  const empties = mapZaicoOptionalAttributes(
    [
      { name: "☆販売予定価格（送料別大原記載）", value: "" },
      { name: "⚫︎購入価格", value: null },
      { name: "⚪︎幅（cm）", value: "   " },
      { name: "⚪︎梱包サイズ", value: "" },
    ],
    false,
  );
  assertEqual(Object.keys(empties.extendedFields).length, 0, "空の値は extendedFields へ1件も入れない");
  assertEqual(Object.keys(empties.coreFields).length, 0, "空の値は coreFields へ1件も入れない");
  assertEqual(Object.keys(empties.customFields).length, 0, "空の値は customFields へ1件も入れない");
  const badNumber = mapZaicoOptionalAttributes([{ name: "☆販売予定価格（送料別大原記載）", value: "未定" }], false);
  assertEqual(Object.keys(badNumber.extendedFields).length, 0, "数値化できない販売予定価格を0円にしない");
  assertTrue(badNumber.warnings.length === 1, "数値化失敗は警告として残る");

  console.log("\n── 9. マッピング表の整合 ─────────────────────────────────");
  // extendedField を指しているのに、その key が実在しない(タイポ)場合を
  // 機械的に検出する。表とフィールド定義が黙って食い違うのを防ぐ。
  const knownExtendedKeys = new Set(ALL_EXTENDED_FIELDS.map((f) => f.key as string));
  // shippingCost はフォーム入力欄からは外したが列・schema・ZAICO連携は
  // 生きている(extendedFields.ts の該当コメント参照)ため、この照合の
  // 対象からは明示的に除外する。
  knownExtendedKeys.add("shippingCost");
  const badTargets: string[] = [];
  for (const [name, target] of Object.entries(ZAICO_ATTRIBUTE_MAP)) {
    if (target.kind === "extendedField" && !knownExtendedKeys.has(target.field)) badTargets.push(`${name} → ${target.field}`);
  }
  assertEqual(badTargets, [], "extendedField を指す全エントリが実在するフィールドを指している");

  console.log("\n── 10. 実応答の全項目が「既知」であること ────────────────");
  // 実データに現れた optional_attributes のうち、値を持つのに未マッピング
  // のまま残っているものを一覧する。0件であることは要求しない
  // (意図的に取り込まない項目があるため)が、**増えたら気づける**ように
  // 名前を固定する。
  const intentionallyUnmapped = new Set<string>([]);
  const stillUnmapped = new Set<string>();
  for (const it of items) {
    const r = mapZaicoOptionalAttributes(it.optional_attributes, true);
    for (const u of r.unmapped) if (u.value?.trim()) stillUnmapped.add(u.name);
  }
  const unexpected = [...stillUnmapped].filter((n) => !intentionallyUnmapped.has(n));
  assertEqual(unexpected, [], "この2件の実応答には、値を持つ未マッピング項目が残っていない");

  console.log("\n── 11. 「販売価格」表記ゆれ(2026-09-10 利用者指摘) ────────");
  // 利用者指摘: ZAICO側は「販売価格」と呼んでいるのに、BELLO側の表示が
  // 「販売価格(成約)」だったため売上金額が不整合に見えるとの報告。
  // 過去の実データ監査(2026-09-02、この2件の実応答含む全件走査)で確認
  // 済みなのは、正式な optional_attribute 名は常に「⚫︎販売価格」で、
  // そちらは最初からsalePriceへ正しく届いていたこと。表示名はBELLO側
  // (EditInventoryForm/NewInventoryForm/詳細ページ/一覧列)で「販売価格」
  // に統一済み。装飾記号の無い「販売価格」という名前は、その監査時に
  // 1件だけテンプレート見出し行の複製として観測されており(値=名前自体、
  // 実際の金額ではない)、実際の金額付きで届いた場合の備え(将来の保険)
  // として salePrice への防御的aliasを追加している。この表記ゆれが
  // 過去の売上不整合の原因であったかどうかは今回は監査しておらず未確認
  // — ここで固定するのはマッピング関数の挙動であって、本番売上の実地
  // 監査ではない(§8を参照 — ラベル修正だけで過去金額の修復済みとしない)。
  assertEqual(resolveZaicoAttributeTarget("⚫︎販売価格"), { kind: "coreField", field: "salePrice", valueType: "number" }, "正式名「⚫︎販売価格」は従来どおりsalePrice");
  assertEqual(
    resolveZaicoAttributeTarget("販売価格"),
    { kind: "coreField", field: "salePrice", valueType: "number", lowerPriority: true },
    "装飾なし「販売価格」もsalePriceへ解決される(ただしlowerPriority)",
  );

  const salePriceCanonicalOnly = mapZaicoOptionalAttributes([{ name: "⚫︎販売価格", value: "20000" }], false);
  assertEqual(salePriceCanonicalOnly.coreFields.salePrice, 20000, "canonicalのみ: 20000が入る");
  assertEqual(salePriceCanonicalOnly.warnings, [], "canonicalのみ: 警告は出ない");

  const salePricePlainOnly = mapZaicoOptionalAttributes([{ name: "販売価格", value: "12000" }], false);
  assertEqual(salePricePlainOnly.coreFields.salePrice, 12000, "plainのみ: 実数値を持つ場合はsalePriceへ入る(将来の実データ保険)");
  assertEqual(salePricePlainOnly.warnings, [], "plainのみ: aliasが単独で来ただけでは競合ではないので警告は出ない");

  // テンプレート見出し行が値としてラベル文字列そのものを複製するケース
  // (監査の分類F)。数値化できないので書き込まれず、既存値も消えない。
  const salePriceTemplateGarbage = mapZaicoOptionalAttributes([{ name: "販売価格", value: "販売価格" }], false);
  assertEqual(salePriceTemplateGarbage.coreFields.salePrice, undefined, "数値不正: テンプレート見出し行の値(=名前と同じ文字列)はsalePriceへ書き込まれない");
  assertTrue(salePriceTemplateGarbage.warnings.length === 1, "数値不正: 数値化できない値は警告として残る(黙って捨てない)");

  const salePriceSameValueBoth = mapZaicoOptionalAttributes(
    [
      { name: "販売価格", value: "20000" },
      { name: "⚫︎販売価格", value: "20000" },
    ],
    false,
  );
  assertEqual(salePriceSameValueBoth.coreFields.salePrice, 20000, "両方(同じ値): そのまま入る");
  assertEqual(salePriceSameValueBoth.warnings, [], "両方(同じ値): 食い違いではないので警告は出ない");

  // 順序を入れ替えた2パターンで同じ結果になることを確認する — 「複数
  // alias競合時に順序任せ上書きや既存値消失を起こさない」の直接の検証。
  const conflictAliasFirst = mapZaicoOptionalAttributes(
    [
      { name: "販売価格", value: "99999" },
      { name: "⚫︎販売価格", value: "20000" },
    ],
    false,
  );
  const conflictCanonicalFirst = mapZaicoOptionalAttributes(
    [
      { name: "⚫︎販売価格", value: "20000" },
      { name: "販売価格", value: "99999" },
    ],
    false,
  );
  assertEqual(conflictAliasFirst.coreFields.salePrice, 20000, "両方(食い違い・alias先頭): 正式名「⚫︎販売価格」が勝つ");
  assertEqual(conflictCanonicalFirst.coreFields.salePrice, 20000, "両方(食い違い・正式名先頭): 結果は同じ(配列順序に依存しない)");
  assertTrue(conflictAliasFirst.warnings.length === 1, "両方(食い違い・alias先頭): 負けた側の値は警告として報告される(黙って消さない)");
  assertTrue(conflictCanonicalFirst.warnings.length === 1, "両方(食い違い・正式名先頭): 同じく警告が残る");
  assertEqual(conflictAliasFirst.warnings, conflictCanonicalFirst.warnings, "警告文も配列順序に依存せず同一");
  // 警告には項目名と「競合が発生した」ことだけを書き、実際の金額や
  // ZAICO生の属性名(個人情報が混入し得るcustomField同様の性質)は含め
  // ない — ログ経由の新たな情報流出経路にしないため。
  assertTrue(!conflictAliasFirst.warnings[0].includes("99999"), "警告に負けた側の値を含まない");
  assertTrue(!conflictAliasFirst.warnings[0].includes("20000"), "警告に勝った側の値も含まない");
  assertTrue(!conflictAliasFirst.warnings[0].includes("⚫︎"), "警告にZAICO生の属性名を含まない");

  // 同一canonical複数: QA指摘(旧taskの`find`実装は配列先頭のcanonicalを
  // 選んでいたため、他フィールドの「後勝ち(last-write)」仕様と食い違って
  // いた)。canonical同士の優先度は同点なので、後方が勝つのが正しい。
  const dupCanonical = mapZaicoOptionalAttributes(
    [
      { name: "⚫︎販売価格", value: "10000" },
      { name: "⚫︎販売価格", value: "30000" },
    ],
    false,
  );
  assertEqual(dupCanonical.coreFields.salePrice, 30000, "同一canonical複数: 後方(last-write)が勝つ(先頭ではない)");
  assertEqual(dupCanonical.warnings, [], "同一canonical複数: aliasが絡まない同名重複は競合警告を出さない(他フィールドと同じ)");

  // 同一plain複数: canonicalが無い場合もplain同士は同点なので後方が勝つ。
  const dupPlain = mapZaicoOptionalAttributes(
    [
      { name: "販売価格", value: "10000" },
      { name: "販売価格", value: "30000" },
    ],
    false,
  );
  assertEqual(dupPlain.coreFields.salePrice, 30000, "同一plain複数: 後方(last-write)が勝つ");
  assertEqual(dupPlain.warnings, [], "同一plain複数: canonicalが無いので「正式名を優先した」という警告は出さない(実際の選択と説明が一致)");

  // 同一canonical複数 + alias: canonical側の後勝ちで確定した値とaliasが
  // 食い違う場合のみ競合警告を出す(選択したラベル種別の説明が実際の
  // 選択と一致することの検証)。
  const dupCanonicalPlusAlias = mapZaicoOptionalAttributes(
    [
      { name: "⚫︎販売価格", value: "10000" },
      { name: "⚫︎販売価格", value: "30000" },
      { name: "販売価格", value: "30000" },
    ],
    false,
  );
  assertEqual(dupCanonicalPlusAlias.coreFields.salePrice, 30000, "同一canonical複数+alias: canonical側の後勝ち値が最終的に勝つ");
  assertEqual(dupCanonicalPlusAlias.warnings, [], "同一canonical複数+alias: aliasの値がcanonicalの勝者と一致していれば警告は出ない");

  // 予定価格・購入価格との混同がないこと(指示書§4「予定価格/購入価格と
  // 混同しない」)。
  const noCrossConfusion = mapZaicoOptionalAttributes(
    [
      { name: "☆販売予定価格(送料別大原記載)", value: "24800" },
      { name: "⚫︎購入価格", value: "5000" },
      { name: "⚫︎販売価格", value: "20000" },
    ],
    false,
  );
  assertEqual(noCrossConfusion.extendedFields.plannedSalePrice, 24800, "販売予定価格は別枠のまま");
  assertEqual(noCrossConfusion.coreFields.purchasePrice, 5000, "購入価格は別枠のまま");
  assertEqual(noCrossConfusion.coreFields.salePrice, 20000, "販売価格はsalePriceのまま");

  // カンマ円表記・ゼロ・空欄・不正値(指示書§7のテスト項目)。
  assertEqual(mapZaicoOptionalAttributes([{ name: "⚫︎販売価格", value: "22,800" }], false).coreFields.salePrice, 22800, "カンマ区切りの円表記を数値化できる");
  assertEqual(mapZaicoOptionalAttributes([{ name: "⚫︎販売価格", value: "0" }], false).coreFields.salePrice, 0, "0円は0として書き込む(空欄扱いにしない)");
  assertEqual(mapZaicoOptionalAttributes([{ name: "⚫︎販売価格", value: "" }], false).coreFields.salePrice, undefined, "空値: 空欄は書き込まない(既存値を消さない)");
  const invalidPlainOnly = mapZaicoOptionalAttributes([{ name: "販売価格", value: "未定" }], false);
  assertEqual(invalidPlainOnly.coreFields.salePrice, undefined, "数値不正(plainのみ)は書き込まない");
  assertTrue(invalidPlainOnly.warnings.length === 1, "数値不正(plainのみ)は警告に残る");

  console.log("\n── 12. salePrice以外は同名重複でも従来のlast-write挙動を維持 ──");
  // 他項目重複不変: salePriceのalias優先処理を全target slotへ一般化して
  // しまうと、これまで有効だった「同じBELLOフィールドを指す複数のZAICO
  // 属性名は配列の後方(last-write)が勝つ」という挙動が、全フィールドで
  // 先勝ち(first-write)に変わってしまう回帰があった(QA指摘)。この修正
  // はsalePriceの2つのalias間だけへ処理を限定しているので、他の全フィ
  // ールドではここより前の同名重複が「後勝ち」のまま変わらないことを
  // 固定する。
  const dupCustomField = mapZaicoOptionalAttributes(
    [
      { name: "⚪︎梱包サイズ", value: "家財A" },
      { name: "⚪︎梱包サイズ", value: "家財B" },
    ],
    false,
  );
  assertEqual(dupCustomField.customFields.packageSize, "家財B", "他項目重複不変(customField): 同名重複は後勝ち(last-write)のまま");
  assertEqual(dupCustomField.warnings, [], "他項目重複不変(customField): 競合警告を出さない(salePrice専用の処理範囲外)");

  const dupExtendedField = mapZaicoOptionalAttributes(
    [
      { name: "⚫︎販売終了日", value: "2026-01-01" },
      { name: "⚫︎販売終了日", value: "2026-02-02" },
    ],
    false,
  );
  assertEqual(dupExtendedField.extendedFields.saleEndDate, "2026-02-02", "他項目重複不変(extendedField): 同名重複は後勝ち(last-write)のまま");

  const dupPurchasePrice = mapZaicoOptionalAttributes(
    [
      { name: "⚫︎購入価格", value: "1000" },
      { name: "⚫︎購入価格", value: "2000" },
    ],
    false,
  );
  assertEqual(dupPurchasePrice.coreFields.purchasePrice, 2000, "他項目重複不変(purchasePrice): coreFieldだがsalePriceではないので同名重複も後勝ちのまま");

  console.log("\n── 13. 販売価格から売上集計への対応(コード上の配線の検証) ──");
  // salePrice→集計の対応そのものをコード上の合成ケースで検証する。実際
  // の本番データに対する再集計・再同期はここでは行わない(§8「ラベル
  // 修正だけで過去金額を修復済みとしない」)。ここで固定するのは、
  // mapZaicoOptionalAttributes が書き込む coreFields.salePrice が、
  // buildMonthlyAggregates の totalSales/totalProfit に**そのまま**
  // 反映される配線であって、本番の実データ照合ではない。
  const syntheticSalePrice = mapZaicoOptionalAttributes([{ name: "⚫︎販売価格", value: "50000" }], false).coreFields.salePrice;
  assertEqual(syntheticSalePrice, 50000, "配線検証: マッピングが返すsalePriceの値");
  const syntheticRecords: SalesSourceRecord[] = [
    {
      id: "synthetic-1",
      displayId: "SYN-1",
      sku: "SYN-1",
      name: "合成テスト商品",
      saleEndDate: "2026-09-15",
      salePrice: syntheticSalePrice ?? null,
      purchasePrice: 20000,
      shippingCost: 0,
    },
  ];
  const syntheticAggregate: SalesMonthlyAggregateRow[] = buildMonthlyAggregates(syntheticRecords);
  const septemberRow = syntheticAggregate.find((r) => r.yearMonth === "2026-09");
  assertEqual(septemberRow?.totalSales, 50000, "配線検証: mapZaicoOptionalAttributesのsalePriceがbuildMonthlyAggregatesのtotalSalesへそのまま届く");
  assertEqual(septemberRow?.totalProfit, 30000, "配線検証: 売上集計の粗利計算にも同じsalePriceが使われる(50000 - 20000)");

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
