import "server-only";
import { SHOP_ORIGIN, ListingError, type Client, type Remote } from "./workflow";
type Credentials={apiKey:string;sitesServiceToken:string};
export function createIndependentShopClient(credentials: Credentials, request: typeof fetch=fetch): Client {
 async function call(path: string, method="GET",body?:unknown) {
  const blob=body instanceof Blob;
  let response:Response;try{response=await request(SHOP_ORIGIN+"/api/v1/"+path,{method,headers:{Authorization:"Bearer "+credentials.apiKey,"OAI-Sites-Authorization":"Bearer "+credentials.sitesServiceToken,...(body===undefined?{}:{"Content-Type":blob?body.type||"application/octet-stream":"application/json"})},body:body===undefined?undefined:blob?body:JSON.stringify(body),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(25000)})}catch{throw new ListingError("自社サイトと通信できませんでした。保存結果を確認してから再試行してください。")}
  if(response.status===401||response.status===403)throw new ListingError("自社サイトの接続権限・キーの期限を確認してください。");
  if(response.status===409)throw new ListingError("自社サイトの商品が更新されました。最新の内容を確認し直してください。");
  if(!response.ok)throw new ListingError("自社サイトで処理できませんでした。接続状況を確認してください。");
  try{return await response.json()}catch{throw new ListingError("自社サイトの応答を確認できませんでした。")}
 }
 return {
  async find(externalId){const data=await call("products?externalId="+encodeURIComponent(externalId));if(!Array.isArray(data.items)||data.items.length>1)throw new ListingError("商品照合に失敗しました。");const p=data.items[0];if(p&&(p.externalId!==externalId||!p.id||!Number.isInteger(p.revision)))throw new ListingError("自社サイトの商品が一致しません。");return p?{id:String(p.id),revision:p.revision,stock:p.stock,status:p.status,variants:p.variants,name:p.name,price:p.price,images:p.images} as Remote:null;},
  async upload(blob){return (await call("upload","POST",blob)).url;},
  async save(item){const result=await call("integrations/catalog","POST",{items:[item],dryRun:false});const row=result.results?.[0];if(result.failed||!row?.ok||!row.id||!Number.isInteger(row.revision))throw new ListingError(row?.status===409?"商品または在庫が更新されました。確認し直してください。":"商品を保存できませんでした。保存結果を確認してから再試行してください。");return {id:String(row.id),revision:row.revision};}
 };
}
