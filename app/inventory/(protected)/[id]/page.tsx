import Link from "next/link";
import { notFound } from "next/navigation";
import { canEditInventory, canHardDeleteInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  getInventoryDetail,
  listCategories,
  listCustomFieldDefinitions,
  listLocations,
  listStatuses,
} from "@/lib/inventory/queries";
import { InventoryImageGallery } from "../../InventoryImageGallery";
import { InventoryHeader } from "../../InventoryHeader";
import { DeleteInventoryButton } from "./DeleteInventoryButton";
import { DetailSection } from "./DetailSection";
import { ExtendedFieldsSummary, type ExtraSectionField } from "./ExtendedFieldsSummary";
import { DetailInfoTable, type DetailInfoRow } from "./DetailInfoTable";
import {
  ALL_EXTENDED_FIELDS,
  INVENTORY_EXTENDED_SECTIONS,
  SALES_SECTION_ID,
  USED_GOODS_LEDGER_SECTION_ID,
} from "@/lib/inventory/extendedFields";
import { resolveTopImage, splitImagesByType } from "@/lib/inventory/imageTypes";

/** "60000" → "60,000円" — every price on this page (readable Japanese yen, not a bare number). */
function formatYen(value: number | null): string {
  return value === null ? "-" : `${value.toLocaleString("ja-JP")}円`;
}

/** ISO datetime → "2026/08/28 17:40" — exact zero-padded format; Intl's dateStyle/timeStyle shorthand drops the leading zero on month/day/hour, which doesn't match. */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** AWSDate "YYYY-MM-DD" → "YYYY/MM/DD"; plain string replace, never Date-parsed, so this can never shift a day from a timezone conversion. Empty/absent → "-" (spec A-4: 未入力も表示). */
function formatAwsDate(value: string | null): string {
  return value ? value.replace(/-/g, "/") : "-";
}

/**
 * D. 古物台帳・仕入情報の「品目・数量」— 単独フィールドとして存在しな
 * いため、既存の usedGoodsItemType（古物営業法台帳の「品目」に相当す
 * る既存フィールド）と purchaseQuantity（仕入数量）を組み合わせて自然
 * に構成する。spec原文は「商品名 + purchaseQuantity」を例示している
 * が、Inventory.name は在庫そのものの商品名であって古物台帳の「品目」
 * とは意味が異なる一方、usedGoodsItemType は既存スキーマ上すでに「品
 * 目」として定義済み（amplify/data/resource.tsのコメント参照）なの
 * で、そちらを再利用するのがA-3のSingle Source of Truthの趣旨に忠実。
 */
function formatItemTypeAndQuantity(itemType: string | null, quantity: number | null): string {
  if (!itemType && quantity === null) return "-";
  const typePart = itemType || "-";
  const qtyPart = quantity === null ? "-" : quantity.toLocaleString("ja-JP");
  return `${typePart}／数量: ${qtyPart}`;
}

/**
 * The history log (lib/inventory/history.ts) writes one row per changed
 * field, `fieldName` doing double duty as either an actual field label
 * ("商品名") or, for create/delete, the operation itself ("登録"/"削除")
 * — there's no separate stored "operation type" column. spec F wants a
 * ZAICO-style 日時/操作/変更内容/実行者 table, so these two helpers
 * derive that split from what's already stored rather than needing a
 * schema change.
 */
function historyOperationLabel(fieldName: string): string {
  if (fieldName === "登録" || fieldName === "削除") return fieldName;
  return "編集";
}

function historyChangeSummary(h: { fieldName: string; oldValue: string | null; newValue: string | null }): string {
  if (h.fieldName === "登録" || h.fieldName === "削除") return h.newValue ?? h.oldValue ?? "-";
  return `${h.fieldName} ${h.oldValue ?? "-"} → ${h.newValue ?? "-"}`;
}

/**
 * 在庫詳細画面 = PC「左：商品画像／右：商品情報」の2列構成（2026-08-28
 * 付の最新統合指示書 §15/§32で、直前の「画像を含めた全体1列縦スクロー
 * ル」から明示的に変更・優先された仕様）。新規登録/編集画面で保存でき
 * る項目はすべてここで確認できることが要件 —この画面のデータ取得は
 * 編集画面と同じ full InventoryDetail (拡張フィールド全項目・両方の
 * 画像タイプ・isPrimary・CustomFields)。
 *
 * 左カラム=商品画像1列、右カラム=基本情報→販売情報→サイズ情報→コン
 * ディション→古物台帳・仕入情報→管理情報→追加項目の縦積み1列。
 * 「画像＋情報＋右補助情報」の3列だったのが元の問題だったので、旧・
 * 独立した保管場所/メタ情報カラムは作らず、管理情報として右カラムの
 * 情報スタックに統合済み（前回のリライトから維持）。更新履歴だけは
 * 左右カラムの外、ページ下部に全幅で配置しページ全体のスクロールで
 * 読む。画像カラムの幅(380px)・画像サイズは、今回の2列化より前の
 * 3カラム版(f3bb5ea)のInventoryImageGallery呼び出しと同じ値へ揃えて
 * ある — 1列化の際に画像領域そのものを縮小した事実はなかったが
 * (InventoryImageGallery自体は今回まで一度も変更していない)、
 * グリッド列幅を明示的に380pxへ戻すことで指示書の「以前の画像領域を
 * 基準に戻す」を数値としても満たす。
 */
export default async function InventoryDetailPage({ params }: { params: { id: string } }) {
  const role = await getInventoryRole();
  if (!role) return null;

  const item = await getInventoryDetail(params.id);
  if (!item) notFound();

  // Same reasoning as the edit page: a deactivated category/location must
  // still resolve to its name here rather than falling back to "-", since
  // this record still legitimately references it.
  const [categories, locations, statuses, fieldDefs] = await Promise.all([
    listCategories(item.categoryId),
    listLocations(item.locationId),
    listStatuses(),
    listCustomFieldDefinitions(),
  ]);

  const category = item.categoryId ? categories.find((c) => c.id === item.categoryId) : undefined;
  const location = item.locationId ? locations.find((l) => l.id === item.locationId) : undefined;
  const status = item.statusId ? statuses.find((s) => s.id === item.statusId) : undefined;
  const canEdit = canEditInventory(role);
  const canDelete = canHardDeleteInventory(role);

  // 追加項目 (CustomFieldDefinition) — 常に全項目表示、未入力は"-"
  // (spec A-4)。socketType/legHeight/seatDimensions/packageSize/
  // usedGoodsFeature/salePriority 等、管理者が/inventory/settingsで自
  // 由に増減できる汎用フィールドなので、サイズ情報等の固定セクションへ
  // 個別に振り分けず、ここに一括表示する — 既存の区分(構造化された
  // extendedFields vs. 管理者定義のcustomFields)をそのまま維持する判
  // 断。spec C-3の「脚高/座面寸法/梱包サイズ」例示はここに含まれる。
  const fieldLabelByKey = new Map(fieldDefs.map((f) => [f.fieldKey, f.label]));
  const customFieldValues = (item.customFields ?? {}) as Record<string, unknown>;
  const customFieldRows: DetailInfoRow[] = fieldDefs.map((def) => ({
    label: def.label,
    value: customFieldValues[def.fieldKey] === undefined || customFieldValues[def.fieldKey] === null || customFieldValues[def.fieldKey] === ""
      ? "-"
      : String(customFieldValues[def.fieldKey]),
  }));
  // A CustomFieldDefinitionが非アクティブ化された後でも、既にこの在庫
  // へ値が入っている場合はfieldLabelByKeyに無いキーとして残る —
  // listCustomFieldDefinitionsはisActiveのみ返すため、そのキーを
  // フィールド定義名ではなくキー名で表示することでデータの消失を防ぐ
  // (A-2の「編集画面にある項目が詳細で見えない状態をなくす」の裏返し
  // として、"以前は存在した値"も隠さない)。
  for (const [key, value] of Object.entries(customFieldValues)) {
    if (fieldLabelByKey.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    customFieldRows.push({ label: key, value: String(value) });
  }

  // 販売情報 / サイズ情報 / コンディション — レジストリの並び順どおり
  // (A-3)。usedGoodsLedgerとadminMemoは、それぞれD/Eの固定要件により
  // 個別に手組みするため、ここでは除外する。
  const generalExtendedSections = INVENTORY_EXTENDED_SECTIONS.filter(
    (s) => s.id !== USED_GOODS_LEDGER_SECTION_ID && s.id !== "adminMemo",
  );
  const extendedRecord = Object.fromEntries(ALL_EXTENDED_FIELDS.map((f) => [f.key, item[f.key]]));
  // purchasePrice/salePrice are pre-existing core Inventory fields, not
  // part of the extendedFields registry — injected into their
  // spec-mandated section (販売情報's「販売価格」) via the same
  // section-id key the New/Edit forms use for the identical placement.
  const extendedExtra: Partial<Record<string, ExtraSectionField[]>> = {
    [SALES_SECTION_ID]: [{ label: "販売価格（成約）", rawValue: item.salePrice, display: formatYen(item.salePrice) }],
  };

  // D. 古物台帳・仕入情報 — この9項目の順序は仕様上固定 (「必ずこの順
  // 序を維持してください」)。extendedFields.tsのレジストリ順とは独立
  // に、ここで明示的に順序を組む。送料(shippingCost)は指定9項目には
  // 含まれていないが、編集画面には存在する既存フィールドなので
  // (A-2)、9項目の後ろに追加で表示する。
  const usedGoodsLedgerRows: DetailInfoRow[] = [
    { label: "取引の年月日", value: formatAwsDate(item.transactionDate) },
    { label: "購入価格", value: formatYen(item.purchasePrice) },
    { label: "品目・数量", value: formatItemTypeAndQuantity(item.usedGoodsItemType, item.purchaseQuantity) },
    { label: "取引区分", value: item.transactionType || "-" },
    { label: "真偽確認のためにとった措置の区分および方法", value: item.identityVerificationMethod || "-" },
    { label: "相手氏名", value: item.counterpartyName || "-" },
    { label: "職業", value: item.counterpartyOccupation || "-" },
    { label: "住所", value: item.counterpartyAddress || "-" },
    { label: "その日の仕入れ合計金額（他商品含む）", value: formatYen(item.dailyPurchaseTotal) },
    { label: "送料", value: formatYen(item.shippingCost) },
  ];

  // E. 管理情報 — 保管場所/作成日/更新日/作成者/更新者/管理メモを統合
  // (旧「独立した保管場所カード」+「管理メモ」セクションは廃止)。
  const managementRows: DetailInfoRow[] = [
    { label: "保管場所", value: location?.name ?? "-" },
    { label: "作成日", value: formatDateTime(item.createdAt) },
    { label: "更新日", value: formatDateTime(item.updatedAt) },
    { label: "作成者", value: item.createdBy ?? "-" },
    { label: "更新者", value: item.updatedBy ?? "-" },
    { label: "管理メモ", value: item.adminMemo || "-" },
  ];

  // 基本情報 (C-1)。「在庫ID」はZAICO由来商品ではZAICOの在庫IDを、
  // BELLO作成商品ではSKUをそのまま表示する導出値(displayId) —
  // 「SKU」自体は常にBELLO内部の管理番号として別行で確認できるように
  // する(在庫ID/SKU設計の再整理、lib/inventory/inventoryId.ts参照)。
  const basicRows: DetailInfoRow[] = [
    { label: "在庫ID", value: item.displayId },
    { label: "SKU", value: item.sku },
    { label: "物品名", value: item.name },
    { label: "カテゴリ", value: category?.name ?? "-" },
    { label: "状態", value: status?.label ?? "-" },
    { label: "数量", value: String(item.quantity) },
    { label: "単位", value: item.unit ?? "-" },
    { label: "QRコード・バーコード", value: item.barcode ?? "-" },
    { label: "備考", value: item.note || "-" },
  ];

  // B: NORMAL/DAMAGEを明確に分離。トップ画像を先頭へ寄せる既存ロジッ
  // クは維持。
  const { normal: normalImages, damage: damageImages } = splitImagesByType(item.images);
  const topImage = resolveTopImage(item.images);
  const orderedNormalImages = topImage ? [topImage, ...normalImages.filter((i) => i.storageKey !== topImage.storageKey)] : normalImages;

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">在庫詳細</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <Link href="/inventory" className="text-[12px] text-gray-500 hover:text-gray-900">
          ← 在庫一覧へ戻る
        </Link>

        <div className="mt-3 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              {status && <span className="border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700">{status.label}</span>}
              <span className="font-mono text-[13px] text-gray-500">{item.displayId}</span>
            </div>
            <h2 className="mt-1 text-lg font-bold text-gray-900">{item.name}</h2>
          </div>
          {/* G: 編集/複製/削除 — spec自身が「今回は無理にsticky化しなく
              ても構いません」としているため、単純に上部据え置き。 */}
          <div className="flex items-center gap-3">
            {canEdit && (
              <div className="flex gap-2">
                <Link href={`/inventory/${item.id}/edit`} className="border border-gray-300 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
                  編集
                </Link>
                <Link href={`/inventory/new?duplicateFrom=${item.id}`} className="border border-gray-300 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
                  複製
                </Link>
                {/* BELLO統合改修 master指示書 Phase D — EC出品機能への
                    唯一の導線。この詳細画面自体のレイアウト/密度は他に
                    一切変更しない(実際の出品UI・下書き編集は独立した
                    サブページ app/inventory/(protected)/[id]/listing/
                    にある)。 */}
                <Link href={`/inventory/${item.id}/listing`} className="border border-gray-300 px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
                  EC出品
                </Link>
              </div>
            )}
            {canDelete && <DeleteInventoryButton inventoryId={item.id} label={`${item.displayId} ${item.name}`} />}
          </div>
        </div>
        {role === "VIEWER" && <p className="mt-1 text-[11px] text-gray-400">VIEWER権限のため、編集・複製・削除は行えません。</p>}
        {role === "EDITOR" && <p className="mt-1 text-[11px] text-gray-400">削除はADMIN権限が必要です。</p>}

        {/* PC「左：商品画像／右：商品情報」の2列。lg未満（モバイル/狭幅）
            では1カラムへ積み上げる — DOM順(画像→情報)がそのままモバイ
            ルでの上から下の並びになるので、別途reorderは不要。画像列は
            2列化より前の3カラム版と同じ380px固定。 */}
        <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[380px_1fr]">
          {/* 左カラム: 商品画像。NORMAL/DAMAGEは明確に分離。 */}
          <div>
            <InventoryImageGallery images={orderedNormalImages} alt={item.name} title="商品画像" />
            <div className="mt-6">
              <InventoryImageGallery images={damageImages} alt={`${item.name} 傷・汚れ`} title="傷・汚れ写真" hideIfEmpty />
            </div>
          </div>

          {/* 右カラム: 商品情報を1列で縦積み。基本情報→販売情報→サイズ
              情報→コンディション→古物台帳・仕入情報→管理情報→追加項目。 */}
          <div>
            <DetailSection title="基本情報">
              <DetailInfoTable rows={basicRows} />
            </DetailSection>

            {/* 販売情報 / サイズ情報 / コンディション — レジストリ駆動、
                並び順・ラベル・型・単位の定義はextendedFields.tsの1箇所
                のみ (Single Source of Truth)。 */}
            <ExtendedFieldsSummary sections={generalExtendedSections} record={extendedRecord} extra={extendedExtra} />

            <DetailSection title="古物台帳・仕入情報">
              <DetailInfoTable rows={usedGoodsLedgerRows} />
            </DetailSection>

            <DetailSection title="管理情報">
              <DetailInfoTable rows={managementRows} />
            </DetailSection>

            <DetailSection title="追加項目">
              {customFieldRows.length > 0 ? (
                <DetailInfoTable rows={customFieldRows} />
              ) : (
                <p className="text-[12px] text-gray-400">追加項目は登録されていません。</p>
              )}
            </DetailSection>
          </div>
        </div>

        {/* 更新履歴 — 左右カラムの外、ページ下部に全幅で配置。独立した
            小さいスクロール領域は持たず、ページ全体の縦スクロールで確
            認する。日時/操作/変更内容/実行者の高密度テーブル。 */}
        <div className="mt-8 max-w-4xl border-t border-gray-100 pt-3">
          <p className="mb-1.5 text-[11px] font-bold text-gray-400">更新履歴</p>
          {item.history.length === 0 ? (
            <p className="text-[12px] text-gray-400">変更履歴はまだありません。</p>
          ) : (
            // BELLO統合業務OS指示書(2026-08-30) §70/§165: 390px幅で
            // 「変更内容」列(自由長テキスト、折り返さない)が原因で
            // page body自体が横スクロールしないよう、この表だけの
            // overflow-x-autoで横スクロールを閉じ込める(§78「body自体は
            // 横スクロールしない」の binding要件 — テーブル自体が幅を
            // 持つのは許容範囲、ページ全体が伸びるのは不可)。
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] border-collapse text-[12px]">
                <thead className="text-left text-gray-400">
                  <tr className="border-b border-gray-200">
                    <th className="py-1 px-2 font-normal">日時</th>
                    <th className="py-1 px-2 font-normal">操作</th>
                    <th className="py-1 px-2 font-normal">変更内容</th>
                    <th className="py-1 px-2 font-normal">実行者</th>
                  </tr>
                </thead>
                <tbody>
                  {item.history.map((h) => (
                    <tr key={h.id} className="border-b border-gray-100 text-gray-700">
                      <td className="whitespace-nowrap py-1 px-2 align-top">{formatDateTime(h.changedAt)}</td>
                      <td className="whitespace-nowrap py-1 px-2 align-top">{historyOperationLabel(h.fieldName)}</td>
                      <td className="py-1 px-2 align-top">{historyChangeSummary(h)}</td>
                      <td className="whitespace-nowrap py-1 px-2 align-top">{h.changedBy ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
