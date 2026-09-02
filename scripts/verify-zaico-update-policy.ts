/**
 * ZAICO同期の項目別 更新優先順位の回帰テスト。
 *
 * 固定ケースは **Staging の実データで実際に起きた事故** をそのまま
 * 再現したもの。作り話ではないので、直したつもりで直っていなければ
 * ここが落ちる。
 *
 * Run with: npm run verify:zaico-update-policy
 */
import { mergeZaicoUpdate } from "@/lib/inventory/zaicoSyncMerge";
import {
  DEFAULT_POLICY,
  ZAICO_FIELD_RULES,
  buildZaicoSnapshot,
  isEmptyValue,
  parseSnapshot,
  policyFor,
  resolveCustomFields,
  resolveFieldUpdate,
  shouldReportKeep,
  valuesEqual,
} from "@/lib/inventory/zaicoUpdatePolicy";

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

/* ══════════════════════════════════════════════════════════════════
 * 1. 実際に起きた事故そのもの — カテゴリの差し戻し
 * ══════════════════════════════════════════════════════════════════ */
function testCategoryRevertIncident() {
  // 実データ: inv=3026f919 / inv=9793e4e5
  //   ZAICO は一貫して「発送完了」を渡している。
  //   人が BELLO 側で「補修待ち」へ変更した。
  //   次の同期が「発送完了」へ差し戻した。 ← これを起こさない
  const decision = resolveFieldUpdate({
    field: "categoryId",
    zaicoValue: "発送完了",
    belloValue: "補修待ち", // 人が変更した
    lastZaicoValue: "発送完了", // 前回もZAICOは発送完了と言っていた
  });
  assertEqual(decision.action, "KEEP", "カテゴリ: 人が変えた値をZAICOで差し戻さない(実際に起きた事故)");
  assertTrue(decision.reason.includes("人が変更"), "カテゴリ: 据え置いた理由が記録される");

  // 人が触っていなければ、ZAICOの変更はきちんと反映される。
  const untouched = resolveFieldUpdate({
    field: "categoryId",
    zaicoValue: "発送完了",
    belloValue: "販売中",
    lastZaicoValue: "販売中", // 前回のZAICO値のまま = 誰も触っていない
  });
  assertEqual(untouched.action, "APPLY", "カテゴリ: 人が触っていなければZAICOの変更を反映する");
  assertEqual((untouched as { value: unknown }).value, "発送完了", "カテゴリ: 反映される値");

  // スナップショットが無い初回は、判断材料が無いので据え置く。
  const unknown = resolveFieldUpdate({
    field: "categoryId",
    zaicoValue: "発送完了",
    belloValue: "補修待ち",
    lastZaicoValue: undefined,
  });
  assertEqual(unknown.action, "KEEP", "カテゴリ: 前回値が無ければ据え置く(人の入力を消す側へ倒さない)");

  // 新規作成なら人の編集は存在しない。
  const created = resolveFieldUpdate({
    field: "categoryId",
    zaicoValue: "販売中",
    belloValue: null,
    lastZaicoValue: undefined,
    isNewRecord: true,
  });
  assertEqual(created.action, "APPLY", "カテゴリ: 新規作成では常にZAICOを入れる");
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 販売予定価格 — 人が入れた2件を上書きしない
 * ══════════════════════════════════════════════════════════════════ */
function testPlannedSalePrice() {
  // 実データ: B005610  BELLO 28,000(人が入力) vs ZAICO 24,800
  const b005610 = resolveFieldUpdate({
    field: "plannedSalePrice",
    zaicoValue: 24800,
    belloValue: 28000,
    lastZaicoValue: undefined,
  });
  assertEqual(b005610.action, "KEEP", "販売予定価格: B005610(人が28,000を入力)をZAICOの24,800で上書きしない");

  // 実データ: B005413  BELLO 30,004(人が入力) vs ZAICO 34,800
  const b005413 = resolveFieldUpdate({
    field: "plannedSalePrice",
    zaicoValue: 34800,
    belloValue: 30004,
    lastZaicoValue: undefined,
  });
  assertEqual(b005413.action, "KEEP", "販売予定価格: B005413(人が30,004を入力)をZAICOの34,800で上書きしない");

  // 空欄なら補完する。これが本来の目的(全5,313件中2件しか入っていなかった)。
  const empty = resolveFieldUpdate({
    field: "plannedSalePrice",
    zaicoValue: 24800,
    belloValue: null,
    lastZaicoValue: undefined,
  });
  assertEqual(empty.action, "APPLY", "販売予定価格: BELLOが空欄なら補完する");
  assertEqual((empty as { value: unknown }).value, 24800, "販売予定価格: 補完される値");

  // 0 は「空」ではない。0円という入力を空欄扱いして上書きしない。
  const zero = resolveFieldUpdate({
    field: "plannedSalePrice",
    zaicoValue: 24800,
    belloValue: 0,
    lastZaicoValue: undefined,
  });
  assertEqual(zero.action, "KEEP", "販売予定価格: 0 は空欄ではない(0円の入力を上書きしない)");
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 寸法 — 人が補った外形寸法を潰さない
 * ══════════════════════════════════════════════════════════════════ */
function testDimensions() {
  // ZAICOの幅は「座面直径34」で送料判定に使えない。人が外形の「72」を
  // 入れたなら、毎回の同期でそれを潰してはいけない。
  const corrected = resolveFieldUpdate({
    field: "width",
    zaicoValue: "座面直径34",
    belloValue: "72",
    lastZaicoValue: undefined,
  });
  assertEqual(corrected.action, "KEEP", "幅: 人が入れた外形寸法をZAICOの座面寸法で潰さない");

  const empty = resolveFieldUpdate({
    field: "height",
    zaicoValue: "75 フットレスト高さ25.5",
    belloValue: null,
    lastZaicoValue: undefined,
  });
  assertEqual(empty.action, "APPLY", "高さ: BELLOが空欄なら補完する");

  for (const f of ["width", "depth", "height", "overallLength"]) {
    assertEqual(policyFor(f), "FILL_IF_EMPTY", `${f}: 空欄補完の方針`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 4. 追加項目 — 人が消したキーを戻さない
 * ══════════════════════════════════════════════════════════════════ */
function testCustomFields() {
  // 実データ: 人が seatDimensions を削除した履歴があるのに現在値には戻っている。
  const deleted = resolveCustomFields({
    zaico: { seatDimensions: "幅36×奥行40×高さ46", packageSize: "家財B" },
    bello: {}, // 人が消した
    lastZaico: { seatDimensions: "幅36×奥行40×高さ46" }, // 前回もZAICOは渡していた
  });
  assertEqual(deleted.keptDeleted, ["seatDimensions"], "追加項目: 人が消したキーを戻さない");
  assertEqual(deleted.applied, ["packageSize"], "追加項目: 前回渡していなかった新しいキーは入れる");
  assertEqual(deleted.merged.seatDimensions, undefined, "追加項目: 消したキーは結果にも入らない");
  assertEqual(deleted.merged.packageSize, "家財B", "追加項目: 新しいキーは結果に入る");

  // 人が書き換えたキーは据え置く。
  const modified = resolveCustomFields({
    zaico: { seatDimensions: "幅36×奥行40×高さ46" },
    bello: { seatDimensions: "幅36×奥行40×高さ46(実測)" },
    lastZaico: { seatDimensions: "幅36×奥行40×高さ46" },
  });
  assertEqual(modified.keptModified, ["seatDimensions"], "追加項目: 人が書き換えたキーを据え置く");
  assertEqual(modified.merged.seatDimensions, "幅36×奥行40×高さ46(実測)", "追加項目: 人の値が残る");

  // 誰も触っていなければZAICOの更新は反映される。
  const untouched = resolveCustomFields({
    zaico: { packageSize: "家財C" },
    bello: { packageSize: "家財B" },
    lastZaico: { packageSize: "家財B" },
  });
  assertEqual(untouched.applied, ["packageSize"], "追加項目: 誰も触っていなければZAICOの変更を反映する");
  assertEqual(untouched.merged.packageSize, "家財C", "追加項目: 反映される値");

  // 前回値が分からないキーは据え置く。
  const unknown = resolveCustomFields({
    zaico: { material: "ガラス" },
    bello: { material: "強化ガラス" },
    lastZaico: undefined,
  });
  assertEqual(unknown.keptModified, ["material"], "追加項目: 前回値が無ければ据え置く");

  // 新規作成なら全部入れる。
  const created = resolveCustomFields({
    zaico: { packageSize: "家財B", material: "木" },
    bello: {},
    lastZaico: undefined,
    isNewRecord: true,
  });
  assertEqual(created.applied.sort(), ["material", "packageSize"], "追加項目: 新規作成では全部入れる");
}

/* ══════════════════════════════════════════════════════════════════
 * 5. 個別判断 / ZAICO常時優先
 * ══════════════════════════════════════════════════════════════════ */
function testOtherPolicies() {
  const conflict = resolveFieldUpdate({
    field: "salePrice",
    zaicoValue: 46220,
    belloValue: 46222,
    lastZaicoValue: 46220,
  });
  assertEqual(conflict.action, "CONFLICT", "販売価格(成約): 食い違いは自動判断せず人へ出す");
  assertEqual((conflict as { belloValue: unknown }).belloValue, 46222, "販売価格: BELLO側の値を提示する");
  assertEqual((conflict as { zaicoValue: unknown }).zaicoValue, 46220, "販売価格: ZAICO側の値を提示する");

  const always = resolveFieldUpdate({
    field: "quantity",
    zaicoValue: 2,
    belloValue: 0,
    lastZaicoValue: 1,
  });
  assertEqual(always.action, "APPLY", "数量: ZAICOが常に優先");

  // 表に無い項目は既定(ZAICO常時優先)。
  assertEqual(policyFor("saleEndDate"), DEFAULT_POLICY, "表に無い項目は既定の方針になる");
  assertEqual(DEFAULT_POLICY, "ZAICO_ALWAYS", "既定はZAICO常時優先(台帳項目が大半のため)");
}

/* ══════════════════════════════════════════════════════════════════
 * 6. 全方針に共通の安全規則
 * ══════════════════════════════════════════════════════════════════ */
function testUniversalSafety() {
  for (const field of ["categoryId", "plannedSalePrice", "width", "quantity", "salePrice", "name"]) {
    const empty = resolveFieldUpdate({ field, zaicoValue: null, belloValue: "既存の値", lastZaicoValue: "既存の値" });
    assertEqual(empty.action, "KEEP", `${field}: ZAICO側が空なら既存値を消さない`);
    const blank = resolveFieldUpdate({ field, zaicoValue: "   ", belloValue: "既存の値", lastZaicoValue: "既存の値" });
    assertEqual(blank.action, "KEEP", `${field}: ZAICO側が空白のみでも既存値を消さない`);
  }

  // 型が違うだけの同じ値で「変わった」と誤判定しない。
  assertTrue(valuesEqual(1, "1"), "比較: 数値1と文字列\"1\"は同じ");
  assertTrue(valuesEqual(" 発送完了 ", "発送完了"), "比較: 前後空白は無視する");
  assertTrue(!valuesEqual("発送完了", "補修待ち"), "比較: 違う値は違う");
  assertTrue(isEmptyValue(null) && isEmptyValue(undefined) && isEmptyValue("") && isEmptyValue("  "), "空判定");
  assertTrue(!isEmptyValue(0), "0 は空ではない");
}

/* ══════════════════════════════════════════════════════════════════
 * 7. スナップショット
 * ══════════════════════════════════════════════════════════════════ */
function testSnapshot() {
  const snap = buildZaicoSnapshot({ categoryId: "発送完了", plannedSalePrice: 24800, width: "", height: null });
  assertEqual(snap, { categoryId: "発送完了", plannedSalePrice: 24800 }, "スナップショット: 空の値は残さない");

  assertEqual(parseSnapshot(JSON.stringify(snap)), snap, "スナップショット: 読み書きが往復する");
  assertEqual(parseSnapshot(null), undefined, "スナップショット: 未記録は undefined");
  assertEqual(parseSnapshot("{壊れたJSON"), undefined, "スナップショット: 壊れていたら未記録として扱う(安全側)");
  assertEqual(parseSnapshot("[1,2,3]"), undefined, "スナップショット: 配列は不正として扱う");

  // ★ 重要: スナップショットは「ZAICOが何と言ってきたか」を記録する。
  //   BELLOへ実際に書き込んだ値ではない。ここを取り違えると、人が変更した
  //   項目が次回「前回値と同じ」に見えて2回目の同期で上書きされる。
  const zaicoSaid = "発送完了";
  const belloKept = "補修待ち";
  const snapshot = buildZaicoSnapshot({ categoryId: zaicoSaid });
  assertEqual(snapshot.categoryId, zaicoSaid, "スナップショットにはZAICOの値が入る(BELLOの値ではない)");

  // 2回目の同期でも据え置かれること。
  const second = resolveFieldUpdate({
    field: "categoryId",
    zaicoValue: zaicoSaid,
    belloValue: belloKept,
    lastZaicoValue: snapshot.categoryId,
  });
  assertEqual(second.action, "KEEP", "2回目の同期でも人の変更が据え置かれる(上書きの先送りにならない)");
}

/* ══════════════════════════════════════════════════════════════════
 * 8. 方針表そのものの健全性
 * ══════════════════════════════════════════════════════════════════ */
function testRuleTable() {
  const fields = ZAICO_FIELD_RULES.map((r) => r.field);
  assertEqual(new Set(fields).size, fields.length, "方針表に同じ項目が2度出てこない");
  assertTrue(
    ZAICO_FIELD_RULES.every((r) => r.reason.trim().length >= 20),
    "全項目に、なぜその方針かの理由が書かれている",
  );
  // 利用者が名指しした項目が漏れていないこと。
  for (const f of ["categoryId", "customFields", "plannedSalePrice", "salePrice", "width", "depth", "height"]) {
    assertTrue(fields.includes(f), `利用者が名指しした項目が方針表にある: ${f}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 9. 同期エンジンへの結線(mergeZaicoUpdate)
 * ══════════════════════════════════════════════════════════════════ */
function testMergeIntegration() {
  // 実際に起きた事故の再現: ZAICOは「発送完了」、人は「補修待ち」。
  const incident = mergeZaicoUpdate({
    zaico: {
      categoryId: "cat-shipped",
      name: "IDEE ダイニングテーブル",
      quantity: 1,
      extendedFields: {},
      customFields: {},
    },
    bello: {
      categoryId: "cat-repair", // 人が変更
      name: "IDEE ダイニングテーブル",
      quantity: 1,
      extendedFields: {},
      customFields: {},
    },
    snapshotJson: JSON.stringify({ categoryId: "cat-shipped", name: "IDEE ダイニングテーブル", quantity: 1 }),
    isNewRecord: false,
  });
  assertEqual(incident.updates.categoryId, undefined, "結線: 人が変えたカテゴリを更新対象に含めない");
  assertEqual(incident.skipped.length, 1, "結線: 据え置いた項目が1件報告される");
  assertEqual(incident.skipped[0].field, "categoryId", "結線: 据え置いたのはカテゴリ");
  assertEqual(incident.hasChanges, false, "結線: 他に差分が無ければ書き込む必要が無い");

  // 人が触っていなければ、カテゴリの変更はきちんと入る。
  const normal = mergeZaicoUpdate({
    zaico: { categoryId: "cat-shipped", extendedFields: {}, customFields: {} },
    bello: { categoryId: "cat-onsale", extendedFields: {}, customFields: {} },
    snapshotJson: JSON.stringify({ categoryId: "cat-onsale" }),
    isNewRecord: false,
  });
  assertEqual(normal.updates.categoryId, "cat-shipped", "結線: 誰も触っていなければカテゴリを更新する");
  assertEqual(normal.skipped.length, 0, "結線: 据え置きの報告は出ない");
  assertTrue(normal.hasChanges, "結線: 書き込みが必要と判定される");

  // 販売予定価格: 人が入れた値を上書きせず、空欄なら補完する。
  const planned = mergeZaicoUpdate({
    zaico: { extendedFields: { plannedSalePrice: 24800 }, customFields: {} },
    bello: { extendedFields: { plannedSalePrice: 28000 }, customFields: {} },
    snapshotJson: null,
    isNewRecord: false,
  });
  assertEqual(planned.extendedFields.plannedSalePrice, undefined, "結線: 人が入れた販売予定価格を上書きしない");

  const plannedEmpty = mergeZaicoUpdate({
    zaico: { extendedFields: { plannedSalePrice: 24800 }, customFields: {} },
    bello: { extendedFields: {}, customFields: {} },
    snapshotJson: null,
    isNewRecord: false,
  });
  assertEqual(plannedEmpty.extendedFields.plannedSalePrice, 24800, "結線: 空欄なら販売予定価格を補完する");

  // 販売価格の食い違いは conflict として報告し、書き込まない。
  const conflict = mergeZaicoUpdate({
    zaico: { salePrice: 46220, extendedFields: {}, customFields: {} },
    bello: { salePrice: 46222, extendedFields: {}, customFields: {} },
    snapshotJson: JSON.stringify({ salePrice: 46220 }),
    isNewRecord: false,
  });
  assertEqual(conflict.updates.salePrice, undefined, "結線: 販売価格の食い違いは自動で書き込まない");
  assertEqual(conflict.conflicts.length, 1, "結線: 食い違いが1件報告される");
  assertEqual(conflict.conflicts[0].field, "salePrice", "結線: 食い違いの項目名");

  // スナップショットは「ZAICOが言ってきた値」。2回目でも据え置かれる。
  const snap = JSON.parse(incident.nextSnapshotJson);
  assertEqual(snap.categoryId, "cat-shipped", "結線: スナップショットにはZAICOの値が入る");
  const second = mergeZaicoUpdate({
    zaico: { categoryId: "cat-shipped", extendedFields: {}, customFields: {} },
    bello: { categoryId: "cat-repair", extendedFields: {}, customFields: {} },
    snapshotJson: incident.nextSnapshotJson,
    isNewRecord: false,
  });
  assertEqual(second.updates.categoryId, undefined, "結線: 2回目の同期でも据え置かれる(先送りにならない)");

  // 追加項目はキー単位。人が消したキーを戻さず、新しいキーは入れる。
  const cf = mergeZaicoUpdate({
    zaico: { extendedFields: {}, customFields: { seatDimensions: "幅36×奥行40×高さ46", packageSize: "家財B" } },
    bello: { extendedFields: {}, customFields: {} },
    snapshotJson: JSON.stringify({ __customFields: { seatDimensions: "幅36×奥行40×高さ46" } }),
    isNewRecord: false,
  });
  assertEqual(cf.customFields.seatDimensions, undefined, "結線: 人が消した追加項目を戻さない");
  assertEqual(cf.customFields.packageSize, "家財B", "結線: 新しい追加項目は入れる");

  // 新規作成では全部入る。
  const created = mergeZaicoUpdate({
    zaico: {
      categoryId: "cat-onsale",
      name: "新商品",
      quantity: 2,
      extendedFields: { plannedSalePrice: 24800, width: "座面直径34" },
      customFields: { packageSize: "家財B" },
    },
    bello: { extendedFields: {}, customFields: {} },
    snapshotJson: null,
    isNewRecord: true,
  });
  assertEqual(created.updates.categoryId, "cat-onsale", "新規作成: カテゴリが入る");
  assertEqual(created.updates.quantity, 2, "新規作成: 数量が入る");
  assertEqual(created.extendedFields.plannedSalePrice, 24800, "新規作成: 販売予定価格が入る");
  assertEqual(created.extendedFields.width, "座面直径34", "新規作成: 寸法が入る");
  assertEqual(created.customFields.packageSize, "家財B", "新規作成: 追加項目が入る");
  assertEqual(created.skipped.length, 0, "新規作成: 据え置きは発生しない");

  // ZAICO側が空の項目は、どの方針でも既存値を消さない。
  const empties = mergeZaicoUpdate({
    zaico: { name: "", note: null, extendedFields: { width: "  " }, customFields: {} },
    bello: { name: "既存の名前", note: "既存の備考", extendedFields: { width: "72" }, customFields: {} },
    snapshotJson: JSON.stringify({ name: "既存の名前", note: "既存の備考", width: "72" }),
    isNewRecord: false,
  });
  assertEqual(Object.keys(empties.updates).length, 0, "結線: ZAICOが空の項目は書き込まない");
  assertEqual(Object.keys(empties.extendedFields).length, 0, "結線: ZAICOが空の拡張項目も書き込まない");
  assertEqual(empties.hasChanges, false, "結線: 空だけなら書き込む必要が無い");
}

function main() {
  testMergeIntegration();
  testCategoryRevertIncident();
  testPlannedSalePrice();
  testDimensions();
  testCustomFields();
  testOtherPolicies();
  testUniversalSafety();
  testSnapshot();
  testRuleTable();
  testValueEdges();
  testKeepKind();
  testIdempotency();
  testReportVolume();
  testSnapshotCorruption();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();

/* ══════════════════════════════════════════════════════════════════
 * 以下は main() より後ろに置いてあるが、関数宣言は巻き上げられるので
 * 呼び出しより前に定義済みになる。既存の並びを崩さず追記するため。
 * ══════════════════════════════════════════════════════════════════ */

/* 10. 値の型のふち(0 / false / "" / 数字文字列 / 日付)
 *
 * ZAICOはJSONで来るので、同じ「2」が 2 だったり "2.0" だったりする。
 * ここを取り違えると「変わっていないのに変わった」と判定して毎回
 * 書き込みが走る(数量が全件0になっていた件はこの種類の取り違え)。
 */
function testValueEdges() {
  assertEqual(isEmptyValue(0), false, "ふち: 0 は空ではない");
  assertEqual(isEmptyValue(false), false, "ふち: false は空ではない");
  assertEqual(isEmptyValue(""), true, "ふち: 空文字は空");
  assertEqual(isEmptyValue("   "), true, "ふち: 空白のみは空");
  assertEqual(isEmptyValue(null), true, "ふち: null は空");
  assertEqual(isEmptyValue(undefined), true, "ふち: undefined は空");

  assertEqual(valuesEqual(2, "2"), true, "ふち: 2 と 文字列2 は同じ");
  assertEqual(valuesEqual(2, "2.0"), true, "ふち: 2 と 文字列2.0 は同じ(ZAICOはこの形で返す)");
  assertEqual(valuesEqual(0, "0"), true, "ふち: 0 と 文字列0 は同じ");
  assertEqual(valuesEqual(2, "3"), false, "ふち: 数字文字列でも違えば違う");
  assertEqual(valuesEqual("A-1", " A-1 "), true, "ふち: 前後空白は無視する");
  assertEqual(valuesEqual("A-1", "A-2"), false, "ふち: 中身が違えば違う");

  assertEqual(valuesEqual(0, ""), false, "ふち: 0 と 空文字 は別物(0円が未入力に化けない)");
  assertEqual(valuesEqual(null, ""), true, "ふち: null と 空文字 はどちらも空として同じ");

  assertEqual(valuesEqual("2026-09-02", "2026-09-02"), true, "ふち: 同じ日付文字列は同じ");
  assertEqual(valuesEqual("2026-09-02", "2026-09-03"), false, "ふち: 違う日付は違う");

  const zeroQty = resolveFieldUpdate({
    field: "quantity",
    zaicoValue: 0,
    belloValue: 5,
    lastZaicoValue: 5,
    isNewRecord: false,
  });
  assertEqual(zeroQty.action, "APPLY", "ふち: ZAICOの0は空扱いせず書き込む");
  assertEqual(zeroQty.action === "APPLY" ? zeroQty.value : null, 0, "ふち: 書き込む値は0");
}

/* 11. 据え置きの理由を「種別」で分類する
 *
 * 以前は理由の日本語文を includes() で見ていた。文面を直した瞬間に
 * 分類が静かに外れ、「人の編集を守ったのに報告されない」という
 * 一番気づきにくい壊れ方をする。
 */
function testKeepKind() {
  const humanEdit = resolveFieldUpdate({
    field: "adminMemo",
    zaicoValue: "高",
    belloValue: "低",
    lastZaicoValue: "高",
    isNewRecord: false,
  });
  assertEqual(humanEdit.action, "KEEP", "種別: 人が変えた項目は据え置く(管理メモ)");
  assertEqual(humanEdit.action === "KEEP" ? humanEdit.kind : null, "HUMAN_EDIT", "種別: HUMAN_EDIT が付く");

  const noSnapshot = resolveFieldUpdate({
    field: "adminMemo",
    zaicoValue: "高",
    belloValue: "低",
    lastZaicoValue: undefined,
    isNewRecord: false,
  });
  assertEqual(noSnapshot.action === "KEEP" ? noSnapshot.kind : null, "NO_SNAPSHOT", "種別: 前回値が無ければ NO_SNAPSHOT");

  const zaicoEmpty = resolveFieldUpdate({
    field: "name",
    zaicoValue: "",
    belloValue: "既存",
    lastZaicoValue: "既存",
    isNewRecord: false,
  });
  assertEqual(zaicoEmpty.action === "KEEP" ? zaicoEmpty.kind : null, "ZAICO_EMPTY", "種別: ZAICOが空なら ZAICO_EMPTY");

  const same = resolveFieldUpdate({
    field: "name",
    zaicoValue: "同じ",
    belloValue: "同じ",
    lastZaicoValue: "同じ",
    isNewRecord: false,
  });
  assertEqual(same.action === "KEEP" ? same.kind : null, "SAME_VALUE", "種別: 同値なら SAME_VALUE");

  assertEqual(shouldReportKeep("HUMAN_EDIT"), true, "種別: 人の編集は報告する");
  assertEqual(shouldReportKeep("ALREADY_FILLED"), true, "種別: 補完しなかったことは報告する");
  assertEqual(shouldReportKeep("NO_SNAPSHOT"), true, "種別: 判断できなかったことは報告する");
  assertEqual(shouldReportKeep("ZAICO_EMPTY"), false, "種別: ZAICOが空は報告しない(毎回出て埋もれる)");
  assertEqual(shouldReportKeep("SAME_VALUE"), false, "種別: 同値は報告しない");
}

/* 12. 冪等性 — 同じ入力を2回流しても2回目は何も起きない */
function testIdempotency() {
  const zaico = {
    name: "チェア",
    quantity: 3,
    extendedFields: { width: "60" },
    customFields: { ステータス: "発送完了", 色: "黒" },
  };
  const belloBefore = { name: "旧チェア", quantity: 1, extendedFields: {}, customFields: {} };

  const first = mergeZaicoUpdate({ zaico, bello: belloBefore, snapshotJson: null, isNewRecord: false });
  assertEqual(first.hasChanges, true, "冪等: 1回目は書き込みが必要");

  const belloAfter = {
    name: (first.updates.name as string) ?? belloBefore.name,
    quantity: (first.updates.quantity as number) ?? belloBefore.quantity,
    extendedFields: { ...belloBefore.extendedFields, ...first.extendedFields },
    customFields: first.customFields,
  };

  const second = mergeZaicoUpdate({
    zaico,
    bello: belloAfter,
    snapshotJson: first.nextSnapshotJson,
    isNewRecord: false,
  });
  assertEqual(second.hasChanges, false, "冪等: 2回目は書き込む必要が無い");
  assertEqual(Object.keys(second.updates).length, 0, "冪等: 2回目に更新する列は無い");
  assertEqual(Object.keys(second.extendedFields).length, 0, "冪等: 2回目に更新する拡張項目は無い");
  assertEqual(second.skipped.length, 0, "冪等: 2回目に据え置きの報告は出ない");
  assertEqual(second.conflicts.length, 0, "冪等: 2回目に食い違いは出ない");
  assertEqual(second.nextSnapshotJson, first.nextSnapshotJson, "冪等: スナップショットも同じ");

  const third = mergeZaicoUpdate({
    zaico,
    bello: belloAfter,
    snapshotJson: second.nextSnapshotJson,
    isNewRecord: false,
  });
  assertEqual(third.hasChanges, false, "冪等: 3回目も書き込む必要が無い");

  const reordered = mergeZaicoUpdate({
    zaico,
    bello: { ...belloAfter, customFields: { 色: "黒", ステータス: "発送完了" } },
    snapshotJson: first.nextSnapshotJson,
    isNewRecord: false,
  });
  assertEqual(reordered.hasChanges, false, "冪等: 追加項目のキー順が違うだけでは書き込まない");
}

/* 13. 報告の量 — 毎回同じ警告が大量に出ると、見るべき1件が埋もれる */
function testReportVolume() {
  const many = mergeZaicoUpdate({
    zaico: {
      name: "ZAICO名",
      extendedFields: {},
      customFields: { ステータス: "発送完了", salePriority: "高", 色: "赤" },
    },
    bello: {
      name: "ZAICO名",
      extendedFields: {},
      customFields: { ステータス: "補修待ち", salePriority: "低", 色: "青" },
    },
    snapshotJson: JSON.stringify({
      name: "ZAICO名",
      __customFields: { ステータス: "発送完了", salePriority: "高", 色: "赤" },
    }),
    isNewRecord: false,
  });
  assertEqual(many.skipped.length, 3, "報告: 守った3項目ぶんだけ出る");
  assertEqual(
    many.skipped.some((s) => s.field === "name"),
    false,
    "報告: 同値だった項目は含まれない",
  );
  const fields = many.skipped.map((s) => s.field);
  assertEqual(new Set(fields).size, fields.length, "報告: 同じ項目を二重に報告しない");

  const emptyHeavy = mergeZaicoUpdate({
    zaico: { name: "", note: "", unit: "", barcode: "", extendedFields: { width: "", height: "" }, customFields: {} },
    bello: { name: "既存", note: "既存", unit: "個", barcode: "B1", extendedFields: { width: "70" }, customFields: {} },
    snapshotJson: JSON.stringify({ name: "既存" }),
    isNewRecord: false,
  });
  assertEqual(emptyHeavy.skipped.length, 0, "報告: ZAICOが空なだけの項目は報告しない");
  assertEqual(emptyHeavy.hasChanges, false, "報告: 空だけなら書き込みも不要");
}

/* 14. スナップショットの壊れ方に対する耐性 */
function testSnapshotCorruption() {
  const zaico = { name: "新", extendedFields: {}, customFields: {} };
  const bello = { name: "人が直した名前", extendedFields: {}, customFields: {} };

  const broken: [string, string][] = [
    ["壊れたJSON", "{壊れ"],
    ["途中で切れたJSON", '{"name":"新'],
    ["配列", "[1,2,3]"],
    ["JSONのnull", "null"],
    ["数値", "42"],
    ["文字列", '"ただの文字列"'],
    ["空文字", ""],
  ];
  for (const [label, raw] of broken) {
    const r = mergeZaicoUpdate({ zaico, bello, snapshotJson: raw, isNewRecord: false });
    assertEqual(typeof r.nextSnapshotJson, "string", `壊れたスナップショット(${label}): 例外にならず次回ぶんを作る`);
  }

  const kept = mergeZaicoUpdate({
    zaico: { extendedFields: {}, customFields: { salePriority: "高" } },
    bello: { extendedFields: {}, customFields: { salePriority: "低" } },
    snapshotJson: "{壊れ",
    isNewRecord: false,
  });
  assertEqual(kept.customFields.salePriority, "低", "壊れたスナップショット: 判断できないので人の値を残す");
}
