"use server";

import { getCurrentInventoryUserSub, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { econveniCredentialStore, EconveniInputError, type EconveniCredentialsState } from "@/lib/listing/econveni/credentials";

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
