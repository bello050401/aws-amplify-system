import assert from "node:assert/strict";
import { buildProductPageUserPrompt } from "../lib/ai/productPage/prompt";
import { composeListingDescription } from "../lib/ai/productPage/descriptionSections";
import { verifiedBrandOverview } from "../lib/brands/verifiedOverview";

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

const overview = verifiedBrandOverview("Vitra", "【検証専用】Vitra All Plastic Chair");
assert.ok(overview);
assert.equal(overview.sourceUrl, "https://www.vitra.com/en-lp/about-vitra/facts");
assert.equal(overview.verifiedOn, "2026-10-02");
assert.match(overview.text, /1950年.*スイス/);
assert.equal(verifiedBrandOverview("Vitra", "別ブランドの椅子"), null);
assert.equal(verifiedBrandOverview("Vitra", "VitraXの椅子"), null);
assert.equal(verifiedBrandOverview("Vitra", "ヴィトラの椅子", ["ヴィトラ"])?.text, overview.text);
assert.equal(verifiedBrandOverview("別ブランド", "Vitraの椅子"), null);

const description = composeListingDescription({
  introduction: "座面と脚の形が特徴のチェアです。",
  brandOverview: overview.text,
  productDetail: "幅42cm",
  shipping: "配送は確認中です。",
  condition: "背面に小傷があります。",
});
assert.equal(description.match(/◎ブランドについて/g)?.length, 1);
assert.ok(description.indexOf("◎商品のご紹介") < description.indexOf("◎ブランドについて"));
assert.ok(description.indexOf("◎ブランドについて") < description.indexOf("◎商品詳細"));
assert.doesNotMatch(description, /https?:\/\//);
const withoutBrand = composeListingDescription({
  introduction: "座面と脚の形が特徴のチェアです。",
  brandOverview: null,
  productDetail: "幅42cm",
  shipping: "配送は確認中です。",
  condition: "背面に小傷があります。",
});
assert.doesNotMatch(withoutBrand, /◎ブランドについて|1950年/);

process.stdout.write("Brand reference and verified overview checks passed.\n");
