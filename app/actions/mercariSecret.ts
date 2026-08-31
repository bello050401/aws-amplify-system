"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { validateMercariConnection } from "@/lib/listing/mercari/adapter";
import type { MercariErrorCode } from "@/lib/listing/mercari/client";
import { clearMercariTokenInSecretsManager, readMercariConnectionSecret, setMercariConnectionInSecretsManager } from "@/lib/listing/mercari/secretStore";
import { decideMercariSave, isMercariRetryableForUser, isMercariTokenRejected } from "@/lib/listing/mercari/connectionPolicy";

/**
 * Mercari Shops接続設定(TOKEN + APIクライアント名)の登録/接続確認/削除。
 *
 * ## 夜間統合指示書(2026-09-01) §3.3/§3.4 で作り直した点
 *
 * ### 1. `undefined.success` の根絶
 *
 * 実画面で `Cannot read properties of undefined (reading 'success')` が
 * 出ていた。経路はMercariSettingsPanel.tsxの
 * `const res = await setMercariConnectionAction(...); res.success` で、
 * `res`がundefinedだと **このTypeError自体がpanel側のcatchに拾われ、
 * `err.message`がそのまま画面へ出る** —— 報告された文言と完全に一致する。
 *
 * Server Actionの戻り値がundefinedに見え得るのは、この関数が値を返さない
 * 場合だけではない。`requireAdmin()`のように **戻り値の型に現れない例外**
 * を投げる経路があると、呼び出し側は「戻り値のcontract」と「例外」の
 * 2系統を両方正しく扱わねばならず、片方が漏れる。そこでこの関数は
 * **決して例外を投げず、必ず判別可能な結果オブジェクトを返す** ことを
 * 契約とした(全体をtry/catchで包み、想定外の例外もUNKNOWNへ畳む)。
 * 秘密値(TOKEN)は戻り値にもメッセージにもログにも一切含めない。
 *
 * ### 2. 「保存デッドロック」の解消
 *
 * 以前は「接続確認に成功した場合のみSecretへ保存」だった。しかしMercariは
 * **未登録の送信元IPからのリクエストに対し、認証を評価する前に404を返す**
 * (公式FAQ「申請いただいていないIPアドレスからのリクエストに対しては
 * 404 NotFound が返却されます」。2026-09-01の実測でも、Authorizationヘッダ
 * を付けない場合と付けた場合で応答が完全に同一だった)。
 *
 * つまりIPが未登録の間は **正しいTOKENを入れても接続確認は必ず失敗し、
 * したがってTOKENを保存する手段が存在しない**。実際、Secret
 * `bello/mercari-access-token` は作成時の`{configured:false}`のまま
 * 一度も更新されていなかった。これが「TOKENを保存できない」の正体である。
 *
 * そこで失敗の **種類** で扱いを分ける:
 *
 *   - TOKENそのものが拒否された(401/400) → 保存しない。保存しても無意味。
 *   - TOKENの正否を判定できない(404=IP未登録 / ネットワーク / タイムアウト /
 *     レート制限 / 想定外応答) → **既存の検証済み設定が無い場合に限り**
 *     「設定済み・未検証」として保存する。IP登録が済んだ時点で
 *     「接続確認」を押すだけでよくなる。
 *   - 既に検証済みの設定がある場合は上書きしない(§92の既存意図を維持)。
 *
 * どの場合も「接続済み」と偽らない。状態はverifiedフラグとしてSecretへ
 * 記録され、設定画面はそれを区別して表示する。
 */

/** UIが分岐に使う、この操作固有のエラー分類。MercariErrorCode(通信層の分類)とは別レイヤ。 */
export type MercariActionErrorCode =
  | "FORBIDDEN"
  | "TOKEN_NOT_PROVIDED"
  | "CLIENT_NAME_NOT_PROVIDED"
  | "INVALID_TOKEN"
  | "CONNECTION_UNVERIFIABLE"
  | "SECRET_READ_FAILED"
  | "SECRET_WRITE_FAILED"
  | "UNKNOWN";

export type MercariConnectionActionResult =
  | {
      success: true;
      /** CONNECTED = 接続確認済み / SAVED_UNVERIFIED = 保存はしたが接続確認は取れていない / DELETED = 削除完了 */
      status: "CONNECTED" | "SAVED_UNVERIFIED" | "DELETED";
      message: string;
      checkedAt: string;
      /** SAVED_UNVERIFIEDのとき、接続確認が失敗した理由(通信層の分類)。 */
      mercariCode?: MercariErrorCode;
    }
  | {
      success: false;
      status: "NOT_SAVED";
      errorCode: MercariActionErrorCode;
      message: string;
      /** 時間をおいて同じ操作を再試行する意味があるか。 */
      retryable: boolean;
      checkedAt: string;
      mercariCode?: MercariErrorCode;
    };

/** 後方互換のためのエイリアス — 既存の呼び出し側が参照している型名。success/messageは新しい結果型にもそのまま存在する。 */
export type MercariTokenActionResult = MercariConnectionActionResult;

function nowIso(): string {
  return new Date().toISOString();
}

function fail(
  errorCode: MercariActionErrorCode,
  message: string,
  opts: { retryable?: boolean; mercariCode?: MercariErrorCode } = {},
): MercariConnectionActionResult {
  return {
    success: false,
    status: "NOT_SAVED",
    errorCode,
    message,
    retryable: opts.retryable ?? false,
    checkedAt: nowIso(),
    mercariCode: opts.mercariCode,
  };
}

async function isAdmin(): Promise<boolean> {
  const role = await getInventoryRole();
  return role === "ADMIN";
}

export async function setMercariConnectionAction(params: {
  token: string;
  clientName: string;
  clientVersion?: string;
}): Promise<MercariConnectionActionResult> {
  try {
    if (!(await isAdmin())) {
      return fail("FORBIDDEN", "この操作にはADMIN権限が必要です。");
    }

    // paramsがundefined/欠損でもTypeErrorで落とさない —— Server Actionの
    // 引数はクライアント由来のシリアライズ値であり、常に期待通りとは限らない。
    const token = typeof params?.token === "string" ? params.token.trim() : "";
    const clientName = typeof params?.clientName === "string" ? params.clientName.trim() : "";
    const clientVersion = typeof params?.clientVersion === "string" ? params.clientVersion.trim() || undefined : undefined;

    if (!token) return fail("TOKEN_NOT_PROVIDED", "Personal API Access Tokenを入力してください。");
    if (!clientName) {
      return fail("CLIENT_NAME_NOT_PROVIDED", "APIクライアント名を入力してください（Mercari Shopsとの契約時に割り当てられた値です）。");
    }

    // 既存設定の状態を先に読む —— 「検証済みの設定を、検証できなかった
    // 新しい入力で上書きしない」(§92)ための判断材料。読めなかった場合は
    // 上書きの可否を判断できないので、安全側に倒して保存しない。
    const existing = await readMercariConnectionSecret();
    if (!existing.ok) {
      return fail("SECRET_READ_FAILED", `現在の設定を確認できないため、保存を中止しました。${existing.errorMessage}`, { retryable: true });
    }
    const hasVerifiedExisting = Boolean(existing.token) && existing.verified;

    const validation = await validateMercariConnection({ token, clientName, clientVersion });

    // 保存可否の判断そのものはlib/listing/mercari/connectionPolicy.tsの
    // 純関数へ委ねる(全分岐をscripts/verify-mercari.tsで固定するため)。
    const decision = decideMercariSave({ validationOk: validation.ok, code: validation.code, hasVerifiedExisting });

    if (!decision.save) {
      if (decision.reason === "TOKEN_REJECTED") {
        return fail("INVALID_TOKEN", `${validation.message} 入力内容は保存していません。`, { mercariCode: validation.code });
      }
      return fail("CONNECTION_UNVERIFIABLE", `${validation.message} 接続確認が取れなかったため、既存の接続済み設定は変更していません。`, {
        retryable: isMercariRetryableForUser(validation.code),
        mercariCode: validation.code,
      });
    }

    try {
      await setMercariConnectionInSecretsManager({
        token,
        clientName,
        clientVersion,
        verified: decision.verified,
        lastCheckCode: decision.verified ? "OK" : (validation.code ?? "UNKNOWN"),
      });
    } catch (err) {
      return fail("SECRET_WRITE_FAILED", err instanceof Error ? err.message : "設定の保存に失敗しました。", { retryable: true });
    }
    revalidatePath("/inventory/settings");

    if (decision.verified) {
      return { success: true, status: "CONNECTED", message: "Mercari Shops API接続設定を保存しました（接続確認済み）。", checkedAt: nowIso() };
    }
    return {
      success: true,
      status: "SAVED_UNVERIFIED",
      message: `入力内容を保存しました。ただし接続確認は取れていません: ${validation.message} 原因が解消したら「接続確認」を実行してください。`,
      checkedAt: nowIso(),
      mercariCode: validation.code,
    };
  } catch (err) {
    // 想定外の例外も戻り値へ畳む —— 呼び出し側が例外経路を別に扱わずに済むようにする。
    console.error("[setMercariConnectionAction] unexpected error:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return fail("UNKNOWN", "設定の保存中に予期しないエラーが発生しました。時間をおいて再試行してください。", { retryable: true });
  }
}

/**
 * 保存済みの設定で接続確認だけを行う(新しいTOKENの入力も保存もしない)。
 * IP登録が完了した後、TOKENを入力し直さずに「今つながるか」を確かめるための操作。
 * 成功したらverifiedフラグを立て直す。
 */
export async function checkMercariConnectionAction(): Promise<MercariConnectionActionResult> {
  try {
    if (!(await isAdmin())) {
      return fail("FORBIDDEN", "この操作にはADMIN権限が必要です。");
    }

    const existing = await readMercariConnectionSecret();
    if (!existing.ok) {
      return fail("SECRET_READ_FAILED", `現在の設定を確認できませんでした。${existing.errorMessage}`, { retryable: true });
    }
    if (!existing.token || !existing.clientName) {
      return fail("TOKEN_NOT_PROVIDED", "接続確認できる設定が保存されていません。先にAPIクライアント名とTOKENを登録してください。");
    }

    const validation = await validateMercariConnection({
      token: existing.token,
      clientName: existing.clientName,
      clientVersion: existing.clientVersion ?? undefined,
    });

    // 確認結果(成否と時刻)を記録する。TOKEN本体は既存の値をそのまま
    // 書き戻すだけで、新しい秘密値がこの経路に現れることはない。
    try {
      await setMercariConnectionInSecretsManager({
        token: existing.token,
        clientName: existing.clientName,
        clientVersion: existing.clientVersion ?? undefined,
        verified: validation.ok,
        lastCheckCode: validation.ok ? "OK" : (validation.code ?? "UNKNOWN"),
      });
    } catch (err) {
      // 確認結果の記録に失敗しても、確認自体の結果は利用者へ返す価値がある。
      console.error("[checkMercariConnectionAction] failed to persist the check result:", err instanceof Error ? err.message : String(err));
    }

    revalidatePath("/inventory/settings");

    if (validation.ok) {
      return { success: true, status: "CONNECTED", message: validation.message, checkedAt: nowIso() };
    }
    return fail(isMercariTokenRejected(validation.code) ? "INVALID_TOKEN" : "CONNECTION_UNVERIFIABLE", validation.message, {
      retryable: isMercariRetryableForUser(validation.code),
      mercariCode: validation.code,
    });
  } catch (err) {
    console.error("[checkMercariConnectionAction] unexpected error:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return fail("UNKNOWN", "接続確認中に予期しないエラーが発生しました。時間をおいて再試行してください。", { retryable: true });
  }
}

export async function deleteMercariTokenAction(): Promise<MercariConnectionActionResult> {
  try {
    if (!(await isAdmin())) {
      return fail("FORBIDDEN", "この操作にはADMIN権限が必要です。");
    }
    try {
      await clearMercariTokenInSecretsManager();
    } catch (err) {
      return fail("SECRET_WRITE_FAILED", err instanceof Error ? err.message : "削除に失敗しました。", { retryable: true });
    }
    revalidatePath("/inventory/settings");
    return { success: true, status: "DELETED", message: "Mercari Shops API接続設定を削除しました。", checkedAt: nowIso() };
  } catch (err) {
    console.error("[deleteMercariTokenAction] unexpected error:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return fail("UNKNOWN", "削除中に予期しないエラーが発生しました。時間をおいて再試行してください。", { retryable: true });
  }
}
