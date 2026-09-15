import type { CategoryMasterEntry } from "./masters";

/**
 * 家具店向け効率化指示書(2026-09-15)是正(task_302c7e3c24b575629d) §4-A/B:
 * Mercari公式カテゴリマスタ(category_master.csv、約7,625件)から
 * 「家具・インテリア」配下だけを実際のfullPathから木構造として組み立てる。
 *
 * このファイルは`node:fs`/`iconv-lite`を一切importしない純粋ロジックの
 * みを置く——`lib/listing/mercari/csv/masters.ts`はマスタCSVを読む
 * server専用コード(fsを使う)だが、木構造の組み立てとナビゲーションは
 * "use client"コンポーネント(MercariFurnitureCategoryPicker.tsx)からも
 * 素の関数として呼びたいため、fs依存をここに一切持ち込まない
 * (持ち込むとNext.jsのクライアントバンドルにfsが混入し、ビルドが壊れる)。
 *
 * 設計の要点(§4-B):
 * - マスタの各行は「そのfullPath全体に対応する末端(選択可能)カテゴリ」
 *   1件を表す。中間の階層名(例:「家具・インテリア > ライト・照明」)は
 *   多くの場合それ自体の行が存在しない——公式カテゴリIDが無い仮想の
 *   経路にすぎない。まれに中間階層がそのまま末端でもある行が存在する
 *   (例:「家具・インテリア > ケース・ボックス・コンテナ」)。
 * - よってノードは「実際にmaster行のfullPathとして存在する経路にだけ
 *   categoryIdを持つ」——それ以外のノードは`categoryId`を持たない
 *   (捏造しない、§4-B「経路から作った仮想親や『その他』グループ
 *   にはIDを捏造しない」)。子を持つノードにたまたま自分自身の行も
 *   存在する場合は、その階層でも確定できるよう`categoryId`を保持する
 *   (§4-B「子を持つ正式選択可能ノードはその階層でも確定可能」)。
 *
 * task_302c7e3c24b575629d(2026-09-15是正): 新規選択は家具・インテリア
 * 配下に限定する要件(このファイル冒頭のコメント参照は呼び出し側
 * MercariCategoryMappingSection.tsx/MercariFurnitureCategoryPicker.tsx)
 * のため、家具内だけを対象にした検索補助
 * (flattenFurnitureCategoryLeaves)を追加した——全カテゴリマスタへは
 * 一切触れず、既に取得済みのbuckets(家具・インテリア配下のみ)を
 * その場でフラット化するだけ(追加の通信は発生しない)。
 */

export const FURNITURE_ROOT_NAME = "家具・インテリア";

export interface FurnitureCategoryNode {
  /** このノードの表示名(親からの相対名、fullPathの1セグメント)。 */
  name: string;
  /** ルート("家具・インテリア")を含む完全な公式フルパス。パンくず/CSV確認用。 */
  fullPath: string;
  /** このノード自身がマスタに実在する末端カテゴリの時だけ設定される。中間の仮想ノードはundefined。 */
  categoryId?: string;
  children: FurnitureCategoryNode[];
}

export interface FurnitureCategoryBucket {
  /** UI/ナビゲーション状態保持用の安定キー。 */
  key: string;
  /** 入口ボタンの表示ラベル。「ベッド」のみ公式グループ名(ベッド・マットレス)と異なる。 */
  label: string;
  node: FurnitureCategoryNode;
}

/**
 * §4-A: 家具・インテリア配下から選んだ7つの公式グループを個別入口に
 * する。「ベッド」は公式の「ベッド・マットレス」を指す(公式カテゴリ名
 * 自体は変更しない——表示ラベルだけ短縮する)。残りの家具・インテリア
 * 配下グループはすべて「その他」に集約する(家具以外の全ジャンルは
 * ここに一切含めない)。
 */
const NAMED_FURNITURE_BUCKETS: { key: string; label: string; officialGroup: string }[] = [
  { key: "lighting", label: "ライト・照明", officialGroup: "ライト・照明" },
  { key: "table", label: "机・テーブル", officialGroup: "机・テーブル" },
  { key: "chair", label: "椅子・チェア", officialGroup: "椅子・チェア" },
  { key: "sofa", label: "ソファ・ソファベッド", officialGroup: "ソファ・ソファベッド" },
  { key: "shelf", label: "棚・ラック・シェルフ", officialGroup: "棚・ラック・シェルフ" },
  { key: "bed", label: "ベッド", officialGroup: "ベッド・マットレス" },
  { key: "office", label: "事務・店舗用品", officialGroup: "事務・店舗用品" },
];

interface MutableNode {
  name: string;
  fullPath: string;
  categoryId?: string;
  children: Map<string, MutableNode>;
}

function finalize(node: MutableNode): FurnitureCategoryNode {
  return {
    name: node.name,
    fullPath: node.fullPath,
    categoryId: node.categoryId,
    children: [...node.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name, "ja"))
      .map(finalize),
  };
}

/** 「家具・インテリア」配下だけの生の木を組み立てる(ルート自身はcategoryId無しの仮想ノード)。 */
function buildFurnitureRoot(categories: CategoryMasterEntry[]): MutableNode {
  const root: MutableNode = { name: FURNITURE_ROOT_NAME, fullPath: FURNITURE_ROOT_NAME, children: new Map() };
  const prefix = `${FURNITURE_ROOT_NAME} > `;
  for (const row of categories) {
    if (!row.fullPath.startsWith(prefix)) continue;
    const segments = row.fullPath.split(" > ");
    let cursor = root;
    let pathSoFar = FURNITURE_ROOT_NAME;
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      pathSoFar = `${pathSoFar} > ${seg}`;
      let next = cursor.children.get(seg);
      if (!next) {
        next = { name: seg, fullPath: pathSoFar, children: new Map() };
        cursor.children.set(seg, next);
      }
      cursor = next;
    }
    // ここに来た時点でcursorはrow.fullPathちょうどのノード——実在の
    // 末端カテゴリなのでIDを持たせる(中間で終わる仮想ノードには
    // 決して代入しない)。
    cursor.categoryId = row.categoryId;
  }
  return root;
}

/**
 * §4-A/B本体。category_master.csv全件(fs読み込み済みの配列)から
 * 8入口(7分類+その他)を組み立てる。マスタが読めない環境では空配列を
 * 返す(捏造した候補を出さない——呼び出し側はマスタ未検出として扱う)。
 */
export function buildFurnitureCategoryBuckets(categories: CategoryMasterEntry[]): FurnitureCategoryBucket[] {
  if (categories.length === 0) return [];
  const root = finalize(buildFurnitureRoot(categories));
  const byOfficialName = new Map(root.children.map((c) => [c.name, c]));
  const namedOfficialNames = new Set(NAMED_FURNITURE_BUCKETS.map((b) => b.officialGroup));

  const buckets: FurnitureCategoryBucket[] = [];
  for (const b of NAMED_FURNITURE_BUCKETS) {
    const node = byOfficialName.get(b.officialGroup);
    // 実マスタに該当グループが無い(想定外)場合は入口自体を出さない
    // ——存在しない分類への遷移を捏造しない。
    if (node) buckets.push({ key: b.key, label: b.label, node });
  }

  const others = root.children
    .filter((c) => !namedOfficialNames.has(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  if (others.length > 0) {
    buckets.push({
      key: "other",
      label: "その他",
      // 「その他」自体は公式カテゴリではない閲覧用のまとめグループ
      // ——fullPathは代表としてルート名のみとし、categoryIdは持たせない
      // (§4-B「その他グループにはIDを捏造しない」)。実際に選べる
      // のは子(othersの各要素、実在の公式グループ)から先だけ。
      node: { name: "その他", fullPath: FURNITURE_ROOT_NAME, children: others },
    });
  }
  return buckets;
}

/** node以下を`fullPath`まで下って一致する経路(node自身を含む)を返す。無ければnull。 */
function findPathInNode(node: FurnitureCategoryNode, fullPath: string): FurnitureCategoryNode[] | null {
  if (node.fullPath === fullPath) return [node];
  if (!fullPath.startsWith(`${node.fullPath} > `)) return null;
  for (const child of node.children) {
    const sub = findPathInNode(child, fullPath);
    if (sub) return [node, ...sub];
  }
  return null;
}

/**
 * §4-C: 保存済みカテゴリ(公式フルパス文字列、`mercariCategoryName`に
 * そのまま保存されている値)から、初期表示で復元すべき「どの入口の
 * どの経路か」を求める。見つからない場合はnull(家具・インテリア以外の
 * 旧カテゴリ、またはマスタ更新で経路が変わった場合)——呼び出し側は
 * 入口一覧をそのまま表示し、保存済みの値自体は(このファイルの外で)
 * 消さずに表示し続ける(task_302c7e3c24b575629d是正: 旧範囲外
 * カテゴリの現在値保持の根拠)。
 */
export function locateFurnitureCategoryPath(
  buckets: FurnitureCategoryBucket[],
  savedFullPath: string,
): { bucketKey: string; path: FurnitureCategoryNode[] } | null {
  for (const bucket of buckets) {
    if (bucket.key === "other") {
      // 「その他」ラッパー自身のfullPathは代表値(ルート名)にすぎない
      // ため、ラッパーは経路に含めず、実在する子から探す。
      for (const child of bucket.node.children) {
        const sub = findPathInNode(child, savedFullPath);
        if (sub) return { bucketKey: bucket.key, path: sub };
      }
      continue;
    }
    const sub = findPathInNode(bucket.node, savedFullPath);
    if (sub) return { bucketKey: bucket.key, path: sub };
  }
  return null;
}

/** 家具カテゴリ検索(§4-D是正、task_302c7e3c24b575629d)で1件を表す最小限の形。 */
export interface FurnitureCategoryLeaf {
  /** 正式フルパス(パンくず表示・確定に必要)。 */
  fullPath: string;
  /** 末端の表示名(検索結果のハイライト表示用)。 */
  name: string;
  categoryId: string;
}

function collectLeaves(node: FurnitureCategoryNode, out: FurnitureCategoryLeaf[]): void {
  if (node.categoryId) {
    out.push({ fullPath: node.fullPath, name: node.name, categoryId: node.categoryId });
  }
  for (const child of node.children) collectLeaves(child, out);
}

/**
 * task_302c7e3c24b575629d(2026-09-15是正) §4「検索補助を残すなら家具内
 * のみ」: 既に取得済みのbuckets(家具・インテリア配下だけ、
 * getMercariFurnitureCategoryTreeActionで初回に1回だけ取得したもの)を
 * その場でフラット化するだけの純粋関数——追加の通信は一切発生しない。
 * 「その他」バケットのラッパーノード自身(categoryId無し)は含まれず、
 * その実在する子から自動的に辿られる(collectLeavesがcategoryId無しの
 * ノードをスキップしつつ子を再帰する挙動そのままで、「その他」ラッパー
 * 特有の分岐は不要)。
 */
export function flattenFurnitureCategoryLeaves(buckets: FurnitureCategoryBucket[]): FurnitureCategoryLeaf[] {
  const leaves: FurnitureCategoryLeaf[] = [];
  for (const bucket of buckets) {
    collectLeaves(bucket.node, leaves);
  }
  return leaves;
}
