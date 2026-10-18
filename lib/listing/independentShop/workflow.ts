import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export const SHOP_ORIGIN = "https://bello-interior-independent.misty-loom-0065.chatgpt.site";
export class ListingError extends Error {}
export type ImageRef = { storageKey: string; source?: "INVENTORY" | "PHOTO_ASSET"; photoAssetId?: string; sortOrder: number };
export type Source = { id: string; name: string; sku: string; price: number; description: string; quantity: number; version: string; images: ImageRef[]; categories?:string[] };
export type Remote = { id: string; revision: number; stock: number; status: string; variants?: unknown[]; name?: string; price?: number; images?: string[] };
export type PublicationPreview = { remote: Remote | null; target: "published" | "draft"; token: string | null };
export type Preview = { name: string; description: string; price: number; stock: number; sourceStock: number; imageCount: number; connected: boolean; remote: Remote | null; token: string | null };
export type Receipt = { index: number; url: string; signature: string };
export type Client = { find: (id: string) => Promise<Remote | null>; upload: (blob: Blob) => Promise<string>; save: (item: Record<string, unknown>) => Promise<{ id: string; revision: number }> };
export type Ports = { role: () => Promise<string | null>; source: (id: string) => Promise<Source>; client: () => Promise<{ api: Client; signingKey: string } | null>; image: (image: ImageRef) => Promise<Blob>; now?: () => number };
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sign = (key: string, value: string) => createHmac("sha256", key).update(value).digest("base64url");
function equal(a: string, b: string) { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
export function validateSource(s: Source, stock: number) {
 if(!s || !s.id || !s.name.trim() || s.name.length>500 || !Number.isSafeInteger(s.price) || s.price<1 || s.price>999999999)throw new ListingError("保存済みの商品名・販売予定価格を確認してください。");
 if(!Number.isSafeInteger(s.quantity)||s.quantity<0||!Number.isSafeInteger(stock)||stock<0||stock>s.quantity||stock>999999)throw new ListingError("販売に割り当てる在庫は0〜現在庫の整数で入力してください。");
 if(s.description.length>50000 || s.sku.length>100)throw new ListingError("商品説明またはSKUが長すぎます。");
 if(!s.images.length||s.images.length>30||s.images.some(i=>!i.storageKey)||new Set(s.images.map(i=>(i.source||"INVENTORY")+":"+i.storageKey)).size!==s.images.length)throw new ListingError("保存済みの出品画像を1〜30枚選択してください。");
}
function proof(s: Source, stock: number, remote: Remote | null) {
 return digest({source:s,stock,remote:remote?{id:remote.id,revision:remote.revision}:null});
}
export function createListingWorkflow(ports: Ports) {
 const now=ports.now||Date.now;
 async function context(id: string, stock: number) {
  const role=await ports.role();if(role!=="ADMIN"&&role!=="EDITOR")throw new ListingError("出品操作には管理者または編集者のログインが必要です。");
  if(typeof id!=="string"||!id||id.length>200)throw new ListingError("商品IDを確認してください。");
  const source=await ports.source(id);if(source.id!==id)throw new ListingError("商品IDが一致しません。");validateSource(source,stock);
  const connection=await ports.client(),remote=connection?await connection.api.find("inventory:"+id):null;
  if(remote?.variants?.length)throw new ListingError("種類別在庫がある商品はBELLO管理画面で更新してください。");
  return {source,connection,remote};
 }
 function verify(token: string, key: string, fingerprint: string) {
  if(typeof token!=="string"||token.length>2000)throw new ListingError("取り込み前の確認をやり直してください。");
  const [payload,signature]=token.split(".");
  if(!payload||!signature||!equal(signature,sign(key,payload)))throw new ListingError("取り込み前の確認をやり直してください。");
  let value;try{value=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"))}catch{throw new ListingError("確認データを読み取れません。")}
  if(!Number.isFinite(value.expires)||value.expires<now()||value.expires>now()+16*60*1000)throw new ListingError("確認の有効期限が切れました。もう一度確認してください。");
  if(value.fingerprint!==fingerprint)throw new ListingError("商品・画像・在庫が更新されています。最新の内容を確認し直してください。");
 }
 async function verified(id: string,stock: number,token: string) {
  const ctx=await context(id,stock);if(!ctx.connection)throw new ListingError("BELLO自社サイトの接続情報が未設定です。");
  verify(token,ctx.connection.signingKey,proof(ctx.source,stock,ctx.remote));
  return {...ctx,connection:ctx.connection};
 }
 async function publicationContext(id: string) {
  const role=await ports.role();if(role!=="ADMIN"&&role!=="EDITOR")throw new ListingError("出品操作には管理者または編集者のログインが必要です。");
  if(typeof id!=="string"||!id||id.length>200)throw new ListingError("商品IDを確認してください。");
  const connection=await ports.client();if(!connection)throw new ListingError("BELLO自社サイトの接続情報が未設定です。");
  const remote=await connection.api.find("inventory:"+id);
  const target=remote?.status==="published"?"draft" as const:"published" as const;
  let version:string|null=null;
  // Stopping must remain possible even if the inventory or draft is no longer valid.
  if(remote&&target==="published") {
   if(remote.status!=="draft")throw new ListingError("自社サイトの商品状態を確認してください。");
   const source=await ports.source(id);if(source.id!==id)throw new ListingError("商品IDが一致しません。");
   validateSource(source,remote.stock);
   if(remote.stock<1||remote.variants?.length||!remote.name?.trim()||!Number.isSafeInteger(remote.price)||remote.price!<1||!remote.images?.length)throw new ListingError("自社サイトの下書きに商品名・価格・画像・販売可能数が揃っているか確認してください。");
   version=source.version;
  }
  return {connection,remote,target,fingerprint:digest({action:"publication",id,target,remote,version})};
 }
 return {
  async publicationPreview(id:string):Promise<PublicationPreview>{
   const {connection,remote,target,fingerprint}=await publicationContext(id);
   const payload=Buffer.from(JSON.stringify({fingerprint,expires:now()+15*60*1000})).toString("base64url");
   return {remote,target,token:remote?payload+"."+sign(connection.signingKey,payload):null};
  },
  async changePublication(id:string,token:string){
   const {connection,remote,target,fingerprint}=await publicationContext(id);
   if(!remote)throw new ListingError("自社サイトに下書きを保存してから出品してください。");
   verify(token,connection.signingKey,fingerprint);
   await connection.api.save({externalId:"inventory:"+id,revision:remote.revision,status:target});
   const confirmed=await connection.api.find("inventory:"+id);
   if(!confirmed||confirmed.id!==remote.id||confirmed.status!==target)throw new ListingError("出品状態を確認できませんでした。「出品状態を確認」で結果を確認してください。");
   return {id:confirmed.id,status:confirmed.status};
  },
  async preview(id: string, stock: number): Promise<Preview> {
   const {source,connection,remote}=await context(id,stock);
   const payload=Buffer.from(JSON.stringify({fingerprint:proof(source,stock,remote),expires:now()+15*60*1000})).toString("base64url");
   return {name:source.name,description:source.description,price:source.price,stock,sourceStock:source.quantity,imageCount:source.images.length,connected:!!connection,remote,token:connection?payload+"."+sign(connection.signingKey,payload):null};
  },
  async upload(id: string,stock: number,token: string,index: number): Promise<Receipt> {
   const {source,connection}=await verified(id,stock,token);
   if(!Number.isInteger(index)||index<0||index>=source.images.length)throw new ListingError("画像の順序を確認してください。");
   const blob=await ports.image(source.images[index]);
   if(!blob.size||blob.size>10000000)throw new ListingError("画像は1枚10MB以内にしてください。");
   const url=await connection.api.upload(blob);
   if(!/^\/media\/[a-f0-9-]+\.(jpg|png|webp)$/.test(url))throw new ListingError("画像の保存結果を確認できません。");
   return {index,url,signature:sign(connection.signingKey,JSON.stringify([token,index,url]))};
  },
  async commit(id: string,stock: number,token: string,receipts: Receipt[]) {
   const {source,connection,remote}=await verified(id,stock,token);
   if(!Array.isArray(receipts)||receipts.length!==source.images.length)throw new ListingError("画像の転送が完了していません。");
   const images=receipts.map((r,index)=>{if(!r||r.index!==index||typeof r.url!=="string"||typeof r.signature!=="string"||!equal(r.signature,sign(connection.signingKey,JSON.stringify([token,index,r.url]))))throw new ListingError("画像の転送結果が一致しません。確認からやり直してください。");return r.url});
   // Explicit fields only: no supplier, acquisition cost, customer, or arbitrary notes.
   const item={externalId:"inventory:"+source.id,name:source.name,description:source.description,basePrice:source.price,sku:source.sku,stock,status:"draft",images,...(source.categories?{categories:source.categories}:{}),...(remote?{revision:remote.revision}:{})};
   return connection.api.save(item);
  }
 };
}
