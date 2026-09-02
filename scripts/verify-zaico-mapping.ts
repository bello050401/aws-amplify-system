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

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
