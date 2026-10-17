import { Amplify } from "aws-amplify";
import { Platform } from "react-native";
import { fetchAuthSession, getCurrentUser } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { nativeSessionCookies } from "./sessionCookies";
import { SecureTokenStorage } from "./secureTokenStorage";
import { isInventoryItem } from "../domain/snapshot";
import type { InventoryItem } from "../domain/inventory";
import { isMobileFeatures, type MobileFeatures } from "../domain/access";
import { InventoryWriteError, type SaveRequest } from "../domain/editor";

const isWeb = Platform.OS === "web";
// The web app is served by BELLO itself and uses its existing authenticated session.
export const API_ORIGIN = isWeb && typeof window !== "undefined" ? window.location.origin : "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
interface MobileConfig { auth: { userPoolId: string; userPoolClientId: string }; contractVersion: number; writesEnabled: boolean }
export interface InventoryResponse { owner: string; role: "ADMIN" | "EDITOR" | "VIEWER"; items: InventoryItem[]; hasMore: boolean; fetchedAt: string }
export interface MobileSession { owner: string; role: "ADMIN" | "EDITOR" | "VIEWER"; features: MobileFeatures }
const configKey = `bello.mobile-config.${API_ORIGIN}`;
const secureTokens = new SecureTokenStorage();
let configured: MobileConfig | null = null;
export class StaffSessionError extends Error {}

async function jsonRequest(path: string, cookie?: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      credentials: "same-origin",
      signal: controller.signal, redirect: "error",
    });
    if (response.status === 401 || response.status === 403) throw new StaffSessionError(response.status === 401 ? "ログインが必要です。" : "スタッフ用アプリの利用権限がありません。");
    if (!response.ok) throw new Error("在庫サービスに接続できませんでした。");
    return await response.json();
  } finally { clearTimeout(timeout); }
}

function isConfig(raw: unknown): raw is MobileConfig {
  const value = raw as MobileConfig | null;
  return value?.contractVersion === 1 && typeof value.auth?.userPoolId === "string" &&
    typeof value.auth?.userPoolClientId === "string" && typeof value.writesEnabled === "boolean";
}

export async function configureMobileAuth(online: boolean): Promise<void> {
  let candidate: unknown;
  if (online) {
    candidate = await jsonRequest("/api/mobile/config");
    if (!isConfig(candidate)) throw new Error("アプリの接続設定を取得できませんでした。");
    await AsyncStorage.setItem(configKey, JSON.stringify(candidate));
  } else {
    const cached = await AsyncStorage.getItem(configKey);
    candidate = cached ? JSON.parse(cached) : null;
  }
  if (!isConfig(candidate)) throw new Error("【圏外です】初回は通信できる場所でログインしてください。");
  configured = candidate;
  Amplify.configure({ Auth: { Cognito: candidate.auth } }, { ssr: isWeb });
  if (!isWeb) cognitoUserPoolsTokenProvider.setKeyValueStorage(secureTokens);
}

async function authenticatedSession() {
  if (!configured) throw new Error("ログインが必要です。");
  const [session, user] = await Promise.all([fetchAuthSession(), getCurrentUser()]);
  const accessToken = session.tokens?.accessToken;
  const idToken = session.tokens?.idToken;
  if (!accessToken || !idToken) throw new Error("ログインが必要です。");
  const username = accessToken.payload.username;
  if (typeof username !== "string") throw new Error("ログインが必要です。");
  const cookie = isWeb ? undefined : nativeSessionCookies({ clientId: configured.auth.userPoolClientId, username, accessToken: accessToken.toString(), idToken: idToken.toString() });
  return { cookie, owner: user.userId };
}

export async function readMobileSession(): Promise<MobileSession> {
  const session = await authenticatedSession();
  const value = await jsonRequest("/api/mobile/session", session.cookie) as MobileSession | null;
  if (!value || value.owner !== session.owner || !["ADMIN", "EDITOR", "VIEWER"].includes(value.role) || !isMobileFeatures(value.features)) {
    throw new Error("アカウントの利用権限を確認できませんでした。");
  }
  return { owner: value.owner, role: value.role, features: { ecListing: value.features.ecListing, sales: value.features.sales } };
}

export async function readInventory(input: { q?: string; category?: string; offset?: number } = {}): Promise<InventoryResponse> {
  const session = await authenticatedSession();
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q);
  if (input.category) params.set("category", input.category);
  if (input.offset) params.set("offset", String(input.offset));
  const value = await jsonRequest(`/api/mobile/inventory?${params}`, session.cookie) as InventoryResponse;
  if (value.owner !== session.owner || !["ADMIN", "EDITOR", "VIEWER"].includes(value.role) || !Array.isArray(value.items) || !value.items.every(isInventoryItem)) {
    throw new Error("在庫データを確認できませんでした。");
  }
  return value;
}

export async function clearLocalSession(): Promise<void> { if (!isWeb) await secureTokens.clear(); }

export function mobileWritesEnabled(): boolean { return configured?.writesEnabled === true; }

/** Explicit user save only. A timeout is uncertain and keeps the same mutation ID for reconciliation. */
export async function saveInventory(request: SaveRequest): Promise<InventoryItem> {
  if (!mobileWritesEnabled()) throw new InventoryWriteError("forbidden");
  let session: Awaited<ReturnType<typeof authenticatedSession>>;
  try { session = await authenticatedSession(); }
  catch { throw new InventoryWriteError("unauthorized"); }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${API_ORIGIN}/api/mobile/inventory/${encodeURIComponent(request.id)}`, {
      method: "PATCH", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Bello-Mobile": "1", ...(session.cookie ? { Cookie: session.cookie } : {}) },
      body: JSON.stringify(request), signal: controller.signal, redirect: "error",
    });
    if (response.status === 401) throw new InventoryWriteError("unauthorized");
    if (response.status === 403) throw new InventoryWriteError("forbidden");
    if (response.status === 409) throw new InventoryWriteError("conflict");
    if (response.status >= 400 && response.status < 500) throw new InventoryWriteError("server");
    if (!response.ok) throw new InventoryWriteError("uncertain");
    const value = await response.json();
    if (value?.owner !== session.owner || value?.mutationId !== request.mutationId || !isInventoryItem(value.item) ||
        value.item.id !== request.id || !value.item.detailLoadedAt) throw new InventoryWriteError("uncertain");
    return value.item;
  } catch (error) { throw error instanceof InventoryWriteError ? error : new InventoryWriteError("uncertain"); }
  finally { clearTimeout(timeout); }
}

export async function readInventoryDetail(id: string): Promise<InventoryItem> {
  const session = await authenticatedSession();
  const value = await jsonRequest(`/api/mobile/inventory/${encodeURIComponent(id)}`, session.cookie) as { owner?: string; item?: unknown } | null;
  if (!value || value.owner !== session.owner || !isInventoryItem(value.item) || value.item.id !== id || !value.item.detailLoadedAt) {
    throw new Error("商品詳細を確認できませんでした。");
  }
  return value.item;
}
