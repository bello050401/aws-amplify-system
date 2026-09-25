import assert from "node:assert/strict";
import { buildProductPageUserPrompt } from "../lib/ai/productPage/prompt";

const facts = {
  name: "テスト用チェア",
  dimensions: null,
  categoryName: "椅子",
  conditionDisclosure: null,
  publicNote: null,
};

const reference = "ブランドの一般情報。個体の製造国は不明。";
const known = buildProductPageUserPrompt({
  facts,
  similar: [],
  extra: { brand: "IDC OTSUKA", brandReference: reference },
});
assert.match(known, /ブランド\/メーカー: IDC OTSUKA/);
assert.match(known, /==== 選択ブランドの参考情報 ====/);
assert.match(known, /個体の型番・年代・素材・製造国・デザイナー等の証拠には使わない/);
assert.ok(known.indexOf("==== 事実情報ここまで ====") < known.indexOf(reference));

const unknown = buildProductPageUserPrompt({
  facts,
  similar: [],
  extra: { brand: "BELLO架空ブランドQA", brandReference: null },
});
assert.match(unknown, /ブランド\/メーカー: BELLO架空ブランドQA/);
assert.doesNotMatch(unknown, /選択ブランドの参考情報/);

process.stdout.write("Brand reference prompt checks passed (6/6).\n");
