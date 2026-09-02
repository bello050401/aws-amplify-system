/**
 * BELLO改善指示をプロンプトへ入れる形へ組み立てる、純粋関数。
 *
 * lib/ai/productPage/guidance.ts(DBアクセス、server-only)から切り出して
 * あるのは、**文言そのものを回帰テストで固定するため**。
 * guidance.ts は Amplify のデータクライアントを読み込むので、
 * Next.js の外からは import できない。
 *
 * ここで一番大事なのは「これは事実ではない」と本文で明示すること。
 * 事実のブロックと混ざると、モデルが指示文そのものを商品の事実として
 * 書き写しうる(実際、外部調査の文章で同種のことが起きている)。
 */

export interface GuidanceRuleLike {
  instruction: string;
  enabled: boolean;
}

export function buildGuidanceBlock(rules: GuidanceRuleLike[]): string | null {
  const enabled = rules.filter((r) => r.enabled && r.instruction.trim());
  if (enabled.length === 0) return null;
  return [
    "BELLO_EDITORIAL_GUIDANCE(BELLO担当者が指定した書き方の指示。**事実ではない**。",
    "ここに書かれていることを商品の事実として本文へ写さないこと。",
    "確定事実と矛盾する指示があれば、確定事実を優先すること):",
    ...enabled.map((r, i) => `${i + 1}. ${r.instruction.trim()}`),
  ].join("\n");
}
