"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import type { MasterEntry } from "@/lib/inventory/masters";
import type { CustomFieldDefinitionRow } from "@/lib/inventory/queries";
import type { ZaicoTokenSource } from "@/lib/zaico/client";
import type { MercariTokenSource, MercariVerificationState } from "@/lib/listing/mercari/tokenAccess";
import type { LineTokenSource } from "@/lib/messaging/line/tokenAccess";
import type { BaseConnectionState } from "@/lib/base/connectionState";
import { MasterList } from "./MasterList";
import { CustomFieldSettings } from "./CustomFieldSettings";
import { ListColumnSettings } from "./ListColumnSettings";
import { ZaicoSyncPanel } from "./ZaicoSyncPanel";
import { ZaicoDuplicateAuditPanel } from "./ZaicoDuplicateAuditPanel";
import { ThumbnailBackfillPanel } from "./ThumbnailBackfillPanel";
import { ListingPartitionBackfillPanel } from "./ListingPartitionBackfillPanel";
import { MercariSettingsPanel } from "./MercariSettingsPanel";
import { BaseSettingsPanel } from "./BaseSettingsPanel";
import { ShippingRatePanel } from "./ShippingRatePanel";
import { LineSettingsPanel } from "./LineSettingsPanel";
import { SystemAuditPanel } from "./SystemAuditPanel";
import { PhotoProfilePanel } from "./PhotoProfilePanel";
import { KnowledgeSettingsPanel } from "./KnowledgeSettingsPanel";

interface SettingsTabsProps {
  categories: MasterEntry[];
  locations: MasterEntry[];
  units: MasterEntry[];
  customFields: CustomFieldDefinitionRow[];
  readOnly: boolean;
  /** ZAICO同期タブはADMINにのみ表示する（spec §19: UIレベルのADMIN制限）。実際の書き込み可否はServer Action側（app/actions/zaicoSync.ts）で独立に強制されるため、これは表示上のガードに過ぎない。 */
  isAdmin: boolean;
  /** サーバー環境変数ZAICO_API_TOKENが設定済みかどうか — 真偽値のみ、トークン本体は一切渡らない（page.tsxのgetZaicoTokenSource()から導出）。 */
  zaicoConnected: boolean;
  /** どちらの経路でTOKENが得られているか(値は含まない) — AWS Secrets Manager経由かどうかをADMINが画面上で確認できるようにする(lib/zaico/client.tsのgetZaicoTokenSource参照)。 */
  zaicoTokenSource: ZaicoTokenSource;
  /** BELLO統合改修 master指示書 Phase D — Mercari接続設定タブもADMINにのみ表示する。zaicoConnected/zaicoTokenSourceと同じ理由・同じ導出方法。 */
  mercariConnected: boolean;
  mercariTokenSource: MercariTokenSource;
  mercariEnvironment: "sandbox" | "production";
  /** BELLO統合業務OS指示書(2026-08-30) §24: 保存済みのAPIクライアント名(secrets-manager/env-fallbackどちらか、無ければnull) — TOKENと違い秘匿値ではないため表示してよい。 */
  mercariClientName: string | null;
  mercariClientNameSource: MercariTokenSource;
  /** 夜間統合指示書(2026-09-01) §3.4: 「接続済み」と「設定済みだが未検証」を区別するための状態。 */
  mercariVerification: MercariVerificationState;
  mercariLastCheckedAt: string | null;
  /** Secret自体を読めなかった場合の説明 — §6.1「失敗を未設定として黙って表示しない」。 */
  mercariSecretReadError: string | null;
  /** 夜間統合指示書(2026-09-01) §4.2: 既存のBASE特集ページ連携設定の状態をそのまま表示する(新しい認証情報は作らない)。 */
  baseConnection: BaseConnectionState;
  /** BELLO統合業務OS指示書(2026-08-30) §51-52: LINE接続設定タブもADMINにのみ表示する。mercariConnected/mercariTokenSourceと同じ理由・同じ導出方法。 */
  lineConnected: boolean;
  lineTokenSource: LineTokenSource;
}

/**
 * Simple sub-tab switch (spec: "タブまたはシンプルなサブメニューで構わ
 * ない") — a plain local state toggle is all these lists need; none of
 * them are ever deep-linked to on their own. 夜間開発指示書 §10:
 * 「設定を最低限：カテゴリ・単位・保管場所・追加項目・一覧表示設定・
 * ZAICO同期に整理」に合わせたタブ構成。
 */
export function SettingsTabs({
  categories,
  locations,
  units,
  customFields,
  readOnly,
  isAdmin,
  zaicoConnected,
  zaicoTokenSource,
  mercariConnected,
  mercariTokenSource,
  mercariEnvironment,
  mercariClientName,
  mercariClientNameSource,
  mercariVerification,
  mercariLastCheckedAt,
  mercariSecretReadError,
  baseConnection,
  lineConnected,
  lineTokenSource,
}: SettingsTabsProps) {
  // BASE OAuthのcallbackは `?tab=base` を付けてこのページへ戻る。
  // 操作を始めたタブへ結果と一緒に戻らないと、利用者は連携が成功したのか
  // どうかを確かめる場所を自分で探す羽目になる。
  const initialTab = useSearchParams().get("tab");

  const [tab, setTab] = useState<
    | "category"
    | "unit"
    | "location"
    | "customFields"
    | "columns"
    | "zaico"
    | "images"
    | "mercari"
    | "base"
    | "pricing"
    | "shipping"
    | "line"
    | "knowledge"
    | "systemAudit"
    | "photoProfile"
  >(initialTab === "base" ? "base" : "category");

  const tabClass = (active: boolean) =>
    `border-b-2 px-3 py-2 text-[13px] ${active ? "border-gray-900 font-bold text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`;

  return (
    <div>
      <div className="flex flex-wrap border-b border-gray-200">
        <button type="button" onClick={() => setTab("category")} className={tabClass(tab === "category")}>
          カテゴリ
        </button>
        <button type="button" onClick={() => setTab("unit")} className={tabClass(tab === "unit")}>
          単位
        </button>
        <button type="button" onClick={() => setTab("location")} className={tabClass(tab === "location")}>
          保管場所
        </button>
        <button type="button" onClick={() => setTab("customFields")} className={tabClass(tab === "customFields")}>
          追加項目
        </button>
        <button type="button" onClick={() => setTab("columns")} className={tabClass(tab === "columns")}>
          一覧表示設定
        </button>
        {isAdmin && (
          <button type="button" onClick={() => setTab("zaico")} className={tabClass(tab === "zaico")}>
            ZAICO同期
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setTab("images")} className={tabClass(tab === "images")}>
            画像最適化
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setTab("mercari")} className={tabClass(tab === "mercari")}>
            EC出品（Mercari）
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setTab("base")} className={tabClass(tab === "base")}>
            BASE連携
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setTab("pricing")} className={tabClass(tab === "pricing")}>
            自動値下げルール
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setTab("shipping")} className={tabClass(tab === "shipping")}>
            配送料金（家財おまかせ便）
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setTab("line")} className={tabClass(tab === "line")}>
            LINE連携
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setTab("knowledge")} className={tabClass(tab === "knowledge")}>
            AI返信ナレッジ
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setTab("systemAudit")} className={tabClass(tab === "systemAudit")}>
            System Audit
          </button>
        )}
        {isAdmin && (
          <button type="button" onClick={() => setTab("photoProfile")} className={tabClass(tab === "photoProfile")}>
            Photo Profile
          </button>
        )}
      </div>

      <div className="pt-4">
        {tab === "category" && <MasterList model="Category" label="カテゴリ" entries={categories} readOnly={readOnly} />}
        {tab === "unit" && <MasterList model="Unit" label="単位" entries={units} readOnly={readOnly} />}
        {tab === "location" && <MasterList model="Location" label="保管場所" entries={locations} readOnly={readOnly} />}
        {tab === "customFields" && <CustomFieldSettings fields={customFields} readOnly={readOnly} />}
        {/* 一覧表示設定の列候補には無効化された追加項目を含めない(新規登録/編集/詳細検索から消えるのと同じ扱い)。 */}
        {tab === "columns" && <ListColumnSettings customFieldDefs={customFields.filter((f) => f.isActive)} />}
        {tab === "zaico" && isAdmin && (
          <div className="space-y-6">
            <ZaicoSyncPanel zaicoConnected={zaicoConnected} zaicoTokenSource={zaicoTokenSource} />
            {/* 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11:
                同期設定と同じZAICOタブへ配置する(新規タブは作らない)。 */}
            <div className="border-t border-gray-200 pt-6">
              <ZaicoDuplicateAuditPanel />
            </div>
          </div>
        )}
        {tab === "images" && isAdmin && (
          <div className="space-y-6">
            <ThumbnailBackfillPanel />
            {/* 第六ラウンドP0-5: 内部索引フィールドの一度きりの移行 —
                サムネイルバックフィルと同じ「ADMINが必要に応じて一度回す」
                性質の内部メンテナンス作業なので、同じタブへ並べて配置する
                (新規タブは今回新設しない)。 */}
            <div className="border-t border-gray-200 pt-6">
              <ListingPartitionBackfillPanel />
            </div>
          </div>
        )}
        {tab === "mercari" && isAdmin && (
          <MercariSettingsPanel
            mercariConnected={mercariConnected}
            mercariTokenSource={mercariTokenSource}
            mercariEnvironment={mercariEnvironment}
            mercariClientName={mercariClientName}
            mercariClientNameSource={mercariClientNameSource}
            mercariVerification={mercariVerification}
            mercariLastCheckedAt={mercariLastCheckedAt}
            mercariSecretReadError={mercariSecretReadError}
          />
        )}
        {tab === "base" && isAdmin && <BaseSettingsPanel state={baseConnection} />}
        {/* 第六ラウンド§13-15(P0-3): 自動値下げルールの主導線はEC出品側
            (/inventory/listings/pricing-rules)へ移設した。ここに残す
            ロジック付きUIを二重に持たない(同じ設定を二箇所で編集できる
            状態を避ける、§118)——リンクのみ。 */}
        {tab === "pricing" && isAdmin && (
          <div className="text-[13px] text-gray-600">
            <p>自動値下げルールの管理は「EC出品」画面へ移動しました。</p>
            <a href="/inventory/listings/pricing-rules" className="mt-2 inline-block text-blue-700 underline">
              自動値下げルール管理画面を開く →
            </a>
          </div>
        )}
        {tab === "shipping" && isAdmin && <ShippingRatePanel />}
        {tab === "line" && isAdmin && <LineSettingsPanel lineConnected={lineConnected} lineTokenSource={lineTokenSource} />}
        {tab === "knowledge" && isAdmin && <KnowledgeSettingsPanel />}
        {tab === "systemAudit" && isAdmin && <SystemAuditPanel />}
        {tab === "photoProfile" && isAdmin && <PhotoProfilePanel />}
      </div>
    </div>
  );
}
