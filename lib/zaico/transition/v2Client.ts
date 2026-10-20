import type {ZaicoInventory} from '../client';

export interface V2Inventory extends Omit<ZaicoInventory,'optional_attributes'> {
  deleted:boolean;
  optional_attributes:Record<string,string|null>|null;
}
export class ZaicoHttpError extends Error{
  constructor(public status:number,public retryAfterMs:number,public outcomeUnknown=false){
    super(`ZAICO API: HTTP ${status}${outcomeUnknown?'（更新結果未確認）':''}`);
  }
}
export interface V2ClientOptions{
  companyId:number;
  token:()=>Promise<string>;
  /** Renew/check the one server lease and disabled flag before EVERY request, including retries. */
  beforeRequest:(method:'GET'|'PUT'|'PATCH'|'POST'|'DELETE')=>Promise<void>;
  fetch?:typeof fetch;
  sleep?:(ms:number)=>Promise<void>;
  now?:()=>number;
}
export function toLegacyInventory(row:V2Inventory):ZaicoInventory{
  if(row.deleted!==false)throw Error('削除済み、または削除状態不明のZAICO在庫は更新用データに変換できません。');
  // A partial/error payload must never be interpreted as a request to clear
  // thousands of fields during the authoritative first import.
  for(const field of ['id','title','quantity','unit','category','state','place','etc','code','optional_attributes']){
    if(!Object.prototype.hasOwnProperty.call(row,field))throw Error(`ZAICOの応答に必須項目 ${field} がありません。`);
  }
  if(!Number.isSafeInteger(row.id)||Number(row.id)<=0)throw Error('ZAICOの在庫IDを確認できません。');
  if(row.optional_attributes!==null&&
    (typeof row.optional_attributes!=='object'||Array.isArray(row.optional_attributes)||
      Object.values(row.optional_attributes).some(v=>v!==null&&typeof v!=='string'))){
    throw Error('ZAICOの追加項目の形式が不正です。');
  }
  if(row.quantity!==null&&
    (typeof row.quantity!=='string'&&typeof row.quantity!=='number')){
    throw Error('ZAICOの数量の形式が不正です。');
  }
  if(typeof row.quantity==='number'&&!Number.isFinite(row.quantity))throw Error('ZAICOの数量が有限の数値ではありません。');
  return {...row,optional_attributes:Object.entries(row.optional_attributes??{}).map(([name,value])=>({name,value}))};
}
/** No UI/page-load entry points. Only the serialized transition worker owns this client. */
export function createV2Client(options:V2ClientOptions){
  if(!Number.isSafeInteger(options.companyId)||options.companyId<=0)throw Error('ZAICO拠点IDが未設定です。');
  const fetcher=options.fetch??fetch,now=options.now??Date.now;
  const sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const base=`https://web.zaico.co.jp/api/v2/orgs/companies/${options.companyId}`;
  let lastStarted:number|undefined;
  let queue:Promise<unknown>=Promise.resolve();
  function request(method:'GET'|'PUT'|'PATCH'|'POST'|'DELETE',path:string,body?:unknown):Promise<unknown>{
    const result=queue.then(()=>performRequest(method,path,body));
    queue=result.catch(()=>undefined);
    return result;
  }
  async function performRequest(method:'GET'|'PUT'|'PATCH'|'POST'|'DELETE',path:string,body?:unknown):Promise<unknown>{
    for(let attempt=0;attempt<5;attempt++){
      if(lastStarted!==undefined)await sleep(Math.max(0,1000-(now()-lastStarted)));
      const token=await options.token();
      await options.beforeRequest(method);
      lastStarted=now();
      let response:Response;
      try{
        response=await fetcher(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
          body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20_000),redirect:'error',cache:'no-store'});
      }catch{
        if(method!=='GET')throw new ZaicoHttpError(0,0,true);
        if(attempt===4)throw new ZaicoHttpError(0,0);
        await sleep(1000*2**attempt);continue;
      }
      if(response.ok){
        if(response.status===204)return null;
        try{return await response.json();}catch{throw new ZaicoHttpError(response.status,0,method!=='GET');}
      }
      const header=response.headers.get('retry-after');
      const delay=header?(Number.isFinite(Number(header))?Number(header)*1000:Math.max(0,Date.parse(header)-now())):1000*2**attempt;
      // Do not blindly repeat writes after timeouts/5xx: create is not idempotent.
      if((response.status===429||(method==='GET'&&response.status>=500))&&attempt<4){
        if(delay>30_000)throw new ZaicoHttpError(response.status,delay);
        await sleep(Number.isFinite(delay)?Math.max(1000,delay):1000);continue;
      }
      throw new ZaicoHttpError(response.status,Number.isFinite(delay)?delay:1000,method!=='GET'&&response.status>=500);
    }
    throw Error('ZAICO request attempts exhausted');
  }
  function inventoryPath(id:string){
    if(!/^[1-9]\d*$/.test(id))throw Error('Invalid ZAICO inventory ID');
    return `/inventories/${id}.json`;
  }
  return {
    async list(input:{start?:string;end:string;page:number;includeDeleted?:boolean}){
      if(!Number.isFinite(Date.parse(input.end))||(input.start&&!Number.isFinite(Date.parse(input.start)))||
        (input.start&&Date.parse(input.start)>=Date.parse(input.end)))throw Error('Invalid sync window');
      if(!Number.isInteger(input.page)||input.page<1)throw Error('Invalid page');
      const query=new URLSearchParams({per_page:'1000',page:String(input.page),sort_by:'id',sort_order:'asc',end_updated_at:input.end,include_deleted:String(input.includeDeleted??true)});
      if(input.start)query.set('start_updated_at',input.start);
      const result=await request('GET',`/inventories.json?${query}`) as {data:V2Inventory[];pagination:{current_page:number;total_pages:number;total_count:number}};
      if(!Array.isArray(result?.data)||!Number.isInteger(result.pagination?.total_pages)||!Number.isInteger(result.pagination.total_count)||result.pagination.current_page!==input.page)throw Error('ZAICO pagination could not be verified');
      return result as {data:V2Inventory[];pagination:{current_page:number;total_pages:number;total_count:number}};
    },
    async get(id:string):Promise<V2Inventory|null>{
      try {
        const result=await request('GET',inventoryPath(id)) as {data:V2Inventory};
        if(!result?.data||String(result.data.id)!==id||typeof result.data.deleted!=='boolean')throw Error('ZAICOの商品取得結果を確認できません。');
        return result.data;
      }
      catch(error){if(error instanceof ZaicoHttpError&&error.status===404)return null;throw error;}
    },
    // The worker persists an attempt before using these and verifies by GET afterwards.
    patch:async(id:string,patch:Record<string,unknown>)=>await request('PUT',inventoryPath(id),patch) as {data?:V2Inventory}|null,
    create:async(body:Record<string,unknown>)=>await request('POST','/inventories.json',body) as {data?:V2Inventory}|null,
    remove:(id:string)=>request('DELETE',inventoryPath(id)),
  };
}
