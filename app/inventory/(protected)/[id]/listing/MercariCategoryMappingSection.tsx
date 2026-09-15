"use client";

import { useEffect, useState } from "react";
import {
  getMercariCsvImageDownloadLinksAction,
  getMercariCsvImageZipPlanAction,
  saveChannelOverrideAction,
  searchMercariBrandsAction,
  searchMercariCategoriesAction,
  type MercariCsvImageDownloadLink,
} from "@/app/actions/listing";
import { assembleZipFromPlan, downloadZipBlob } from "@/lib/listing/mercari/csv/browserImageZip";
import { DEFAULT_MERCARI_SHIPPING_DAYS, DEFAULT_MERCARI_SHIPPING_PAYER } from "@/lib/listing/mercari/csv/assembleRow";
import type { ChannelListingRecord } from "@/lib/listing/types";
import type { BrandMasterEntry, CategoryMasterEntry } from "@/lib/listing/mercari/csv/masters";

/** 指示書§4「発送までの日数」の5値。ラベルは公式テンプレートの表記に合わせる。 */
const SHIPPING_DAYS_OPTIONS: { value: 1 | 2 | 3 | 4 | 5; label: string }[] = [
  { value: 1, label: "1〜2日で発送" },
  { value: 2, label: "2〜3日で発送" },
  { value: 3, label: "4〜7日で発送" },
  { value: 4, label: "90日以内に発送" },
  { value: 5, label: "8〜14日で発送" },
];

/**
 * Mercari Shops CSV出力機能(2026-09-14、P2)向けのカテゴリー/ブランド
 * 選択セクション。
 *
 * API出品機能の撤去(624307e)でMercari固有の実行導線(カテゴリー
 * マッピング入力含む)はいったんこのUIから削除されたが、CSV出力
 * (lib/listing/mercari/csv/buildExportRows.ts)は
 * `ChannelListing.categoryMapping.mercariCategoryId`が確定していないと
 * 対象商品を「カテゴリ未確定」でブロックする——実行(出品)はしないが、
 * 事前準備としてのカテゴリー選択だけをここで復元する(実際にMercariへ
 * 送信するボタンはどこにも無い)。
 *
 * 検索はローカルのマスタCSV(data/mercari-masters/、提供物そのまま)を
 * 検索するだけ(app/actions/listing.tsのsearchMercariCategoriesAction/
 * searchMercariBrandsAction参照、外部APIへは一切到達しない)。
 * 同名の末端カテゴリが複数IDに存在しうるため、検索結果には必ず
 * フルパスを添えて表示し、AIや文字列類似だけで確定しない——選ぶのは
 * 常に人。ブランドは指示書§4のとおり任意。
 *
 * 送料ID(mercariShippingFeeId、task_ca862bd2a1f6fbf60d、2026-09-15是正):
 * 配送料の負担(mercariShippingPayer)が「送料別」の場合、公式仕様上
 * validateMercariCsvRow(lib/listing/mercari/csv/validate.ts)がCSV生成時
 * に送料IDを必須としている。送料IDにはMercari提供のマスタが無く
 * (data/mercari-masters/には含まれない)、Mercari Shops管理画面の
 * 「送料設定」で出品者ごとに作成したIDを人が転記する以外に確定手段が
 * 無いため、検索UIではなく自由入力欄として復元する。BELLO側では送料
 * そのものを算出・変更しない(実際の送料額はMercari側の設定に従う)。
 */
export function MercariCategoryMappingSection({
  inventoryId,
  hasDraft,
  channelListing,
  onUpdated,
}: {
  inventoryId: string;
  /** saveChannelOverrideは下書きが無いと保存できない(service.ts参照)。 */
  hasDraft: boolean;
  channelListing: ChannelListingRecord | null;
  onUpdated: (updated: ChannelListingRecord) => void;
}) {
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryResults, setCategoryResults] = useState<CategoryMasterEntry[] | null>(null);
  const [brandQuery, setBrandQuery] = useState("");
  const [brandResults, setBrandResults] = useState<BrandMasterEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mapping = channelListing?.categoryMapping ?? null;

  // task_d2082e63dfcee9e1bf: 未設定(undefined)の間は表示上もCSV生成時と
  // 同じ既定値(4〜7日/送料込み、lib/listing/mercari/csv/assembleRow.ts
  // のDEFAULT_MERCARI_SHIPPING_*と共有)を選択済みとして見せる——「表示
  // だけの初期値でCSVでは未確定エラー」のような食い違いを避ける。ただし
  // 保存済みの実値がある場合は絶対にこれで上書きしない(下のuseEffectも
  // 同様)。この初期化・同期処理自体はDBへ一切書き込まない(保存は
  // saveShippingDays/saveShippingPayerを押した時だけ)。
  const [shippingDaysDraft, setShippingDaysDraft] = useState<string>(
    String(mapping?.mercariShippingDays ?? DEFAULT_MERCARI_SHIPPING_DAYS),
  );
  // 保存後(onUpdated経由でchannelListingプロパティが差し替わった時)に
  // 選択中の値を最新の永続値へ同期する——他の入力(検索欄)と違い、
  // ここは「保存済みの値そのもの」を表示する欄なので追随させる。
  useEffect(() => {
    setShippingDaysDraft(String(mapping?.mercariShippingDays ?? DEFAULT_MERCARI_SHIPPING_DAYS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping?.mercariShippingDays]);

  const [shippingPayerDraft, setShippingPayerDraft] = useState<string>(
    String(mapping?.mercariShippingPayer ?? DEFAULT_MERCARI_SHIPPING_PAYER),
  );
  // shippingDaysDraftと同じ理由で、保存済み値の変化に追随させる。
  useEffect(() => {
    setShippingPayerDraft(String(mapping?.mercariShippingPayer ?? DEFAULT_MERCARI_SHIPPING_PAYER));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping?.mercariShippingPayer]);

  const [shippingFeeIdDraft, setShippingFeeIdDraft] = useState<string>(mapping?.mercariShippingFeeId ?? "");
  // shippingDaysDraft/shippingPayerDraftと同じ理由で、保存済み値の変化に追随させる。
  useEffect(() => {
    setShippingFeeIdDraft(mapping?.mercariShippingFeeId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping?.mercariShippingFeeId]);

  const [imageLinksBusy, setImageLinksBusy] = useState(false);
  const [imageLinksError, setImageLinksError] = useState<string | null>(null);
  const [imageLinks, setImageLinks] = useState<MercariCsvImageDownloadLink[] | null>(null);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  // 2026-09-14 指示書レビュー修正: 以前はgetMercariCsvImageZipActionの
  // 戻り値のうちトップレベルの`reason`(常に同じ固定文言
  // 「一部商品の画像を取得できませんでした」)だけを表示しており、
  // 実際にどの画像が・なぜ(期限切れ/権限なし/削除済み等、HTTPステータス
  // ごとの理由はimageBundle.tsのfailures[].reasonにしか無い)失敗した
  // かが画面から一切分からなかった——手動運用でこの後どう対処すべきか
  // (再ログイン/管理者確認/別画像を選び直す)を利用者が判断できない。
  // 一覧側の一括ZIP(ListingsOverviewTable.tsx)と同じくfailures配列を
  // そのまま表示する。
  const [zipFailures, setZipFailures] = useState<{ inventoryId: string; displayId: string; reason: string }[] | null>(null);
  const [zipDone, setZipDone] = useState(false);

  async function handleSearchCategories() {
    setError(null);
    setCategoryResults(await searchMercariCategoriesAction(categoryQuery));
  }

  async function handleSearchBrands() {
    setError(null);
    setBrandResults(await searchMercariBrandsAction(brandQuery));
  }

  /**
   * 選んだ側の値だけを差し替え、もう片方(ブランド/カテゴリー)の既存値は
   * 保持する——カテゴリーを選び直したらブランドが消える、を防ぐ。
   * overrideTitle/overrideDescription/overridePriceも既存値をそのまま
   * 渡す(saveChannelOverrideはこのAction呼び出し単位で全フィールドを
   * 上書きするため、ここで渡し忘れると黙って消える)。
   */
  async function persist(nextMapping: NonNullable<ChannelListingRecord["categoryMapping"]>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await saveChannelOverrideAction(inventoryId, {
        categoryMapping: nextMapping,
        overrideTitle: channelListing?.overrideTitle ?? null,
        overrideDescription: channelListing?.overrideDescription ?? null,
        overridePrice: channelListing?.overridePrice ?? null,
      });
      onUpdated(updated);
      setMessage("保存しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  function selectCategory(entry: CategoryMasterEntry) {
    void persist({
      mercariCategoryId: entry.categoryId,
      mercariCategoryName: entry.fullPath,
      mercariBrandId: mapping?.mercariBrandId,
      mercariBrandName: mapping?.mercariBrandName,
      mercariShippingDays: mapping?.mercariShippingDays,
      mercariShippingPayer: mapping?.mercariShippingPayer,
      mercariShippingFeeId: mapping?.mercariShippingFeeId,
    });
    setCategoryResults(null);
  }

  function selectBrand(entry: BrandMasterEntry) {
    if (!mapping?.mercariCategoryId) {
      setError("先にカテゴリーを選択してください（ブランドだけを先に保存すると、カテゴリー未確定のままCSV出力がブロックされ続けます）。");
      return;
    }
    void persist({
      mercariCategoryId: mapping.mercariCategoryId,
      mercariCategoryName: mapping.mercariCategoryName,
      mercariBrandId: entry.brandId,
      mercariBrandName: entry.name,
      mercariShippingDays: mapping?.mercariShippingDays,
      mercariShippingPayer: mapping?.mercariShippingPayer,
      mercariShippingFeeId: mapping?.mercariShippingFeeId,
    });
    setBrandResults(null);
  }

  function clearBrand() {
    if (!mapping?.mercariCategoryId) return;
    void persist({
      mercariCategoryId: mapping.mercariCategoryId,
      mercariCategoryName: mapping.mercariCategoryName,
      mercariShippingDays: mapping.mercariShippingDays,
      mercariShippingPayer: mapping.mercariShippingPayer,
      mercariShippingFeeId: mapping.mercariShippingFeeId,
    });
  }

  /**
   * 発送までの日数の保存。task_d2082e63dfcee9e1bf: 未設定の間はCSV生成時に
   * 既定値(4〜7日、DEFAULT_MERCARI_SHIPPING_DAYS)が自動で適用されるため、
   * この保存ボタンは「既定値と異なる日数で運用したい商品だけ」明示的に
   * 選び直すためのもの——保存しなくてもCSV出力は既定値でブロックされずに
   * 進む。カテゴリーと違い公式マスタが無く選択肢は固定5値のみなので検索
   * UIは持たない。カテゴリー未確定のまま保存するとsaveChannelOverrideAction
   * 自体は通ってしまう(categoryMappingはmercariCategoryId必須の型のため、
   * 実際には先にカテゴリーが要る)。
   */
  function saveShippingDays() {
    if (!mapping?.mercariCategoryId) {
      setError("先にカテゴリーを選択してください。");
      return;
    }
    const parsed = Number(shippingDaysDraft);
    if (![1, 2, 3, 4, 5].includes(parsed)) {
      setError("発送までの日数を選択してください。");
      return;
    }
    void persist({
      mercariCategoryId: mapping.mercariCategoryId,
      mercariCategoryName: mapping.mercariCategoryName,
      mercariBrandId: mapping.mercariBrandId,
      mercariBrandName: mapping.mercariBrandName,
      mercariShippingDays: parsed as 1 | 2 | 3 | 4 | 5,
      mercariShippingPayer: mapping.mercariShippingPayer,
      mercariShippingFeeId: mapping.mercariShippingFeeId,
    });
  }

  /**
   * 配送料の負担の保存。task_d2082e63dfcee9e1bf: 未設定の間はCSV生成時に
   * 既定値(送料込み、DEFAULT_MERCARI_SHIPPING_PAYER)が自動で適用される
   * ため、この保存ボタンは「既定値と異なる負担で運用したい商品だけ」
   * 明示的に選び直すためのもの。
   *
   * 送料別(2)へ切り替える際に送料IDを一緒に消したり要求したりはしない
   * ——送料IDは下の専用欄・専用の保存ボタンで別途保存する(途中空欄で
   * 保存できる、指示書§4「途中空欄保存許可」)。送料込(1)へ戻しても
   * 保存済みの送料IDは消さない(再び送料別へ戻した時に入力し直させない
   * ため)——CSV出力時にshippingPayerが1ならassembleRow.tsが送料IDを
   * 出さないので、消さずに残しても実害は無い。
   */
  function saveShippingPayer() {
    if (!mapping?.mercariCategoryId) {
      setError("先にカテゴリーを選択してください。");
      return;
    }
    const parsed = Number(shippingPayerDraft);
    if (![1, 2].includes(parsed)) {
      setError("配送料の負担を選択してください。");
      return;
    }
    void persist({
      mercariCategoryId: mapping.mercariCategoryId,
      mercariCategoryName: mapping.mercariCategoryName,
      mercariBrandId: mapping.mercariBrandId,
      mercariBrandName: mapping.mercariBrandName,
      mercariShippingDays: mapping.mercariShippingDays,
      mercariShippingPayer: parsed as 1 | 2,
      mercariShippingFeeId: mapping.mercariShippingFeeId,
    });
  }

  /**
   * 送料IDの保存(task_ca862bd2a1f6fbf60d、2026-09-15追加)。
   *
   * 配送料の負担が「送料別」の時だけこの欄自体を表示するが、保存操作
   * そのものは空欄でも拒否しない(指示書§4「途中空欄保存許可」)——
   * カテゴリー/発送日数と違い、送料IDはMercari Shops管理画面側で先に
   * 「送料設定」を作成してからでないと値が存在しないため、先に空欄の
   * まま他の項目を確定させ、後からIDだけを追記する運用を妨げない。
   * 必須チェックはCSV生成時(validateMercariCsvRow)側の責務のまま。
   */
  function saveShippingFeeId() {
    if (!mapping?.mercariCategoryId) {
      setError("先にカテゴリーを選択してください。");
      return;
    }
    const trimmed = shippingFeeIdDraft.trim();
    void persist({
      mercariCategoryId: mapping.mercariCategoryId,
      mercariCategoryName: mapping.mercariCategoryName,
      mercariBrandId: mapping.mercariBrandId,
      mercariBrandName: mapping.mercariBrandName,
      mercariShippingDays: mapping.mercariShippingDays,
      mercariShippingPayer: mapping.mercariShippingPayer,
      mercariShippingFeeId: trimmed || undefined,
    });
  }

  /**
   * 画像受渡し(§4「次点」)。既存BASE画像URLとの確定紐付けは今回未実装
   * (根拠: getMercariCsvImageDownloadLinksAction参照)——自社S3の署名URL
   * (1時間有効)を人が手元へ落として、Mercari側へ手動アップロードする
   * ための一覧だけをここで見せる。
   */
  async function loadImageLinks() {
    setImageLinksBusy(true);
    setImageLinksError(null);
    try {
      const result = await getMercariCsvImageDownloadLinksAction(inventoryId);
      if (!result.ok) {
        setImageLinksError(result.reason);
        setImageLinks(null);
        return;
      }
      setImageLinks(result.links);
    } catch (err) {
      setImageLinksError(err instanceof Error ? err.message : "画像リンクの取得に失敗しました。");
    } finally {
      setImageLinksBusy(false);
    }
  }

  /**
   * 画像をまとめてZIPで保存する。ZIP内のファイル名はCSVの商品画像名列
   * (imageFilename()、lib/listing/mercari/csv/assembleRow.ts)と同じ
   * 値なので、展開した画像をそのままCSVの指定名として使える——手作業
   * でのリネームは不要。1枚でも取得に失敗した場合はZIP自体を作らず
   * エラーを表示する(一部だけ欠けたZIPを黙って成功扱いにしない)。
   *
   * task_f712cf24a9fe2308cd(2026-09-14是正): getMercariCsvImageZipPlanAction
   * (署名URLの一覧だけを返す小さい応答)→assembleZipFromPlan(ブラウザが
   * S3から直接取得してZIPを組み立てる)という2段構成に変更した——理由は
   * ListingsOverviewTable.tsxのrunImageZipDownloadと同じ
   * (lib/listing/mercari/csv/imageBundle.tsのコメント参照)。
   */
  async function handleDownloadZip() {
    setZipBusy(true);
    setZipError(null);
    setZipFailures(null);
    setZipDone(false);
    try {
      const plan = await getMercariCsvImageZipPlanAction([inventoryId]);
      if (!plan.ok || !plan.plan || !plan.filename) {
        setZipError(plan.reason ?? "画像のダウンロードに失敗しました。");
        setZipFailures(plan.failures && plan.failures.length > 0 ? plan.failures : null);
        return;
      }
      const assembled = await assembleZipFromPlan(plan.filename, plan.plan);
      if (!assembled.ok) {
        setZipError(assembled.reason ?? "画像のダウンロードに失敗しました。");
        setZipFailures(assembled.failures && assembled.failures.length > 0 ? assembled.failures : null);
        return;
      }
      downloadZipBlob(assembled.blob, assembled.filename);
      setZipDone(true);
    } catch (err) {
      setZipError(err instanceof Error ? err.message : "画像のダウンロードに失敗しました。");
    } finally {
      setZipBusy(false);
    }
  }

  if (!hasDraft) {
    return null;
  }

  return (
    <div className="mt-4 border border-gray-200 p-4">
      <p className="mb-1 text-[12px] font-bold text-gray-700">Mercariカテゴリー / ブランド（CSV出力用）</p>
      <p className="mb-2 text-[11px] text-gray-400">
        ここで選んだ内容はMercariへ自動送信されません——CSV出力(EC準備一覧の「CSVを作成」)で使う項目を、公式マスタから検索して確定するだけです。
      </p>

      <div className="mb-3">
        <p className="text-[12px] text-gray-600">
          現在のカテゴリー:{" "}
          {mapping?.mercariCategoryId ? (
            <span className="font-bold text-gray-900">
              {mapping.mercariCategoryName ?? mapping.mercariCategoryId}
              <span className="ml-1 font-mono text-[11px] text-gray-400">({mapping.mercariCategoryId})</span>
            </span>
          ) : (
            <span className="text-amber-700">未確定（CSV出力がブロックされます）</span>
          )}
        </p>
        <div className="mt-1 flex gap-2">
          <input
            value={categoryQuery}
            onChange={(e) => setCategoryQuery(e.target.value)}
            placeholder="カテゴリー名で検索"
            className="w-64 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleSearchCategories()}
            disabled={busy || !categoryQuery.trim()}
            className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            検索
          </button>
        </div>
        {categoryResults && (
          <ul className="mt-1 max-h-48 overflow-y-auto border border-gray-200 text-[12px]">
            {categoryResults.length === 0 && <li className="px-2 py-1 text-gray-400">該当なし</li>}
            {categoryResults.map((c) => (
              <li key={c.categoryId} className="border-b border-gray-100 px-2 py-1 last:border-b-0">
                <button type="button" onClick={() => selectCategory(c)} disabled={busy} className="text-left hover:underline disabled:opacity-40">
                  {/* 同名の末端カテゴリが複数IDに存在しうるため、フルパスを必ず一緒に見せる——名前だけで選ばせない。 */}
                  {c.fullPath} <span className="font-mono text-[11px] text-gray-400">({c.categoryId})</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[12px] text-gray-600">
          現在のブランド（任意）:{" "}
          {mapping?.mercariBrandId ? (
            <span className="font-bold text-gray-900">
              {mapping.mercariBrandName ?? mapping.mercariBrandId}
              <span className="ml-1 font-mono text-[11px] text-gray-400">({mapping.mercariBrandId})</span>
            </span>
          ) : (
            <span className="text-gray-400">未設定</span>
          )}
          {mapping?.mercariBrandId && (
            <button type="button" onClick={() => void clearBrand()} disabled={busy} className="ml-2 text-[11px] text-gray-400 underline disabled:opacity-40">
              クリア
            </button>
          )}
        </p>
        <div className="mt-1 flex gap-2">
          <input
            value={brandQuery}
            onChange={(e) => setBrandQuery(e.target.value)}
            placeholder="ブランド名（和名/カナ/英語）で検索"
            className="w-64 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleSearchBrands()}
            disabled={busy || !brandQuery.trim()}
            className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            検索
          </button>
        </div>
        {brandResults && (
          <ul className="mt-1 max-h-48 overflow-y-auto border border-gray-200 text-[12px]">
            {brandResults.length === 0 && <li className="px-2 py-1 text-gray-400">該当なし</li>}
            {brandResults.map((b) => (
              <li key={b.brandId} className="border-b border-gray-100 px-2 py-1 last:border-b-0">
                <button type="button" onClick={() => selectBrand(b)} disabled={busy} className="text-left hover:underline disabled:opacity-40">
                  {b.name} {b.nameEnglish && <span className="text-gray-400">/ {b.nameEnglish}</span>} <span className="font-mono text-[11px] text-gray-400">({b.brandId})</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <p className="text-[12px] text-gray-600">
          発送までの日数:{" "}
          {mapping?.mercariShippingDays ? (
            <span className="font-bold text-gray-900">
              {SHIPPING_DAYS_OPTIONS.find((o) => o.value === mapping.mercariShippingDays)?.label ?? mapping.mercariShippingDays}
            </span>
          ) : (
            <span className="text-gray-500">
              未設定（既定値「{SHIPPING_DAYS_OPTIONS.find((o) => o.value === DEFAULT_MERCARI_SHIPPING_DAYS)?.label}」を適用してCSV出力）
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-gray-400">
          何も変更しなければ既定値のままCSVへ出力されます。異なる日数で運用したい商品だけ選び直して保存してください。
        </p>
        <div className="mt-1 flex gap-2">
          <select
            value={shippingDaysDraft}
            onChange={(e) => setShippingDaysDraft(e.target.value)}
            disabled={busy || !mapping?.mercariCategoryId}
            className="border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-40"
          >
            <option value="">選択してください</option>
            {SHIPPING_DAYS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={saveShippingDays}
            disabled={busy || !mapping?.mercariCategoryId || !shippingDaysDraft}
            className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <p className="text-[12px] text-gray-600">
          配送料の負担:{" "}
          {mapping?.mercariShippingPayer ? (
            <span className="font-bold text-gray-900">{mapping.mercariShippingPayer === 1 ? "送料込（出品者負担）" : "送料別（購入者負担）"}</span>
          ) : (
            <span className="text-gray-500">
              未設定（既定値「{DEFAULT_MERCARI_SHIPPING_PAYER === 1 ? "送料込（出品者負担）" : "送料別（購入者負担）"}」を適用してCSV出力）
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-gray-400">
          何も変更しなければ既定値のままCSVへ出力されます。送料別で運用したい商品だけ選び直して保存してください。
        </p>
        <div className="mt-1 flex gap-2">
          <select
            value={shippingPayerDraft}
            onChange={(e) => setShippingPayerDraft(e.target.value)}
            disabled={busy || !mapping?.mercariCategoryId}
            className="border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-40"
          >
            <option value="">選択してください</option>
            <option value={1}>送料込（出品者負担）</option>
            <option value={2}>送料別（購入者負担）</option>
          </select>
          <button
            type="button"
            onClick={saveShippingPayer}
            disabled={busy || !mapping?.mercariCategoryId || !shippingPayerDraft}
            className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            保存
          </button>
        </div>

        {/* 送料ID(task_ca862bd2a1f6fbf60d、2026-09-15追加): 配送料の負担
            として「送料別」を選んでいる間だけ表示する——送料込では
            CSVにIDを出さないため入力させる意味が無い(実装方針§4)。
            表示条件はまだ保存していない選択中の値(shippingPayerDraft)
            を見る——「送料別」を選んだ直後、保存ボタンを押す前から欄と
            案内が見えている方が、何を入力すべきか分かりやすいため。 */}
        {shippingPayerDraft === "2" && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            {/* 見出しに「配送料の負担」という文字列を含めない——e2eの
                sectionSelect/sectionSummaryヘルパー(xpath contains(., '配送料の負担'))が
                この段落にも誤ヒットしてstrict modeで複数要素扱いになるのを防ぐため。 */}
            <p className="text-[12px] text-gray-600">
              送料ID（送料別の場合は必須）:{" "}
              {mapping?.mercariShippingFeeId ? (
                <span className="font-bold text-gray-900">{mapping.mercariShippingFeeId}</span>
              ) : (
                <span className="text-amber-700">未入力（CSV出力がブロックされます）</span>
              )}
            </p>
            <p className="mt-0.5 text-[11px] text-gray-400">
              Mercari Shops管理画面の「送料設定」で作成した送料IDをそのまま入力してください。BELLO側には送料IDの一覧・マスタが無く、送料額の算出・変更も行いません。
            </p>
            <div className="mt-1 flex gap-2">
              <input
                value={shippingFeeIdDraft}
                onChange={(e) => setShippingFeeIdDraft(e.target.value)}
                placeholder="Mercari管理画面で確認した送料ID"
                disabled={busy || !mapping?.mercariCategoryId}
                className="w-64 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-40"
              />
              <button
                type="button"
                onClick={saveShippingFeeId}
                disabled={busy || !mapping?.mercariCategoryId}
                className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                保存
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <p className="mb-1 text-[12px] font-bold text-gray-700">画像の受け渡し（CSV出力用）</p>
        <p className="mb-1 text-[11px] text-gray-400">
          CSVは画像ファイル名だけを含み、画像ファイル自体はMercari側で別途アップロードが必要です。
          保存されるファイル名はCSVの商品画像名列と同じになるため、手作業でのリネームは不要です。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleDownloadZip()}
            disabled={zipBusy}
            className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            title="下書き画像をまとめてZIPで保存します（1枚でも取得に失敗した場合はZIPは作成されません）"
          >
            {zipBusy ? "ZIP作成中…" : "画像をまとめてZIPで保存"}
          </button>
          <button
            type="button"
            onClick={() => void loadImageLinks()}
            disabled={imageLinksBusy}
            className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            {imageLinksBusy ? "取得中…" : "画像を1枚ずつ保存するリンクを表示"}
          </button>
        </div>
        {zipDone && <p className="mt-1 text-[12px] text-green-700">ZIPを保存しました。</p>}
        {zipError && <p className="mt-1 text-[12px] text-red-600">{zipError}</p>}
        {zipFailures && (
          <ul className="mt-1 list-disc pl-4 text-[12px] text-red-600">
            {zipFailures.map((f, i) => (
              <li key={`${f.inventoryId}-${i}`}>{f.reason}</li>
            ))}
          </ul>
        )}
        {imageLinksError && <p className="mt-1 text-[12px] text-red-600">{imageLinksError}</p>}
        {imageLinks && (
          <ul className="mt-1 text-[12px]">
            {imageLinks.map((link) => (
              <li key={link.filename}>
                {/* Content-Dispositionをサーバー側で指定済み(CSVと同じファイル名で保存される)。download属性は同一オリジン化した場合の保険。 */}
                <a href={link.url} download={link.filename} target="_blank" rel="noreferrer" className="text-blue-700 underline">
                  {link.filename}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {message && <p className="mt-2 text-[12px] text-green-700">{message}</p>}
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
