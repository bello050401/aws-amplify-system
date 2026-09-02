"use client";

import { useEffect, useState } from "react";
import {
  activateSettingsAction,
  compareGenerationAction,
  createGuidanceAction,
  getProductDescriptionSettingsAction,
  restoreSettingsVersionAction,
  testGenerateAction,
  updateGuidanceAction,
  type ProductDescriptionSettingsView,
  type StyleProfileSummary,
  type TestGenerationResult,
} from "@/app/actions/productDescriptionSettings";

/**
 * 設定 ＞ 商品説明文(2026-09-02 追加仕様§1〜§10)。
 *
 * 4領域:
 *   1. 文体プロファイル … 過去BASE商品を数えた結果を、人が読める形で
 *   2. 改善指示        … 人が書いた要望。生成pipelineへ正式に渡る
 *   3. テスト生成      … 実在商品で今の設定を試す
 *   4. 変更履歴        … version と復元
 *
 * 「分析済み 267件 / 確からしさ 0.996」だけでは中身が見えない、という
 * 指摘への対処が1.。存在しない分析値をここで作らない —— Profileに
 * 無い統計は表示しない。
 */
export function ProductDescriptionPanel({ readOnly }: { readOnly: boolean }) {
  const [view, setView] = useState<ProductDescriptionSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newInstruction, setNewInstruction] = useState("");
  const [activateNote, setActivateNote] = useState("");
  const [testInventoryId, setTestInventoryId] = useState("");
  const [testResult, setTestResult] = useState<TestGenerationResult | null>(null);
  const [compare, setCompare] = useState<{ before: TestGenerationResult; after: TestGenerationResult } | null>(null);
  const [candidate, setCandidate] = useState("");
  const [showProfileDetail, setShowProfileDetail] = useState(false);

  async function load() {
    const r = await getProductDescriptionSettingsAction();
    if (r.ok) {
      setView(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function run<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, after?: (d: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      after?.(r.data);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "処理に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  if (error && !view) {
    return (
      <div className="text-[12px]">
        <p className="text-red-600">商品説明文の設定を読み込めませんでした: {error}</p>
        <button type="button" onClick={() => void load()} className="mt-1 border border-gray-300 px-2 py-1">
          再試行
        </button>
      </div>
    );
  }
  if (!view) return <p className="text-[12px] text-gray-400">読み込み中…</p>;

  const enabledGuidance = view.guidance.filter((g) => g.enabled);

  return (
    <div className="space-y-6 text-[12px]">
      <p className="text-gray-500">
        AIが商品説明を書くときに参照する「過去のBELLO商品説明から数えた文体」と「担当者が指定する書き方の指示」を管理します。
        商品の事実(寸法・素材・ブランド等)は在庫データが正本で、ここの指示で事実を変えることはできません。
      </p>
      {error && <p className="border border-red-300 bg-red-50 p-2 text-red-700">{error}</p>}

      {/* ── 1. 文体プロファイル ────────────────────────────────── */}
      <section>
        <h3 className="mb-2 text-[13px] font-bold text-gray-900">1. 文体プロファイル</h3>
        {view.styleProfile ? (
          <StyleProfileView
            profile={view.styleProfile}
            archiveSize={view.archiveSize}
            open={showProfileDetail}
            onToggle={() => setShowProfileDetail((v) => !v)}
          />
        ) : (
          <p className="text-gray-400">
            文体プロファイルがまだ作成されていません。「BASE連携」タブから過去商品を取り込み、文体分析を実行してください。
          </p>
        )}
      </section>

      {/* ── 2. 改善指示 ────────────────────────────────────────── */}
      <section>
        <h3 className="mb-2 text-[13px] font-bold text-gray-900">2. BELLO改善指示</h3>
        <p className="mb-2 text-gray-500">
          自然文で書いた要望が、そのまま商品説明の生成へ渡ります。優先順位は
          <span className="font-bold">「在庫の確定事実 &gt; この指示 &gt; 文体プロファイル &gt; 類似商品」</span>。
          削除ではなく無効化を使ってください(過去の生成がどの指示のもとで作られたかを追えるようにするため)。
        </p>

        {view.guidance.length === 0 ? (
          <p className="text-gray-400">まだ改善指示はありません。</p>
        ) : (
          <ul className="space-y-1">
            {view.guidance.map((g) => (
              <li key={g.id} className={`flex items-start gap-2 border p-2 ${g.enabled ? "border-gray-200" : "border-gray-100 bg-gray-50"}`}>
                <input
                  type="checkbox"
                  checked={g.enabled}
                  disabled={readOnly || busy}
                  onChange={(e) => void run(() => updateGuidanceAction(g.id, { enabled: e.target.checked }))}
                  className="mt-0.5"
                  aria-label={g.enabled ? "有効" : "無効"}
                />
                <div className="min-w-0 flex-1">
                  <p className={g.enabled ? "text-gray-900" : "text-gray-400 line-through"}>{g.instruction}</p>
                  <p className="text-[10px] text-gray-400">
                    v{g.version} ・ 更新 {g.updatedAt.slice(0, 10)}
                    {g.updatedBy ? ` ・ ${g.updatedBy}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {!readOnly && (
          <div className="mt-2">
            <textarea
              value={newInstruction}
              onChange={(e) => setNewInstruction(e.target.value)}
              rows={2}
              placeholder="例: 商品のご紹介にはサイズを書かない / 「リビングにぴったり」のような汎用的な表現を減らす"
              className="w-full border border-gray-300 px-2 py-1"
            />
            <button
              type="button"
              disabled={busy || !newInstruction.trim()}
              onClick={() =>
                void run(
                  () => createGuidanceAction(newInstruction),
                  () => setNewInstruction(""),
                )
              }
              className="mt-1 bg-gray-900 px-3 py-1 font-bold text-white disabled:opacity-50"
            >
              改善指示を追加
            </button>
          </div>
        )}
      </section>

      {/* ── 3. テスト生成 / Before-After ───────────────────────── */}
      <section>
        <h3 className="mb-2 text-[13px] font-bold text-gray-900">3. テスト生成</h3>
        <p className="mb-2 text-gray-500">
          実在の在庫で、いまの設定のまま生成してみます。使った文体プロファイルの版・参考にした過去商品・適用した改善指示・検査結果も表示します。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={testInventoryId}
            onChange={(e) => setTestInventoryId(e.target.value)}
            placeholder="在庫ID(UUID)を貼り付け"
            className="w-96 border border-gray-300 px-2 py-1"
          />
          <button
            type="button"
            disabled={busy || readOnly || !testInventoryId.trim()}
            onClick={() =>
              void run(
                () => testGenerateAction(testInventoryId.trim()),
                (d) => {
                  setTestResult(d);
                  setCompare(null);
                },
              )
            }
            className="border border-gray-300 px-3 py-1 disabled:opacity-50"
          >
            {busy ? "生成中…" : "この設定で生成"}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-gray-400">
          在庫IDは在庫詳細画面のURL(/inventory/&lt;ID&gt;)から取れます。
        </p>

        {testResult && <GenerationResultView result={testResult} title="生成結果" />}

        <div className="mt-4 border-t border-gray-100 pt-3">
          <h4 className="mb-1 font-bold text-gray-800">Before / After 比較</h4>
          <p className="mb-2 text-gray-500">
            いまの正式設定(Before)と、下に書いた変更候補(After)で同じ商品を生成して見比べます。
            <span className="font-bold">候補を保存しなくても比較できます</span> ——
            保存しただけで全体の生成挙動が変わることを避けるためです。
          </p>
          <textarea
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
            rows={4}
            placeholder={"変更候補の改善指示(1行に1つ)\n" + enabledGuidance.map((g) => g.instruction).join("\n")}
            className="w-full border border-gray-300 px-2 py-1"
          />
          <button
            type="button"
            disabled={busy || readOnly || !testInventoryId.trim()}
            onClick={() =>
              void run(
                () => compareGenerationAction(testInventoryId.trim(), candidate.split("\n")),
                (d) => {
                  setCompare(d);
                  setTestResult(null);
                },
              )
            }
            className="mt-1 border border-gray-300 px-3 py-1 disabled:opacity-50"
          >
            Before / After を比較
          </button>
          <button
            type="button"
            disabled={busy || readOnly}
            onClick={() => setCandidate(enabledGuidance.map((g) => g.instruction).join("\n"))}
            className="ml-2 mt-1 border border-gray-300 px-3 py-1 disabled:opacity-50"
          >
            現在の指示を候補欄へコピー
          </button>

          {compare && (
            <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <GenerationResultView result={compare.before} title="Before（現在の正式設定）" />
              <GenerationResultView result={compare.after} title="After（変更候補）" />
            </div>
          )}
        </div>
      </section>

      {/* ── 4. 反映と履歴 ─────────────────────────────────────── */}
      <section>
        <h3 className="mb-2 text-[13px] font-bold text-gray-900">4. 変更履歴</h3>
        {!readOnly && (
          <div className="mb-3 border border-gray-200 p-2">
            <p className="mb-1 text-gray-600">
              いまの改善指示の内容を1つの版として記録し、正式設定にします。
              (指示の追加・編集そのものは即座に生成へ効きます。ここは「いつ・どういう意図で変えたか」を残すための操作です。)
            </p>
            <input
              value={activateNote}
              onChange={(e) => setActivateNote(e.target.value)}
              placeholder="変更の理由(任意)"
              className="w-96 border border-gray-300 px-2 py-1"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => activateSettingsAction(activateNote),
                  () => setActivateNote(""),
                )
              }
              className="ml-2 bg-gray-900 px-3 py-1 font-bold text-white disabled:opacity-50"
            >
              この内容を商品説明ルールに反映
            </button>
          </div>
        )}

        {view.versions.length === 0 ? (
          <p className="text-gray-400">まだ履歴はありません。</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="py-1 font-normal">版</th>
                <th className="py-1 font-normal">反映日時</th>
                <th className="py-1 font-normal">文体プロファイル</th>
                <th className="py-1 font-normal">指示</th>
                <th className="py-1 font-normal">メモ</th>
                <th className="py-1 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {view.versions.map((v) => (
                <tr key={v.id} className="border-b border-gray-100 align-top">
                  <td className="py-1">
                    v{v.version}
                    {v.isActive && <span className="ml-1 bg-gray-900 px-1 text-[10px] text-white">現在</span>}
                  </td>
                  <td className="py-1">{v.activatedAt.slice(0, 16).replace("T", " ")}</td>
                  <td className="py-1">{v.styleProfileVersion != null ? `v${v.styleProfileVersion}` : "—"}</td>
                  <td className="py-1">
                    {v.guidanceSnapshot.filter((g) => g.enabled).length}件有効 / 全{v.guidanceSnapshot.length}件
                  </td>
                  <td className="py-1 text-gray-600">
                    {v.note ?? "—"}
                    {v.restoredFromVersion != null && <span className="text-gray-400">（v{v.restoredFromVersion} から復元）</span>}
                  </td>
                  <td className="py-1 text-right">
                    {!readOnly && !v.isActive && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => restoreSettingsVersionAction(v.id))}
                        className="border border-gray-300 px-2 py-0.5 disabled:opacity-50"
                      >
                        この版へ戻す
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-1 text-[10px] text-gray-400">
          「この版へ戻す」は過去の版を書き換えず、その内容で新しい版を作って現在の設定にします(履歴が枝分かれしないようにするため)。
        </p>
      </section>
    </div>
  );
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function StyleProfileView({
  profile,
  archiveSize,
  open,
  onToggle,
}: {
  profile: StyleProfileSummary;
  archiveSize: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border border-gray-200 p-3">
      <dl className="grid grid-cols-[10rem_1fr] gap-y-0.5">
        <dt className="text-gray-500">プロファイル版</dt>
        <dd>v{profile.version}</dd>
        <dt className="text-gray-500">分析対象</dt>
        <dd>
          {profile.analyzedItemCount}件（紹介文を抽出できたもの {profile.introExtractedCount}件 / 参照可能な過去商品 {archiveSize}件）
        </dd>
        <dt className="text-gray-500">対象期間</dt>
        <dd>
          {profile.analysisPeriod.start?.slice(0, 10) ?? "—"} 〜 {profile.analysisPeriod.end?.slice(0, 10) ?? "—"}
        </dd>
        <dt className="text-gray-500">最終分析</dt>
        <dd>{profile.generatedAt.slice(0, 16).replace("T", " ")}</dd>
        <dt className="text-gray-500">確からしさ</dt>
        <dd>
          {profile.confidence}
          <button type="button" onClick={onToggle} className="ml-2 text-blue-700 underline">
            {open ? "詳細を閉じる" : "詳細"}
          </button>
        </dd>
      </dl>

      {open && (
        <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
          {/* §3 「確からしさ」を説明可能にする */}
          <div className="border border-amber-200 bg-amber-50 p-2">
            <p className="font-bold text-amber-900">「確からしさ」の意味</p>
            <p className="mt-1">
              計算式: <code>{profile.confidenceExplanation.formula}</code>
            </p>
            <p>
              = min(1, {profile.analyzedItemCount} ÷ 200) × ({profile.introExtractedCount} ÷ {profile.analyzedItemCount}) =
              {" "}
              {profile.confidenceExplanation.sampleScore.toFixed(3)} × {profile.confidenceExplanation.extractionScore.toFixed(3)} ={" "}
              {profile.confidence}
            </p>
            <p className="mt-1 text-amber-900">{profile.confidenceExplanation.meaning}</p>
          </div>

          <Block title="よく使われる見出しと出現順">
            <table className="w-full border-collapse">
              <tbody>
                {profile.sectionRules.map((s) => (
                  <tr key={s.heading} className="border-b border-gray-50">
                    <td className="py-0.5">{s.heading}</td>
                    <td className="py-0.5 text-right text-gray-600">{pct(s.ratio)}</td>
                    <td className="py-0.5 text-right text-gray-400">平均出現順 {s.averageOrder.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-gray-500">推奨する並び: {profile.recommendedSectionOrder.join(" → ")}</p>
          </Block>

          <Block title="「◎商品のご紹介」の書き方">
            <p>
              長さ 中央値 {profile.introLength.median}字（{profile.introLength.min}〜{profile.introLength.max}） ／ 段落数 中央値{" "}
              {profile.introParagraphs.median}（{profile.introParagraphs.min}〜{profile.introParagraphs.max}）
            </p>
            <p>ですます調の文の割合: {pct(profile.politeSentenceRatio)}</p>
            <p>ブランド名で始まる: {pct(profile.startsWithBrandRatio)} ／ 英字ブランド名（カタカナ読み）の書式: {pct(profile.latinWithKanaReadingRatio)}</p>
            {profile.commonOpeningForms.length > 0 && (
              <p className="mt-1">よく使う書き出し: {profile.commonOpeningForms.slice(0, 5).map((o) => `${o.value}(${pct(o.ratio)})`).join(" / ")}</p>
            )}
            {profile.commonClosingForms.length > 0 && (
              <p>よく使う締め: {profile.commonClosingForms.slice(0, 5).map((o) => `${o.value}(${pct(o.ratio)})`).join(" / ")}</p>
            )}
          </Block>

          <Block title="サイズ情報をどこに置くか">
            <p>
              紹介文に寸法が含まれる割合: <span className="font-bold">{pct(profile.dimensionInIntroRatio)}</span>
            </p>
            {profile.dimensionPlacement.length > 0 && (
              <p>実際の置き場所: {profile.dimensionPlacement.map((p) => `${p.value}(${pct(p.ratio)})`).join(" / ")}</p>
            )}
            <p className="text-gray-500">
              過去のBELLO商品でも寸法は「商品詳細」側に置かれています。生成でも紹介文に寸法を入れないよう、機械的な検査を通しています。
            </p>
          </Block>

          <Block title="使う表現 / 使わない表現">
            {profile.preferredPhrases.length > 0 && (
              <p>よく使う表現: {profile.preferredPhrases.slice(0, 10).map((p) => p.value).join(" / ")}</p>
            )}
            {profile.unusedSymbols.length > 0 && (
              <p>過去の商品説明で1件も使われていない記号: {profile.unusedSymbols.join(" ")}</p>
            )}
            {profile.prohibitedPhrases.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-gray-600">
                {profile.prohibitedPhrases.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
          </Block>

          <Block title="ブランド / カテゴリの分布">
            {profile.topBrands.length > 0 && <p>よく扱うブランド: {profile.topBrands.slice(0, 10).map((b) => `${b.value}(${pct(b.ratio)})`).join(" / ")}</p>}
            {profile.categoryDistribution.length > 0 && (
              <p>カテゴリ: {profile.categoryDistribution.slice(0, 10).map((c) => `${c.value}(${pct(c.ratio)})`).join(" / ")}</p>
            )}
            <p className="text-gray-500">
              類似商品の検索では、ブランド一致を最重視し、次にカテゴリ・価格帯・商品名の語の重なりを見ます。
              過去商品は<span className="font-bold">文体の見本</span>であって、事実の出典ではありません。
            </p>
          </Block>
        </div>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 font-bold text-gray-800">{title}</p>
      <div className="space-y-0.5 text-gray-700">{children}</div>
    </div>
  );
}

function GenerationResultView({ result, title }: { result: TestGenerationResult; title: string }) {
  return (
    <div className="mt-2 border border-gray-200 p-2">
      <p className="mb-1 font-bold text-gray-800">{title}</p>
      <dl className="grid grid-cols-[9rem_1fr] gap-y-0.5 text-[11px] text-gray-600">
        <dt>対象商品</dt>
        <dd>{result.inventoryName}</dd>
        <dt>文体プロファイル</dt>
        <dd>{result.styleProfileVersion != null ? `v${result.styleProfileVersion}` : "未設定"}</dd>
        <dt>参考にした過去商品</dt>
        <dd>{result.referencedBaseItemIds.length}件（{result.referencedBaseItemIds.join(", ") || "—"}）</dd>
        <dt>適用した改善指示</dt>
        <dd>{result.appliedGuidance.length > 0 ? result.appliedGuidance.join(" / ") : "なし"}</dd>
        <dt>在庫に無い項目</dt>
        <dd>{result.missingFacts.length > 0 ? result.missingFacts.join("、") : "なし"}</dd>
      </dl>

      {result.introSanitized && (
        <p className="mt-1 border border-amber-300 bg-amber-50 p-1 text-[11px] text-amber-800">
          「◎商品のご紹介」に寸法が含まれていたため、該当の文を自動で取り除きました。
        </p>
      )}
      {result.genericPhrases.length > 0 && (
        <p className="mt-1 text-[11px] text-gray-500">一般的なEC表現: {result.genericPhrases.join("、")}</p>
      )}
      {result.violations.length > 0 ? (
        <ul className="mt-1 border border-amber-300 bg-amber-50 p-1 text-[11px] text-amber-800">
          {result.violations.map((v, i) => (
            <li key={i}>・{v}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-gray-500">品質検査: 問題は見つかりませんでした。</p>
      )}

      {result.title && <p className="mt-2 font-bold text-gray-900">{result.title}</p>}
      {result.fullDescription && (
        <pre className="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap border border-gray-100 bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-800">
          {result.fullDescription}
        </pre>
      )}
    </div>
  );
}
