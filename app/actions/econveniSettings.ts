"use server";

import { getCurrentInventoryUserSub, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { econveniCredentialStore, EconveniInputError, type EconveniCredentialsState } from "@/lib/listing/econveni/credentials";
import { EconveniHttpError, EconveniHttpSession } from "@/lib/listing/econveni/httpSession";
import {econveniStore} from '@/lib/listing/econveni/runtimeStore';

type Result = { ok: true; state: EconveniCredentialsState; message?: string } | { ok: false; message: string };
const denied = { ok: false as const, message: "管理者アカウントでログインしてください。" };
const unavailable = { ok: false as const, message: "接続設定を確認できませんでした。時間をおいて再度お試しください。" };

export async function getEconveniSettingsAction(): Promise<Result> {
  try {
    if (await getInventoryRole() !== "ADMIN") return denied;
    return { ok: true, state: await econveniCredentialStore.state() };
  } catch { return unavailable; }
}

export async function saveEconveniSettingsAction(input: { loginId: string; password: string }): Promise<Result> {
  try {
    if (await getInventoryRole() !== "ADMIN") return denied;
    const actor = await getCurrentInventoryUserSub();
    if (!actor) return denied;
    const state = await econveniCredentialStore.save(input, actor);
    return { ok: true, state, message: "ログイン情報を保存しました。eコンビニへの接続確認はまだ完了していません。" };
  } catch (error) {
    return error instanceof EconveniInputError ? { ok: false, message: error.message } : unavailable;
  }
}

export async function checkEconveniConnectionAction(): Promise<{ ok: true; checkedAt: string; message: string } | { ok: false; message: string }> {
  const store=econveniStore('account-connection-check'),session=new EconveniHttpSession();let locked=false;
  try {
    if (await getInventoryRole() !== "ADMIN" || !await getCurrentInventoryUserSub()) return denied;
    await store.acquire(true);locked=true;
    const credentials = await econveniCredentialStore.credentials();
    if (!credentials) return { ok: false, message: "先にログイン情報を保存してください。" };
    await session.login(credentials);
    await session.registrationForm();
    await store.resumeAfterVerifiedLogin();
    return { ok: true, checkedAt: new Date().toISOString(), message: "eコンビニへのログインと商品登録画面の読み取りに成功しました。" };
  } catch (error) {
    const messages: Partial<Record<EconveniHttpError["code"], string>> = {
      AUTH_REQUIRED: "eコンビニにログインできませんでした。保存したログイン情報を確認してください。",
      ACCESS_DENIED: "eコンビニ側で接続が拒否されました。繰り返し接続せず、eコンビニの画面を確認してください。",
      ADDITIONAL_AUTH: "eコンビニで追加の認証が必要です。eコンビニの画面で確認してください。",
      CONTRACT_CHANGED: "eコンビニの画面形式が想定と異なります。接続処理を停止しました。",
    };
    return { ok: false, message: error instanceof EconveniHttpError ? messages[error.code] ?? "接続を確認できませんでした。時間をおいて再度お試しください。" : unavailable.message };
  }finally{session.dispose();if(locked)await store.release();}
}
