/**
 * Photo Profile の AWSJSON フィールドの取り扱い。
 *
 * `amplify/data/resource.ts`の`PhotoProfile.referenceImageKeys`等は
 * `a.json()` = GraphQLの **AWSJSON** 型で、**JSONエンコード済みの文字列**
 * しか受け付けない。生の配列/オブジェクトを渡すとAppSyncが
 *   "Variable 'referenceImageKeys' has an invalid value."
 * を返して書き込みが失敗する(stagingのAppSyncへ両方の形を実際に投げて
 * 確認済み — 生の配列は失敗、JSON文字列は成功)。
 *
 * これはこのリポジトリで二度目の同じ罠で、一度目は Feature.content
 * (commit 4bd0a1b "stringify Feature.content for AWSJSON writes")。
 * 三度目を防ぐため、変換をこの1ファイルに集約し、テストで固定する。
 */

/**
 * 読み出した`referenceImageKeys`を`string[]`へ正規化する。
 *
 * 既に配列の場合もそのまま受け入れる — この修正より前に別経路で生の配列
 * が書かれている可能性と、将来clientライブラリ側が自動でparseするように
 * なる可能性の両方に備える。壊れた値では例外を投げず空配列に倒し、
 * Profile一覧全体が落ちないようにする。
 */
export function parseReferenceImageKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** AWSJSONフィールドへ書き込むための直列化。呼び出し側が`JSON.stringify`を書き忘れないよう、名前で意図を示す。 */
export function serializeForAwsJson(value: unknown): string {
  return JSON.stringify(value);
}
