import type { InventoryDetail } from "@/lib/inventory/queries";
import { buildListingFacts } from "@/lib/ai/productPage/listingFacts";
import { formatSeatDimensionsLine } from "@/lib/inventory/seatDimensions";
import { MAINTENANCE_LABEL } from "@/lib/inventory/maintenance";
import { formatSagawaSize } from "@/lib/shipping/sagawaSize";
import { SHIPPING_RANK_LABEL } from "@/lib/shipping/rank";
import { baseBrandHint } from "@/lib/base/archive/similar";

/**
 * EC出品画面の右側「在庫詳細・基本情報」(2026-09-04 EC出品改修指示書 §2)。
 *
 * ── 何を出しているのか ──────────────────────────────────────────
 *
 * §2-1「既存の在庫詳細画面・Product Context・ZAICO同期データ等を調査し、
 * すでに取得できている情報を再利用してください」。この画面は
 * `getInventoryDetail` が既に返している値だけを読む。**別DBへ重複保存
 * しない**(ページ自体のREAD ONLY境界と同じ)。
 *
 * 配送判定(家財おまかせ便ランク・佐川サイズ)とメンテナンス判定は、
 * 商品説明の生成で使うのと**同じ関数**(buildListingFacts)を通す ——
 * §8「既存の送料計算機能と商品説明文で判定結果が食い違う状態は絶対に
 * 避けてください」。画面と本文で別々に計算すると必ずずれる。
 *
 * ── モバイルでは出さない(§3) ────────────────────────────────────
 *
 * 表示/非表示は呼び出し側(page.tsx)が `hidden xl:block` で決める。
 * このコンポーネント自体は幅の判断をしない。
 */
export function InventoryFactsPanel({
  item,
  categoryName,
  statusName,
}: {
  item: InventoryDetail;
  categoryName: string | null;
  statusName: string | null;
}) {
  const customFields = (item.customFields ?? {}) as Record<string, unknown>;
  const cf = (key: string): string | null => {
    const v = customFields[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  const facts = buildListingFacts({
    name: item.name,
    categoryName,
    brand: baseBrandHint(item.name),
    width: item.width ?? null,
    depth: item.depth ?? null,
    height: item.height ?? null,
    overallLength: item.overallLength ?? null,
    seatDimensionsField: cf("seatDimensions"),
    material: cf("material"),
    conditionRating: item.conditionRating ?? null,
    damageNotes: item.damageNotes ?? null,
    note: item.note ?? null,
    listingNotes: item.listingNotes ?? null,
    adminMemo: item.adminMemo ?? null,
  });

  const maintenanceLabels = (
    [
      facts.maintenance.rinser ? "RINSER" : null,
      facts.maintenance.polish ? "POLISH" : null,
      facts.maintenance.coating ? "COATING" : null,
      facts.maintenance.cleaning ? "CLEANING" : null,
    ].filter(Boolean) as (keyof typeof MAINTENANCE_LABEL)[]
  ).map((k) => MAINTENANCE_LABEL[k]);

  const seatLine = formatSeatDimensionsLine(facts.seat);
  const sagawa = formatSagawaSize(facts.sagawa);

  return (
    <aside className="w-full text-[12px] text-gray-700" aria-label="在庫詳細・基本情報">
      <div className="border border-gray-200">
        <p className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-[12px] font-bold text-gray-700">
          在庫詳細・基本情報
        </p>
        <div className="divide-y divide-gray-100">
          <Group title="商品">
            <Row label="商品名" value={item.name} />
            <Row label="在庫ID" value={item.sku} />
            <Row label="メーカー / ブランド" value={facts.brand} />
            <Row label="カテゴリ" value={categoryName} />
            <Row label="在庫ステータス" value={statusName} />
            <Row label="数量" value={item.quantity != null ? `${item.quantity}${item.unit ?? ""}` : null} />
          </Group>

          <Group title="サイズ">
            <Row label="幅" value={facts.width} />
            <Row label="奥行" value={facts.depth} />
            <Row label="高さ" value={facts.height} />
            <Row label="全長" value={facts.overallLength} />
            {/* §6-1 座面寸法。読み取れた軸だけを出す。無い軸は書かない。 */}
            <Row label="座面寸法" value={seatLine ? seatLine.replace(/^座面寸法:/, "") : null} />
            <Row label="材質" value={facts.material} />
          </Group>

          {/* §2-1「配送判定に必要な情報」。商品説明と同じ判定結果を出す。 */}
          <Group title="配送判定">
            <Row
              label="3辺合計"
              value={facts.shippingSumCm != null ? `${facts.shippingSumCm}cm` : null}
            />
            <Row
              label="家財おまかせ便"
              value={facts.shippingRank ? SHIPPING_RANK_LABEL[facts.shippingRank] : null}
            />
            <Row label="佐川急便サイズ" value={sagawa} />
            <p className="px-3 pb-2 text-[11px] text-gray-400">{facts.sagawa.note}</p>
          </Group>

          <Group title="コンディション">
            {/* コンディション評価は社内の5段階スコア。担当者向け画面なので
                そのまま出すが、顧客向けの生成には渡らない
                (lib/ai/productIntro/facts.ts が落とす)。 */}
            <Row label="コンディション評価" value={item.conditionRating} />
            <Row label="傷汚れ箇所等メモ" value={item.damageNotes} multiline />
            <Row
              label="メンテナンス"
              value={maintenanceLabels.length > 0 ? maintenanceLabels.join(" / ") : null}
            />
            {facts.maintenance.evidence.length > 0 && (
              <div className="px-3 pb-2 text-[11px] text-gray-400">
                <p>判定の根拠:</p>
                <ul>
                  {facts.maintenance.evidence.map((e, i) => (
                    <li key={i}>
                      ・{e.field}「{e.matched}」
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Group>

          <Group title="価格">
            <Row label="仕入価格" value={yen(item.purchasePrice)} />
            <Row label="販売価格" value={yen(item.salePrice)} />
            <Row label="販売予定価格" value={yen(item.plannedSalePrice)} />
          </Group>

          <Group title="ZAICO">
            <Row label="連携元" value={item.sourceSystem} />
            <Row label="ZAICO在庫ID" value={item.sourceInventoryId} />
            <Row label="市場" value={item.market} />
            <Row label="商品ID（販売先）" value={item.externalProductId} />
          </Group>
        </div>
      </div>

      {/* §21 データ不足は隠さない。生成前でも「何が足りないか」が分かる。 */}
      {facts.warnings.length > 0 && (
        <div className="mt-3 border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-800">
          <p className="font-bold">商品説明の生成に足りない情報</p>
          <ul className="mt-1">
            {facts.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

function yen(v: number | null | undefined): string | null {
  return v == null ? null : `${v.toLocaleString("ja-JP")}円`;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <p className="px-3 pt-1 text-[11px] font-bold text-gray-400">{title}</p>
      <dl>{children}</dl>
    </div>
  );
}

/**
 * 1行。**値が無い項目は行ごと出さない。**
 *
 * 「—」で埋めると、登録されていないのか取得に失敗したのかが読めない。
 * 足りない項目は上の警告ブロックが名指しで出す。
 */
function Row({ label, value, multiline }: { label: string; value: string | null | undefined; multiline?: boolean }) {
  if (!value || !String(value).trim()) return null;
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-2 px-3 py-0.5">
      <dt className="text-gray-500">{label}</dt>
      <dd className={multiline ? "whitespace-pre-wrap break-words" : "break-words"}>{value}</dd>
    </div>
  );
}
