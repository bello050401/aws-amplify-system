"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getMercariFurnitureCategoryTreeAction } from "@/app/actions/listing";
import { flattenFurnitureCategoryLeaves, locateFurnitureCategoryPath } from "@/lib/listing/mercari/csv/furnitureCategoryTree";
import type { FurnitureCategoryBucket, FurnitureCategoryNode } from "@/lib/listing/mercari/csv/masters";

/**
 * 家具店向け効率化指示書(2026-09-15) §4-A/B/C/G: Mercariカテゴリを
 * 「ライト・照明/机・テーブル/椅子・チェア/ソファ・ソファベッド/
 * 棚・ラック・シェルフ/ベッド/事務・店舗用品/その他」の8入口から
 * クリックだけで階層選択するナビゲータ。検索語を自分で考える必要を
 * なくす(指示書§1「少ない入口から階層選択」)。
 *
 * 通信は初回マウント時に木構造を1回だけ取得する
 * (getMercariFurnitureCategoryTreeAction、家具・インテリア配下の
 * 約350件分のみ・全カテゴリマスタ7,625件は送らない)。以降の枝クリック・
 * 下の家具内検索は、このコンポーネント内のReact stateだけで完結し、
 * ネットワークへは一切アクセスしない(指示書§4-G「枝のクリック毎の
 * 全件マスタ再読込を避ける」)。
 *
 * 「選択」(クリックで下の階層へ移動するだけ)と「確定」(persistする、
 * 親から渡されるonConfirm)を明確に分離する(指示書§4-B)——ノードを
 * クリックしただけでは何も保存されない。「このカテゴリに決定」ボタンは
 * そのノード自身がマスタに実在する正式カテゴリ(categoryId有り)の時
 * だけ有効になる。仮想の中間階層(公式IDが無い経路、「その他」グループ
 * 自体を含む)では無効化し、案内文を出す(指示書§4-B「親に正式IDが
 * ない場合は下位選択を案内」)。子を持つノードでも自身にIDがあれば
 * 決定可能(指示書§4-B)。
 *
 * task_302c7e3c24b575629d(2026-09-15是正) §4「新規選択は家具・インテリア
 * 配下に限定、検索補助を残すなら家具内のみ・名称は検索と分かるもの」:
 * 下の「家具カテゴリを検索」欄は、上で取得済みのbuckets(家具配下だけ)
 * をその場でフラット化して絞り込むだけ(flattenFurnitureCategoryLeaves、
 * lib/listing/mercari/csv/furnitureCategoryTree.ts)——追加の通信は
 * 発生しない。旧来の全カテゴリマスタ検索(家具外を含む)は
 * MercariCategoryMappingSection.tsxから完全に削除済みで、この
 * コンポーネントが新規カテゴリ選択の唯一の経路になる。検索結果の
 * クリックはブレッドクラム上の移動と同じ扱い(即確定はしない)——
 * 「このカテゴリに決定」を押して初めて保存される(選ぶのは常に人、
 * という既存方針を検索経路でも崩さない)。
 */
export function MercariFurnitureCategoryPicker({
  inventoryId,
  currentFullPath,
  busy,
  onConfirm,
}: {
  inventoryId: string;
  /** 保存済みカテゴリのフルパス(channelListing.categoryMapping.mercariCategoryName)。初期表示の復元用。 */
  currentFullPath: string | undefined;
  busy: boolean;
  onConfirm: (categoryId: string, fullPath: string) => void;
}) {
  const [buckets, setBuckets] = useState<FurnitureCategoryBucket[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeBucketKey, setActiveBucketKey] = useState<string | null>(null);
  const [path, setPath] = useState<FurnitureCategoryNode[]>([]);
  const [leafQuery, setLeafQuery] = useState("");
  // 「どの商品について既に初期位置を復元したか」を覚えておく——
  // 商品を切り替えた(inventoryIdが変わった)時だけ復元し直す
  // (指示書§4-C「別商品へ移る際に選択が漏れない」)。ユーザーが
  // 自分でナビゲートした後にこのeffectが再発火して位置を巻き戻す
  // (誤操作扱いになる)のを防ぐガードでもある。
  const locatedForInventory = useRef<string | null>(null);

  // 木構造の取得は1回だけ(inventoryIdが変わっても再取得しない——
  // マスタ自体は商品に依存しない共有データのため、商品を切り替えても
  // 再フェッチ不要)。
  useEffect(() => {
    let cancelled = false;
    getMercariFurnitureCategoryTreeAction()
      .then((result) => {
        if (cancelled) return;
        setBuckets(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "カテゴリ一覧の取得に失敗しました。");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!buckets) return;
    if (locatedForInventory.current === inventoryId) return;
    locatedForInventory.current = inventoryId;
    if (currentFullPath) {
      const located = locateFurnitureCategoryPath(buckets, currentFullPath);
      if (located) {
        setActiveBucketKey(located.bucketKey);
        setPath(located.path);
        return;
      }
    }
    setActiveBucketKey(null);
    setPath([]);
  }, [buckets, inventoryId, currentFullPath]);

  // 家具内検索(task_302c7e3c24b575629d §4)。bucketsが変わらない限り
  // flattenFurnitureCategoryLeaves自体はbucketsだけに依存する純粋計算
  // なので、bucketsが同一参照の間はuseMemoで再計算を避ける。
  const allLeaves = useMemo(() => (buckets ? flattenFurnitureCategoryLeaves(buckets) : []), [buckets]);
  const leafMatches = useMemo(() => {
    const q = leafQuery.trim().toLowerCase();
    if (!q) return [];
    return allLeaves.filter((leaf) => leaf.name.toLowerCase().includes(q) || leaf.fullPath.toLowerCase().includes(q)).slice(0, 30);
  }, [allLeaves, leafQuery]);

  if (loadError) {
    return <p className="text-[12px] text-red-600">{loadError}</p>;
  }
  if (!buckets) {
    return <p className="text-[12px] text-gray-400">カテゴリ一覧を読み込み中…</p>;
  }
  if (buckets.length === 0) {
    return (
      <p className="text-[12px] text-red-600">
        カテゴリマスタが読み込めないため選択できません(data/mercari-masters/category_master.csv未検出)。
      </p>
    );
  }

  const current = path.length > 0 ? path[path.length - 1] : null;

  function openBucket(bucket: FurnitureCategoryBucket) {
    setLeafQuery("");
    setActiveBucketKey(bucket.key);
    setPath([bucket.node]);
  }

  function backToBuckets() {
    setActiveBucketKey(null);
    setPath([]);
  }

  function goUp() {
    if (path.length <= 1) {
      backToBuckets();
      return;
    }
    setPath(path.slice(0, -1));
  }

  function jumpTo(index: number) {
    setPath(path.slice(0, index + 1));
  }

  /** 家具内検索結果のクリック: 即確定はせず、該当の経路へ移動するだけ(下の「このカテゴリに決定」を押して初めて保存される)。 */
  function jumpToLeaf(fullPath: string) {
    if (!buckets) return;
    const located = locateFurnitureCategoryPath(buckets, fullPath);
    if (!located) return;
    setLeafQuery("");
    setActiveBucketKey(located.bucketKey);
    setPath(located.path);
  }

  return (
    // data-testid: task_302c7e3c24b575629d是正 §4「テストlocatorはexact/
    // nameやコンテナで限定」——他の検索欄(ブランド検索等)と地の文の
    // テキストマッチだけで見分けようとする脆いlocatorを避け、この
    // コンポーネント自身の範囲を明示的なコンテナとしてテストへ提供する。
    <div className="max-w-full" data-testid="mercari-furniture-category-picker">
      <div className="mb-2 flex gap-2">
        <input
          value={leafQuery}
          onChange={(e) => setLeafQuery(e.target.value)}
          placeholder="家具カテゴリ名で検索（家具・インテリア配下のみ）"
          disabled={busy}
          className="w-72 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-40"
        />
      </div>
      {leafQuery.trim() && (
        <ul className="mb-2 max-h-48 overflow-y-auto border border-gray-200 text-[12px]">
          {leafMatches.length === 0 && <li className="px-2 py-1 text-gray-400">該当なし</li>}
          {leafMatches.map((leaf) => (
            <li key={leaf.fullPath} className="border-b border-gray-100 px-2 py-1 last:border-b-0">
              <button type="button" onClick={() => jumpToLeaf(leaf.fullPath)} disabled={busy} className="text-left hover:underline disabled:opacity-40">
                {leaf.fullPath}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!activeBucketKey && (
        <div className="flex flex-wrap gap-2">
          {buckets.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => openBucket(b)}
              disabled={busy}
              className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {activeBucketKey && current && (
        <div>
          <div className="flex flex-wrap items-center gap-1 text-[12px] text-gray-600">
            <button type="button" onClick={backToBuckets} disabled={busy} className="text-blue-700 underline disabled:opacity-40">
              カテゴリー一覧
            </button>
            {path.map((node, idx) => (
              <span key={node.fullPath} className="flex items-center gap-1">
                <span className="text-gray-300">&gt;</span>
                {idx === path.length - 1 ? (
                  <span className="font-bold text-gray-900">{node.name}</span>
                ) : (
                  <button type="button" onClick={() => jumpTo(idx)} disabled={busy} className="text-blue-700 underline disabled:opacity-40">
                    {node.name}
                  </button>
                )}
              </span>
            ))}
            <button type="button" onClick={goUp} disabled={busy} className="ml-2 text-gray-400 underline disabled:opacity-40">
              戻る
            </button>
          </div>

          {current.children.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2">
              {current.children.map((child) => (
                <button
                  key={child.fullPath}
                  type="button"
                  onClick={() => setPath([...path, child])}
                  disabled={busy}
                  className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  {child.name}
                  {child.children.length > 0 ? " ›" : ""}
                </button>
              ))}
            </div>
          )}

          <div className="mt-2">
            {current.categoryId ? (
              <button
                type="button"
                onClick={() => onConfirm(current.categoryId as string, current.fullPath)}
                disabled={busy}
                className="border border-gray-700 bg-gray-900 px-3 py-1 text-[12px] font-bold text-white hover:bg-gray-700 disabled:opacity-40"
              >
                このカテゴリに決定
              </button>
            ) : (
              <p className="text-[11px] text-amber-700">
                この階層はまだ公式カテゴリではありません。上の一覧からさらに絞り込んでください。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
