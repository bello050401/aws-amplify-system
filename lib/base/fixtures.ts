import type { BaseItem } from "./types";

/**
 * Fixture catalog for local development and demoing the Phase 1 flow
 * before the real BASE client is wired up. Mirrors the test case in the
 * product spec (§23: search "Softshell" → 8 color variants) plus a
 * handful of other brands (vitra / Cassina / HAY / USM / Artek) so the
 * brand-keyword search path has something to find too.
 *
 * Image URLs point at BASE's real CDN host (so next/image config matches
 * production) but use placeholder hashes — they will 404 until swapped
 * for real BASE-hosted images once the live API is wired up.
 */
const img = (hash: string) => `https://baseec-img-mng.akamaized.net/images/item/origin/${hash}.jpg`;

const softshellColors: { hash: string; color: string; price: number; stock: number }[] = [
  { hash: "ss-red-01", color: "レッド", price: 168000, stock: 2 },
  { hash: "ss-black-01", color: "ブラック", price: 168000, stock: 1 },
  { hash: "ss-white-01", color: "ホワイト", price: 172000, stock: 0 },
  { hash: "ss-blue-01", color: "ブルー", price: 168000, stock: 3 },
  { hash: "ss-orange-01", color: "オレンジ", price: 168000, stock: 1 },
  { hash: "ss-grey-01", color: "グレー", price: 165000, stock: 4 },
  { hash: "ss-green-01", color: "グリーン", price: 168000, stock: 0 },
  { hash: "ss-yellow-01", color: "イエロー", price: 168000, stock: 2 },
];

export const FIXTURE_ITEMS: BaseItem[] = [
  ...softshellColors.map((c, i) => ({
    itemId: `softshell-${i + 1}`,
    title: `vitra Softshell Chair / ${c.color}`,
    price: c.price,
    description:
      "Ronan & Erwan Bouroullec design. シェル一体成型のプラスチックチェアに、スチール脚を組み合わせたモデル。",
    images: [{ url: img(c.hash) }, { url: img(`${c.hash}-b`) }],
    stock: c.stock,
    variations: [],
    itemUrl: `https://bellointeri.base.shop/items/${9000000 + i}`,
    isPublished: true,
    brand: "vitra",
  })),
  {
    itemId: "idtrim-red",
    title: "Vitra ヴィトラ ID Trim IDトリム ワークチェア デスクチェア ファブリック レッド",
    price: 36800,
    description: "背もたれのステッチデザインと調整機構が特徴のワークチェア。",
    images: [{ url: img("idtrim-red-01") }],
    stock: 1,
    variations: [],
    itemUrl: "https://bellointeri.base.shop/items/143144108",
    isPublished: true,
    brand: "vitra",
  },
  {
    itemId: "cab-chair-black",
    title: "Cassina CAB Chair 412 ブラックレザー",
    price: 128000,
    description: "Mario Bellini design. スチールフレームに一枚革を纏わせたレザーチェア。",
    images: [{ url: img("cab-black-01") }],
    stock: 1,
    variations: [],
    itemUrl: "https://bellointeri.base.shop/items/9100001",
    isPublished: true,
    brand: "Cassina",
  },
  {
    itemId: "hay-about-a-chair",
    title: "HAY About A Chair AAC22 オーク",
    price: 42000,
    description: "Hee Welling design. シェルチェアにオーク材の4本脚を組み合わせたモデル。",
    images: [{ url: img("hay-aac-01") }],
    stock: 2,
    variations: [],
    itemUrl: "https://bellointeri.base.shop/items/9100002",
    isPublished: true,
    brand: "HAY",
  },
  {
    itemId: "usm-haller-sideboard",
    title: "USM Haller サイドボード ゴールデンイエロー",
    price: 298000,
    description: "モジュラー式のメタルファニチャーシステム。",
    images: [{ url: img("usm-haller-01") }],
    stock: 1,
    variations: [],
    itemUrl: "https://bellointeri.base.shop/items/9100003",
    isPublished: true,
    brand: "USM",
  },
  {
    itemId: "artek-stool60",
    title: "Artek Stool 60 バーチ",
    price: 24000,
    description: "Alvar Aalto design. L-leg構法によるスツール。",
    images: [{ url: img("artek-60-01") }],
    stock: 5,
    variations: [],
    itemUrl: "https://bellointeri.base.shop/items/9100004",
    isPublished: true,
    brand: "Artek",
  },
];
