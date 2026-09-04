"use server";

import { randomUUID } from "node:crypto";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { generateCanonicalProductPage, toListingDraftCopy, type ListingDraftCopy } from "@/lib/ai/productPage/canonical";
import { formatSagawaSize } from "@/lib/shipping/sagawaSize";
import { saveGeneratedProductPage } from "@/lib/ai/productPage/history";

/**
 * BELLO統合業務OS指示書(2026-08-30) §56/§88-90: AI生成のServer Action層。
 * §89: 一覧を開いただけでAI requestしない — このファイルの関数は
 * すべてUIの明示的なボタン操作からのみ呼ばれる(自動実行される経路は
 * 無い)。書き込み権限(canEditInventory)を要求するのは、生成結果を
 * 実際に使う(下書きへ反映する)操作が編集操作だから — 生成そのものは
 * Inventory/Listing/Conversationのどれも書き込まない(読み取り専用)。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 第六ラウンド P0-1: AI自動下書き Server Components render error 根本修復
 *
 * 【再現した実際の現象】production build(`next build && next start`)
 * では、Server Action(`"use server"`関数)が`throw new Error("...")`
 * すると、Next.js自身が本文メッセージを問答無用でマスクし、クライアント
 * 側の`catch (err) { err.message }`には常に一言一句この文字列が渡る
 * ——実際にPlaywrightでproduction buildを起動し検証済み(下記参照):
 *   "An error occurred in the Server Components render. The specific
 *   message is omitted in production builds to avoid leaking sensitive
 *   details. A digest property is included on this error instance..."
 * これはこのアプリのバグではなくNext.js 14自身の意図的な仕様(Server
 * Actionからthrowされた値のmessageは、production buildでは常に安全側
 * に丸められる)。dev modeでは再現しない——本ラウンド仕様書が
 * 「dev modeだけ直して終了しない」と明記する通り、まさにこの差異が
 * 原因で見過ごされていた。
 *
 * 【根本修正方針】「エラーをthrowしてクライアントへ運ぶ」設計自体を
 * やめ、Server Action は例外を必ずこの関数内でcatchし、
 * `{ok:true,...} | {ok:false,error,correlationId}`という
 * シリアライズ可能な**戻り値**として返す(Next.js公式ドキュメントが
 * 推奨する「Server Actionのエラーはthrowでなくreturnで伝える」パターン)。
 * これによりNext.jsのmasking機構自体を経由しなくなり、
 * `requireEditPermission`/`getInventoryDetail`/`generateListingCopy`
 * (Anthropic API key未設定・provider timeout等)が投げる、元々secretを
 * 含まない安全な日本語メッセージ(このリポジトリ全体の既存の設計方針
 * ——describeAnthropicError等が徹底している)がそのままユーザーへ届く。
 *
 * 元の例外の詳細(スタック・digest相当のcorrelationId)はサーバー側の
 * structured logへ必ず記録する——「try/catchで隠すだけ」ではなく、
 * 見えなくなる情報は全てログに残す。
 */
function logActionFailure(action: string, correlationId: string, context: Record<string, unknown>, err: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      action,
      correlationId,
      timestamp: new Date().toISOString(),
      context,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
}

/** err.messageが常に安全(secretを含まない)であることは、このリポジトリの既存方針(describeAnthropicError等)が前提——Errorでない値だけ汎用文言にフォールバックする。 */
function safeErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

async function requireEditPermission(): Promise<void> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
}

export type GenerateListingCopyActionResult =
  | {
      ok: true;
      data: ListingDraftCopy;
      /** 品質検査で見つかった問題(空なら合格)。担当者向け。 */
      violations: string[];
      /** 在庫に無いため空欄のまま返した項目。 */
      missingFacts: string[];
      /** 参照した BELLO Style Profile の version。 */
      styleProfileVersion: number | null;
      /** 文体の参考にした過去BASE商品のID(監査用)。 */
      referencedBaseItemIds: string[];
      /** 紹介文から寸法を含む文を機械的に除去したか。 */
      introSanitized: boolean;
      /**
       * 在庫に無くBASEから補った項目(2026-09-03 追加指示 §33/§44)。
       * 何をどこから取ったかを担当者が見られるようにする。
       */
      completionNotes: string[];
      /** 生成履歴として保存できたか。保存できていればそのid。 */
      savedId: string | null;
      /**
       * データ不足の警告(2026-09-04 EC出品改修指示書 §21)。
       * 座面寸法が無い・配送ランクを確定できない等。**生成は止めず**、
       * 何が確定できなかったかを担当者へ出す。
       */
      warnings: string[];
      /** どのメンテナンス文・状態文をどの根拠で入れたか(§29 報告用)。 */
      ruleNotes: string[];
      /** ルールで確定した配送判定(画面に出して送料計算と突き合わせられるようにする)。 */
      shipping: {
        kazaiRank: string | null;
        kazaiSumCm: number | null;
        sagawaSize: string | null;
        sagawaNote: string;
      };
    }
  | { ok: false; error: string; correlationId: string };

/**
 * §57: Inventoryの事実情報のみをAIへ渡す — adminMemo(自社内での連絡
 * 事項)はこの関数が一切読み書きしていないことがその境界の証拠。
 */
export async function generateListingCopyAction(inventoryId: string): Promise<GenerateListingCopyActionResult> {
  const correlationId = randomUUID();
  try {
    await requireEditPermission();

    // ── 2026-09-02 指示書§2: 生成エンジンを一本化した ──────────
    //
    // 以前はここが lib/ai/ecCopy.ts の generateListingCopy を呼んでいた。
    // 同じ画面の下側にある「BASE商品ページの下書き」より品質が低かった
    // 理由は文章の巧拙ではなく、**片方にだけ機能が付いていた**ことだった:
    //
    //   BELLO Style Profile / 類似BASE商品 / セクション構造 /
    //   紹介文の寸法除外検査 / missing facts
    //
    // これらが上側には1つも無かった。下側を正本にして、上側からも
    // 同じ関数を呼ぶ。生成コアは複製しない(lib/ai/productPage/canonical.ts)。
    // 2026-09-03 追加指示 §41/§49: 「BASE商品ページの下書きを作る」の
    // UIを消し、生成の入口をここへ一本化した。あちら側にだけあった
    // 生成履歴の保存も、一緒に消えないようここへ引き取っている(§47)。
    const result = await generateCanonicalProductPage(inventoryId);
    const who = await getCurrentInventoryUserEmail();
    const history = await saveGeneratedProductPage(result, who);
    if (history.reason) {
      // 保存できなくても生成結果は返す。ただし黙って捨てない。
      console.warn(
        JSON.stringify({
          level: "warn",
          action: "generateListingCopyAction",
          correlationId,
          inventoryId,
          message: history.reason,
        }),
      );
    }

    if (result.redactions.length > 0) {
      console.info(
        JSON.stringify({
          level: "info",
          action: "generateListingCopyAction",
          correlationId,
          message: "AIへ渡す前に除外した項目があります",
          inventoryId,
          redactions: result.redactions,
        }),
      );
    }

    const copy = toListingDraftCopy(result);
    if (!copy) {
      return {
        ok: false,
        error: result.failureReason ?? "AI下書きの生成に失敗しました。",
        correlationId,
      };
    }

    // 品質検査に落ちた場合も、何が出たのかを人が見られるように結果は返す
    // ——ただし「問題なし」とは言わない。violations を添えて返す。
    return {
      ok: true,
      data: copy,
      violations: result.violations.map((v) => v.detail),
      missingFacts: result.missingFacts,
      styleProfileVersion: result.usedStyleProfileVersion,
      referencedBaseItemIds: result.referencedBaseItemIds,
      introSanitized: result.introSanitized ?? false,
      completionNotes: result.completionNotes,
      savedId: history.savedId,
      warnings: result.warnings,
      ruleNotes: result.ruleNotes,
      shipping: {
        kazaiRank: result.facts.shippingRank,
        kazaiSumCm: result.facts.shippingSumCm,
        sagawaSize: formatSagawaSize(result.facts.sagawa),
        sagawaNote: result.facts.sagawa.note,
      },
    };
  } catch (err) {
    logActionFailure("generateListingCopyAction", correlationId, { inventoryId }, err);
    return { ok: false, error: safeErrorMessage(err, "AI下書きの生成に失敗しました。時間をおいて再試行してください。"), correlationId };
  }
}
