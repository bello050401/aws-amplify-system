"use client";

import { useEffect, useRef, useState } from "react";
import {
  getMercariCsvImageDownloadLinksAction,
  getMercariCsvImageZipPlanAction,
  saveChannelOverrideAction,
  searchMercariBrandsAction,
  type MercariCsvImageDownloadLink,
} from "@/app/actions/listing";
import { assembleZipFromPlan, downloadZipBlob } from "@/lib/listing/mercari/csv/browserImageZip";
import type { ChannelListingRecord } from "@/lib/listing/types";
import type { BrandMasterEntry } from "@/lib/listing/mercari/csv/masters";
import { MercariFurnitureCategoryPicker } from "./MercariFurnitureCategoryPicker";

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
 * カテゴリー選択(task_302c7e3c24b575629d、2026-09-15是正): 新規選択は
 * 「家具・インテリア」配下の8入口(ライト・照明/机・テーブル/椅子・
 * チェア/ソファ・ソファベッド/棚・ラック・シェルフ/ベッド/事務・
 * 店舗用品/その他)からの階層クリック(MercariFurnitureCategoryPicker.tsx
 * ——木構造はlib/listing/mercari/csv/furnitureCategoryTree.tsが公式
 * マスタのfullPathから実際に組み立てる、公式IDの捏造なし)に限定する。
 * ピッカー内の家具内検索も、既に取得済みの家具限定の木をその場で
 * フラット化するだけで、家具・インテリア以外のマスタへは一切到達
 * しない。
 *
 * これは前回の実装(task_b1b6caa7bac795f96b)が「他のカテゴリを検索」と
 * いう予備導線で全カテゴリマスタ(家具外を含む7,625件)を新規選択でき
 * てしまっていた——「新規選択は家具限定」という要求と矛盾していた
 * ——ことの是正でもある。旧範囲外(家具・インテリア以外)の既存カテゴリ
 * は、削除も強制変更もせずそのまま表示し続ける(下の「現在のカテゴリー」
 * 表示はmapping自体を見るだけで、ピッカーの内部状態に依存しない)——
 * 変更したい場合は家具ピッカーから選び直すことになる(家具外へは
 * 新規に変更できない)。
 *
 * ブランドはローカルのマスタCSV(data/mercari-masters/、提供物その
 * まま)を検索するだけ(searchMercariBrandsAction参照、外部APIへは
 * 一切到達しない)。同名の末端カテゴリが複数IDに存在しうるため、
 * 検索結果には必ずフルパスを添えて表示し、AIや文字列類似だけで確定
 * しない——選ぶのは常に人。ブランドは指示書§4のとおり任意。
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
  const [brandQuery, setBrandQuery] = useState("");
  const [brandResults, setBrandResults] = useState<BrandMasterEntry[] | null>(null);
  const [brandSearchBusy, setBrandSearchBusy] = useState(false);
  const [brandSearchError, setBrandSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mapping = channelListing?.categoryMapping ?? null;

  const [shippingDaysDraft, setShippingDaysDraft] = useState<string>(mapping?.mercariShippingDays ? String(mapping.mercariShippingDays) : "");
  // 保存後(onUpdated経由でchannelListingプロパティが差し替わった時)に
  // 選択中の値を最新の永続値へ同期する——他の入力(検索欄)と違い、
  // ここは「保存済みの値そのもの」を表示する欄なので追随させる。
  useEffect(() => {
    setShippingDaysDraft(mapping?.mercariShippingDays ? String(mapping.mercariShippingDays) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping?.mercariShippingDays]);

  const [shippingPayerDraft, setShippingPayerDraft] = useState<string>(mapping?.mercariShippingPayer ? String(mapping.mercariShippingPayer) : "");
  // shippingDaysDraftと同じ理由で、保存済み値の変化に追随させる。
  useEffect(() => {
    setShippingPayerDraft(mapping?.mercariShippingPayer ? String(mapping.mercariShippingPayer) : "");
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

  // 家具店向け効率化指示書(2026-09-15) §4-D: ブランド検索の改良。
  // - 入力のたびに自動検索する(デバウンス300ms、検索語を考えず
  //   打ち始めればよい体験に近づける)。「検索」ボタンも残し、即時実行
  //   したい場合に使える(どちらもrunBrandSearchを共有)。
  // - `brandSearchSeqRef`で「今表示すべき最新の検索」だけを反映する——
  //   遅い応答が返ってきた古い検索が、後から打った新しい検索の結果を
  //   上書きしない(指示書§4-D「遅い旧検索応答が新検索を上書きしない」)。
  // - 検索中/0件/失敗をそれぞれ別状態で持ち、失敗時は同じ関数で再試行
  //   できる。
  const brandSearchSeqRef = useRef(0);

  async function runBrandSearch(query: string) {
    const trimmed = query.trim();
    if (!trimmed) {
      brandSearchSeqRef.current += 1;
      setBrandResults(null);
      setBrandSearchError(null);
      setBrandSearchBusy(false);
      return;
    }
    const seq = ++brandSearchSeqRef.current;
    setBrandSearchBusy(true);
    setBrandSearchError(null);
    try {
      const results = await searchMercariBrandsAction(trimmed);
      if (seq !== brandSearchSeqRef.current) return; // 新しい検索に上書き済み、古い応答は破棄
      setBrandResults(results);
    } catch (err) {
      if (seq !== brandSearchSeqRef.current) return;
      setBrandSearchError(err instanceof Error ? err.message : "ブランド検索に失敗しました。");
      setBrandResults(null);
    } finally {
      if (seq === brandSearchSeqRef.current) setBrandSearchBusy(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void runBrandSearch(brandQuery);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandQuery]);

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

  /**
   * 家具店向け効率化指示書(2026-09-15) §4-B: 8入口ナビゲータ
   * (MercariFurnitureCategoryPicker)の「このカテゴリに決定」から呼ばれる。
   * `categoryId`/`fullPath`はナビゲータが公式マスタから組み立てた木
   * (lib/listing/mercari/csv/furnitureCategoryTree.ts)由来の値のみで、
   * 自由入力は一切経由しない——既存のブランド/発送設定は保持する。
   * task_302c7e3c24b575629d是正: 新規カテゴリ選択の経路はこの関数のみ
   * (旧来の全カテゴリ自由文字列検索からのselectCategoryは削除済み)。
   */
  function confirmCategory(categoryId: string, fullPath: string) {
    void persist({
      mercariCategoryId: categoryId,
      mercariCategoryName: fullPath,
      mercariBrandId: mapping?.mercariBrandId,
      mercariBrandName: mapping?.mercariBrandName,
      mercariShippingDays: mapping?.mercariShippingDays,
      mercariShippingPayer: mapping?.mercariShippingPayer,
      mercariShippingFeeId: mapping?.mercariShippingFeeId,
    });
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
    setBrandQuery("");
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
   * 発送までの日数の保存。§4「確認済み設定がなければ利用者選択必須」——
   * カテゴリーと違い公式マスタが無く選択肢は固定5値のみなので検索UIは
   * 持たず、選んで保存するだけ。カテゴリー未確定のまま保存すると
   * saveChannelOverrideAction自体は通ってしまう(categoryMappingは
   * mercariCategoryId必須の型のため、実際には先にカテゴリーが要る)。
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
   * 配送料の負担の保存。§4「既存確認済値を採用し不明は選択」——BELLOには
   * 「送料を誰が負担するか」を表す既存の確認済み運用値が無い
   * (lib/listing/types.tsの624307eでのShippingPayerCode削除コメント
   * 参照)ため、発送までの日数と同じく既定値を出さず、商品ごとに人が
   * 選んで保存する。
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
        <p className="mt-0.5 text-[11px] text-gray-400">
          新規に選べるのは「家具・インテリア」配下のみです。家具・インテリア以外の既存カテゴリが設定されている場合はそのまま表示され続けます——変更する場合は下の一覧から家具のカテゴリを選び直してください。
        </p>

        <div className="mt-1">
          <MercariFurnitureCategoryPicker
            inventoryId={inventoryId}
            currentFullPath={mapping?.mercariCategoryName ?? undefined}
            busy={busy}
            onConfirm={confirmCategory}
          />
        </div>
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
            onClick={() => void runBrandSearch(brandQuery)}
            disabled={busy || brandSearchBusy || !brandQuery.trim()}
            className="border border-gray-300 px-2 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            {brandSearchBusy ? "検索中…" : "検索"}
          </button>
        </div>
        {brandSearchError && (
          <p className="mt-1 text-[12px] text-red-600">
            {brandSearchError}{" "}
            <button type="button" onClick={() => void runBrandSearch(brandQuery)} className="underline">
              再試行
            </button>
          </p>
        )}
        {!brandSearchError && brandResults && (
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
            <span className="text-amber-700">未選択（CSV出力がブロックされます）</span>
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-gray-400">確認済みの既定値が無いため、商品ごとに選んで保存してください。</p>
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
            <span className="text-amber-700">未選択（CSV出力がブロックされます）</span>
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-gray-400">
          BELLOには「送料を誰が負担するか」を表す既存の確認済み運用値が無いため、既定値を出さず商品ごとに選んで保存してください。
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
