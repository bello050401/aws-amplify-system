"use client";
import * as legacy from "aws-amplify/storage";
const enabled = () => process.env.BELLO_DEVICE_SECURITY === "enforced";
const address = (path: string) => new URL("/api/inventory/storage?path=" + encodeURIComponent(path), window.location.origin);
export const getUrl: typeof legacy.getUrl = ((input: { path: string }) => enabled()
  ? Promise.resolve({ url: address(input.path), expiresAt: new Date(Date.now() + 60000) }) : legacy.getUrl(input)) as typeof legacy.getUrl;
export const uploadData: typeof legacy.uploadData = ((input: { path: string; data: Blob; options?: {contentType?:string} }) => {
  if (!enabled()) return legacy.uploadData(input);
  const controller = new AbortController();
  const result = fetch(address(input.path), { method: "PUT", credentials: "same-origin", cache: "no-store", redirect: "error",
    body: input.data, signal: controller.signal, headers: { "content-type": input.options?.contentType || input.data.type || "application/octet-stream" } }).then(async r => {
    if (!r.ok) throw new Error("画像を保存できませんでした。端末の承認と接続状況を確認してください。");
    return { path: input.path };
  });
  return { result, cancel: () => controller.abort(), pause: () => {}, resume: () => {}, state: "IN_PROGRESS" };
}) as typeof legacy.uploadData;
export const remove: typeof legacy.remove = ((input: {path:string}) => enabled()
  ? fetch(address(input.path), {method:"DELETE",credentials:"same-origin",cache:"no-store",redirect:"error"}).then(r=>{
    if(!r.ok)throw new Error("未保存画像を削除できませんでした。");return {path:input.path};
  }) : legacy.remove(input)) as typeof legacy.remove;
