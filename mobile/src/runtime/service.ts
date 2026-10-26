import type { InventorySearchInput } from "../domain/search";
import { Amplify } from "aws-amplify";
import { Platform } from "react-native";
import { fetchAuthSession, getCurrentUser } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { nativeSessionCookies } from "./sessionCookies";
import { SecureTokenStorage } from "./secureTokenStorage";
import { isInventoryItem } from "../domain/snapshot";
import type { InventoryItem, InventoryOptions, InventoryThumbnail, PendingPhoto, UploadedPhoto } from "../domain/inventory";
import { isMobileFeatures, type MobileFeatures } from "../domain/access";
import type {SalesResponse} from "../ui/SalesScreen";
import { InventoryWriteError, type SaveRequest } from "../domain/editor";
import { InventoryReadError } from "../domain/readError";
import type { DeleteRequest } from "../domain/inventoryActions";
import { readJson, ReadHttpError } from "./readJson";
import {StockSplitError,type StockSplitRequest,type StockSplitResult} from '../../../lib/inventory/stockSplitInput';
import {clearLegacyBrowserCredentials} from '../../../lib/security/browserMigration';
import type {StockSplitSaved} from '../ui/StockSplitScreen';
import {MobileSoldOutError,type SoldOutSaved} from '../ui/SoldOutScreen';
import type {SoldOutRequest,SoldOutResult} from '../../../lib/inventory/soldOutInput';

const isWeb = Platform.OS === "web";
// The web app is served by BELLO itself and uses its existing authenticated session.
export const API_ORIGIN = isWeb && typeof window !== "undefined" ? window.location.origin : "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
interface MobileConfig { auth: { userPoolId: string; userPoolClientId: string }; contractVersion: number; writesEnabled: boolean; deviceSecurity?: boolean }
export interface InventoryResponse { owner: string; role: "ADMIN" | "EDITOR" | "VIEWER"; items: InventoryItem[]; imagesDeferred?: boolean; hasMore: boolean; nextOffset?: number; total?: number | null; totalQuantity?: number | null; fetchedAt: string }
export interface MobileSession { owner: string; role: "ADMIN" | "EDITOR" | "VIEWER"; features: MobileFeatures }
const configKey = `bello.mobile-config.${API_ORIGIN}`;
const secureTokens = new SecureTokenStorage();
let configured: MobileConfig | null = null;
let approvedOwner: string | null = null;
export class StaffSessionError extends Error {}

async function jsonRequest(path: string, cookie?: string, retry = false): Promise<unknown> {
  try {
    return await readJson(`${API_ORIGIN}${path}`, {
      headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      credentials: "same-origin", redirect: "error",
    }, { retry });
  } catch (error) {
    if (error instanceof ReadHttpError) {
      if (error.status === 401 || error.status === 403) throw new StaffSessionError(error.status === 401 ? "ログインが必要です。" : "スタッフ用アプリの利用権限がありません。");
      throw new InventoryReadError(error.status === 404 ? "not_found" : "unavailable");
    }
    throw error;
  }
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
  if (candidate.deviceSecurity) {
    if (!isWeb) throw new Error("承認済みブラウザーからWebアプリを開いてください。");
    clearLegacyBrowserCredentials();
    const prefix=`bello.inventory.v1.${encodeURIComponent(API_ORIGIN)}.`;
    const oldSnapshots=(await AsyncStorage.getAllKeys()).filter(key=>key.startsWith(prefix));
    if(oldSnapshots.length)await AsyncStorage.multiRemove(oldSnapshots);
    return;
  }
  Amplify.configure({ Auth: { Cognito: candidate.auth } }, { ssr: isWeb });
  if (!isWeb) cognitoUserPoolsTokenProvider.setKeyValueStorage(secureTokens);
}

async function authenticatedSession() {
  if (!configured) throw new Error("ログインが必要です。");
  if (configured.deviceSecurity) {
    if(approvedOwner)return {cookie:undefined,owner:approvedOwner};
    const session = await jsonRequest("/api/mobile/session") as MobileSession;
    if (!session?.owner || !["ADMIN","EDITOR","VIEWER"].includes(session.role)) throw new StaffSessionError("ログインが必要です。");
    approvedOwner=session.owner;return {cookie:undefined,owner:session.owner};
  }
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
  if (configured?.deviceSecurity) {
    const value = await jsonRequest("/api/mobile/session") as MobileSession;
    if (!value?.owner || !["ADMIN","EDITOR","VIEWER"].includes(value.role) || !isMobileFeatures(value.features)) throw new StaffSessionError("利用権限を確認できませんでした。");
    approvedOwner=value.owner;
    return value;
  }
  const session = await authenticatedSession();
  const value = await jsonRequest("/api/mobile/session", session.cookie) as MobileSession | null;
  if (!value || value.owner !== session.owner || !["ADMIN", "EDITOR", "VIEWER"].includes(value.role) || !isMobileFeatures(value.features)) {
    throw new Error("アカウントの利用権限を確認できませんでした。");
  }
  return { owner: value.owner, role: value.role, features: { ecListing: value.features.ecListing, sales: value.features.sales } };
}

function inventoryParams(input: InventorySearchInput): URLSearchParams {
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q);
  if (input.category) params.set("category", input.category);
  if (input.offset) params.set("offset", String(input.offset));
  if (input.advanced?.conditions.length) params.set("advanced",JSON.stringify(input.advanced));
  if (input.sort) params.set("sort",JSON.stringify(input.sort));
  return params;
}

export async function readInventory(input: InventorySearchInput = {}): Promise<InventoryResponse> {
  const session = await authenticatedSession();
  const params = inventoryParams(input);
  params.set("images", "deferred");
  const value = await jsonRequest(`/api/mobile/inventory?${params}`, session.cookie, true) as InventoryResponse;
  if (value.owner !== session.owner || !["ADMIN", "EDITOR", "VIEWER"].includes(value.role) || !Array.isArray(value.items) || !value.items.every(isInventoryItem)) {
    throw new Error("在庫データを確認できませんでした。");
  }
  return value;
}

export async function readInventoryThumbnails(ids: string[]): Promise<InventoryThumbnail[]> {
  if (!ids.length) return [];
  const session = await authenticatedSession();
  const params = new URLSearchParams({ images: "only", ids: ids.join(",") });
  const value = await jsonRequest(`/api/mobile/inventory?${params}`, session.cookie, true) as { owner?: string; items?: InventoryThumbnail[] };
  if (value?.owner !== session.owner || !Array.isArray(value.items) || !value.items.every(item =>
    typeof item?.id === "string" && typeof item.updatedAt === "string" &&
    (item.thumbnailUrl === null || (typeof item.thumbnailUrl === "string" && item.thumbnailUrl.startsWith("https://"))))) {
    throw new Error("商品画像を確認できませんでした。");
  }
  return value.items;
}

export async function clearLocalSession(): Promise<void> { approvedOwner=null; if (!isWeb) await secureTokens.clear(); }

export function mobileWritesEnabled(): boolean { return configured?.writesEnabled === true; }
export function mobileDeviceSecurityEnabled(): boolean { return configured?.deviceSecurity === true; }

export async function sellInventory(request:SoldOutRequest):Promise<SoldOutSaved> {
  if(!mobileWritesEnabled())throw new MobileSoldOutError('FORBIDDEN','在庫を編集する権限がありません。');
  const session=await authenticatedSession();
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),60000);
  try {
    const response=await fetch(`${API_ORIGIN}/api/mobile/inventory/${encodeURIComponent(request.inventoryId)}/sold-out`,{method:'POST',credentials:'same-origin',redirect:'error',signal:controller.signal,headers:{Accept:'application/json','Content-Type':'application/json','X-Bello-Mobile':'1',...(session.cookie?{Cookie:session.cookie}:{})},body:JSON.stringify(request)});
    const value=await response.json() as {ok?:boolean;code?:string;error?:string;owner?:string;mutationId?:string;result?:SoldOutResult};
    if(!response.ok||!value.ok)throw new MobileSoldOutError(value.code??(response.status===403?'FORBIDDEN':'UNCONFIRMED'),value.error??'登録結果を確認できません。同じ内容で再確認してください。');
    if(value.owner!==session.owner||value.mutationId!==request.mutationId||value.result?.sourceId!==request.inventoryId)throw Error('登録結果を確認できません。');
    const sold=await readInventoryDetail(value.result.soldId);
    const source=sold.id===request.inventoryId?sold:await readInventoryDetail(request.inventoryId);
    return {sold,source};
  }catch(error){throw error instanceof MobileSoldOutError?error:new MobileSoldOutError('UNCONFIRMED','登録結果を確認できません。同じ内容で「登録結果を再確認」を押してください。');}
  finally{clearTimeout(timeout);}
}

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
      method: request.create ? "POST" : "PATCH", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Bello-Mobile": "1", ...(session.cookie ? { Cookie: session.cookie } : {}) },
      body: JSON.stringify(request), signal: controller.signal, redirect: "error",
    });
    if (response.status === 401) throw new InventoryWriteError("unauthorized");
    if (response.status === 403) throw new InventoryWriteError("forbidden");
    if (response.status === 409) throw new InventoryWriteError("conflict");
    if (response.status === 422) {
      const failure=await response.json();
      if(failure.error==='BARCODE_INVALID') throw new InventoryWriteError('barcodeInvalid');
      if(failure.error==='OUTBOUND_RESERVED') throw new InventoryWriteError('outboundReserved');
      if(failure.error==='CATEGORY_INVALID') throw new InventoryWriteError('categoryInvalid');
    }
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

export async function removeInventory(request: DeleteRequest): Promise<void> {
  if (!mobileWritesEnabled()) throw new InventoryWriteError("forbidden");
  let session: Awaited<ReturnType<typeof authenticatedSession>>;
  try { session = await authenticatedSession(); } catch { throw new InventoryWriteError("unauthorized"); }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${API_ORIGIN}/api/mobile/inventory/${encodeURIComponent(request.id)}`, {
      method: "DELETE", credentials: "same-origin", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Bello-Mobile": "1", ...(session.cookie ? { Cookie: session.cookie } : {}) }, body: JSON.stringify(request),
    });
    if (response.status === 401) throw new InventoryWriteError("unauthorized");
    if (response.status === 403) throw new InventoryWriteError("forbidden");
    if (response.status === 409) throw new InventoryWriteError("conflict");
    if (!response.ok) throw new InventoryWriteError("uncertain");
    const value = await response.json();
    if (value.owner !== session.owner || value.deletedId !== request.id) throw new InventoryWriteError("uncertain");
  } catch (error) { throw error instanceof InventoryWriteError ? error : new InventoryWriteError("uncertain"); }
  finally { clearTimeout(timeout); }
}

export async function readInventoryOptions(): Promise<InventoryOptions> {
  const session=await authenticatedSession();
  const value=await jsonRequest("/api/mobile/options",session.cookie) as InventoryOptions & {owner:string};
  if(value.owner!==session.owner||!Array.isArray(value.categories)||!Array.isArray(value.locations)||!Array.isArray(value.statuses)) throw new Error("選択肢を取得できませんでした。");
  return value;
}
export async function uploadInventoryPhoto(photo:PendingPhoto):Promise<UploadedPhoto> {
  if(!mobileWritesEnabled())throw new InventoryWriteError("forbidden");
  const session=await authenticatedSession(); const blob=await (await fetch(photo.uri)).blob();
  if(blob.size>3*1024*1024)throw new Error("写真が大きすぎます。");
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),60000);
  try {
    const response=await fetch(API_ORIGIN+"/api/mobile/images",{method:"POST",credentials:"same-origin",redirect:"error",signal:controller.signal,
      headers:{"Content-Type":"image/jpeg","X-Bello-Mobile":"1","X-Photo-Id":photo.id,...(session.cookie?{Cookie:session.cookie}:{})},body:blob});
    if(!response.ok)throw new Error("写真を保存できませんでした。");
    const value=await response.json();
    if(value.owner!==session.owner||typeof value.storageKey!=="string")throw new Error("写真を確認できませんでした。");
    return {storageKey:value.storageKey,type:photo.type};
  } finally {clearTimeout(timeout);}
}
export async function readSales(year:number,month:number,items=false):Promise<SalesResponse> {
  const session=await authenticatedSession();
  const value=await jsonRequest('/api/mobile/sales?y='+year+'&m='+month+(items?'&items=1':''),session.cookie) as SalesResponse & {owner:string};
  if(value.owner!==session.owner)throw new Error("売上を取得できませんでした。");
  return value;
}

export async function removeInventoryPhotoAsset(id:string,photoId:string):Promise<void>{
 if(!mobileWritesEnabled())throw new Error('写真を削除する権限がありません。');
 const session=await authenticatedSession();const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20000);
 try{const response=await fetch(API_ORIGIN+'/api/mobile/inventory/'+encodeURIComponent(id)+'/photos/'+encodeURIComponent(photoId),{method:'DELETE',credentials:'same-origin',redirect:'error',signal:controller.signal,headers:{'X-Bello-Mobile':'1',...(session.cookie?{Cookie:session.cookie}:{})}});
 const result=await response.json();if(!response.ok)throw new Error(result.message||'写真を削除できませんでした。ログインと通信を確認してください。');
 if(result.owner!==session.owner||result.deletedId!==photoId)throw new Error('削除結果を確認できません。詳細を開き直してください。');
 }finally{clearTimeout(timeout);}
}

export async function checkSplitBarcode(barcode:string,excludeId:string):Promise<number>{
 const page=await readInventory({advanced:{combinator:'AND',conditions:[{id:'split-barcode',field:'barcode',operator:'equals',value:barcode}]}});
 return Math.max(0,(page.total??page.items.length)-(page.items.some(i=>i.id===excludeId)?1:0));
}
export async function splitInventory(request:StockSplitRequest):Promise<StockSplitSaved>{
 if(!mobileWritesEnabled())throw new StockSplitError('FORBIDDEN','在庫を分ける権限がありません。');
 const session=await authenticatedSession(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
 try{
  const response=await fetch(API_ORIGIN+'/api/mobile/inventory/'+encodeURIComponent(request.inventoryId)+'/split',{method:'POST',credentials:'same-origin',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json','X-Bello-Mobile':'1',...(session.cookie?{Cookie:session.cookie}:{})},body:JSON.stringify(request)});
  const value=await response.json() as {ok?:boolean;code?:StockSplitError['code'];error?:string;owner?:string;mutationId?:string;result?:StockSplitResult};
  if(!response.ok||!value.ok)throw new StockSplitError(value.code??'UNCONFIRMED',value.error??'保存結果を確認できません。');
  if(value.owner!==session.owner||value.mutationId!==request.mutationId||value.result?.sourceId!==request.inventoryId)throw Error('保存結果を確認できません。');
  const [source,split]=await Promise.all([readInventoryDetail(value.result.sourceId),readInventoryDetail(value.result.splitId)]);
  return {source,split};
 }catch(e){throw e instanceof StockSplitError?e:new StockSplitError('UNCONFIRMED','保存結果を確認できません。同じ内容で結果を再確認してください。');}
 finally{clearTimeout(timer);}
}
