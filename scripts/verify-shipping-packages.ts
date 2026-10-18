import assert from "node:assert/strict";
import { buildPackageQuote, normalizeShippingPackages, type PackageRate } from "../lib/shipping/packages";
import { KAZAI_PROVIDER_NAME, KAZAI_SERVICE_NAME } from "../lib/shipping/serviceName";

const packages = [{ id: "main", name: "本体", rank: null }, { id: "legs", name: "脚", rank: "A" as const }];
const rate = (rank: PackageRate["rank"], destinationPrefecture: string, price: number | null, extra: Partial<PackageRate> = {}): PackageRate => ({
  provider: KAZAI_PROVIDER_NAME, service: KAZAI_SERVICE_NAME, originPrefecture: "埼玉県", destinationPrefecture,
  destinationArea: null, rank, price, taxIncluded: true, currency: "JPY", surcharge: null,
  effectiveFrom: "2026-01-01", effectiveTo: null, verifiedAt: "2026-01-01T00:00:00Z", status: "VERIFIED", version: 1, ...extra,
});
const rates = [
  rate("C", "東京都", 8000), rate("C", "愛知県", 9000), rate("C", "大阪府", 10000),
  rate("A", "東京都", 3000, { surcharge: 500 }), rate("A", "愛知県", 4000), rate("A", "大阪府", 5000),
];
const base = { packages, estimatedRank: "C" as const, plannedPrice: 29800, rates, asOfDate: "2026-10-18" };
const tokyo = JSON.stringify(["東京都", null]);

const tests: [string, () => void][] = [
  ["古い下書きは配送判定に合わせる1口として読める", () => assert.deepEqual(normalizeShippingPackages(undefined), [{ id: "main", name: "", rank: null }])],
  ["複数口・手動サイズはJSONを往復しても残る", () => assert.deepEqual(normalizeShippingPackages(JSON.parse(JSON.stringify(packages))), packages)],
  ["各口の中央値・送料合計・商品との合計", () => {
    const quote = buildPackageQuote(base);
    assert.deepEqual(quote.packages.map(p => p.fee), [9000, 4000]);
    assert.equal(quote.shippingTotal, 13000); assert.equal(quote.referenceTotal, 42800);
  }],
  ["同じ配送先で各口の加算料金を含めて合計", () => {
    const quote = buildPackageQuote({ ...base, destinationKey: tokyo });
    assert.deepEqual(quote.packages.map(p => p.fee), [8000, 3500]); assert.equal(quote.referenceTotal, 41300);
  }],
  ["自動判定と手動選択を別々に反映", () => {
    const quote = buildPackageQuote({ ...base, estimatedRank: "A", destinationKey: tokyo });
    assert.deepEqual(quote.packages.map(p => p.rank), ["A", "A"]); assert.equal(quote.shippingTotal, 7000);
  }],
  ["北海道の別地域を混ぜない", () => {
    const quote = buildPackageQuote({ ...base, rates: [...rates, rate("C", "北海道", 12000, { destinationArea: "函館" }), rate("C", "北海道", 16000, { destinationArea: "道東" }),
      rate("A", "北海道", 5000, { destinationArea: "函館" }), rate("A", "北海道", 7000, { destinationArea: "道東" })],
      destinationKey: JSON.stringify(["北海道", "道東"]) });
    assert.equal(quote.shippingTotal, 23000); assert.equal(quote.regions.filter(r => r.label.startsWith("北海道")).length, 2);
  }],
  ["一部の荷物に料金がない場合は合計を出さない", () => {
    const quote = buildPackageQuote({ ...base, rates: rates.filter(r => r.rank === "C"), destinationKey: tokyo });
    assert.equal(quote.packages[0].fee, 8000); assert.equal(quote.packages[1].fee, null); assert.equal(quote.shippingTotal, null); assert.equal(quote.referenceTotal, null);
  }],
  ["配送不可を0円扱いしない", () => {
    const quote = buildPackageQuote({ ...base, rates: [...rates, rate("A", "東京都", 0, { version: 2, status: "UNAVAILABLE" })], destinationKey: tokyo });
    assert.equal(quote.packages[1].reason, "配送不可・要確認"); assert.equal(quote.referenceTotal, null);
  }],
  ["サイズ未判定・規格外は個別確認", () => {
    const quote = buildPackageQuote({ ...base, estimatedRank: null, packages: [{ id: "a", name: "", rank: null }, { id: "b", name: "", rank: "OVERSIZE" }] });
    assert.deepEqual(quote.packages.map(p => p.fee), [null, null]); assert.equal(quote.shippingTotal, null);
  }],
  ["サイズと荷物数の入力を検証", () => {
    for (const value of [[], [...packages, packages[0]], [{ id: "a", name: "", rank: "XL" }], Array.from({ length: 21 }, (_, i) => ({ id: String(i), name: "", rank: null }))]) {
      assert.throws(() => normalizeShippingPackages(value));
    }
  }],
  ["価格未設定でも送料は計算する", () => {
    const quote = buildPackageQuote({ ...base, plannedPrice: null }); assert.equal(quote.shippingTotal, 13000); assert.equal(quote.referenceTotal, null);
  }],
  ["最新版を数値のversionで選択", () => {
    const quote = buildPackageQuote({ ...base, destinationKey: tokyo, rates: [...rates,
      rate("C", "東京都", 10000, { version: 9 }), rate("C", "東京都", 11000, { version: 10 })] });
    assert.equal(quote.packages[0].fee, 11000);
  }],
  ["未来・期限切れ・異なる配送サービスは混ぜない", () => {
    const quote = buildPackageQuote({ ...base, destinationKey: tokyo, rates: [...rates,
      rate("C", "東京都", 1, { effectiveFrom: "2027-01-01" }), rate("C", "東京都", 2, { effectiveTo: "2026-05-01", version: 3 }),
      rate("C", "東京都", 3, { service: "宅配便", version: 4 }), rate("C", "東京都", 4, { originPrefecture: "大阪府", version: 5 })] });
    assert.equal(quote.packages[0].fee, 8000);
  }],
  ["最新版が失効・未検証なら古い金額へ戻さない", () => {
    for (const status of ["STALE", "UNCONFIRMED"] as const) {
      assert.equal(buildPackageQuote({ ...base, destinationKey: tokyo, rates: [...rates, rate("C", "東京都", 1, { status, version: 2 })] }).packages[0].fee, null);
    }
  }],
  ["不正な金額を計算しない・少数地域を中央値にしない", () => {
    for (const extra of [{ price: -1 }, { price: Number.NaN }, { surcharge: -1 }]) {
      assert.equal(buildPackageQuote({ ...base, rates: [rate("C", "東京都", 8000, extra)], destinationKey: tokyo }).packages[0].fee, null);
    }
    assert.equal(buildPackageQuote({ ...base, rates: rates.filter(r => r.destinationPrefecture === "東京都") }).shippingTotal, null);
  }],
];
for (const [label, test] of tests) { test(); console.log("PASS", label); }
console.log(`${tests.length} shipping package checks passed`);
