import {RESTAGE_ORIGIN,parseRestageLots,validateImageUrl,type RestageLot} from './restage';

/** Read-only portal operations. Never accepts arbitrary actions, URLs or a browser session. */
export class RestageHttp {
  private cookies=new Map<string,string>();
  private lastRequest=0;
  constructor(private readonly credentials:{id:string;password:string}){}
  private async request(path:string,body?:Record<string,string>):Promise<Response>{
    let url=new URL(path,RESTAGE_ORIGIN).href;
    for(let i=0;i<5;i++){
      if(new URL(url).origin!==RESTAGE_ORIGIN) throw Error('リステージの接続先が変わっています。');
      const delay=350-(Date.now()-this.lastRequest);if(delay>0)await new Promise(r=>setTimeout(r,delay));this.lastRequest=Date.now();
      let response:Response;
      try{response=await fetch(url,{method:body?'POST':'GET',body:body?new URLSearchParams(body):undefined,headers:{Cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '),Referer:'https://next-restage.co.jp/member/','User-Agent':'Mozilla/5.0 BELLO inventory import'},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20000)});}catch{throw Error('リステージへの接続がタイムアウトしました。再度取得してください。');}
      for(const value of response.headers.getSetCookie()){const cookie=value.split(';')[0],at=cookie.indexOf('=');if(at>0)this.cookies.set(cookie.slice(0,at),cookie.slice(at+1));}
      if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)throw Error('リステージの応答が不正です。');url=new URL(location,url).href;body=undefined;continue;}
      if(!response.ok)throw Error(`リステージに接続できません（HTTP ${response.status}）。`);
      return response;
    }
    throw Error('リステージのログインに失敗しました。');
  }
  private async html(response:Response){const data=await this.bytes(response,5*1024*1024);return new TextDecoder('utf-8').decode(data);}
  private async bytes(response:Response,limit:number){
    if(Number(response.headers.get('content-length'))>limit)throw Error('リステージのデータが大きすぎます。');
    const reader=response.body?.getReader();if(!reader)throw Error('リステージの応答が空です。');const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw Error('リステージのデータが大きすぎます。');}chunks.push(value);}}finally{reader.releaseLock();}
    return Buffer.concat(chunks);
  }
  async login(){
    const response=await this.request('/restage/login',{action:'login',id:this.credentials.id,password:this.credentials.password});
    const html=await this.html(response);
    if(!html.includes(this.credentials.id)||!html.includes('membertop')||html.includes('id="jumpHp"'))throw Error('リステージへログインできません。ID・パスワードを確認してください。');
  }
  async fetchLots(date:string){
    const lots:RestageLot[]=[],errors:{goodsId:string;name:string;error:string}[]=[];const seen=new Set<string>();let maxPage=1;
    for(let page=1;page<=maxPage;page++){
      const html=await this.html(await this.request('/restage/goodslist.action',{action:page===1?'search':'page',listCbn:'5',conditionDate:date.replaceAll('-','/'),conditionLane:'',conditionCorner:'',conditionSpnSite:'',conditionResultType:'',viewNum:'500',hyojiMode:'1',page:String(page)}));
      const parsed=parseRestageLots(html,date);if(parsed.page!==page)throw Error('落札一覧のページが重複しています。');maxPage=Math.max(1,parsed.maxPage);
      for(const lot of parsed.lots){if(seen.has(lot.goodsId))throw Error('落札一覧に重複があり、取得を中止しました。');seen.add(lot.goodsId);lots.push(lot);}errors.push(...parsed.errors);
    }
    return{lots,errors};
  }
  async image(lot:RestageLot){
    const url=validateImageUrl(lot.imageUrl,lot.goodsId),response=await this.request(url),bytes=await this.bytes(response,25*1024*1024);
    // The portal serves image downloads with a generic Content-Type. Check the
    // file signature instead, rejecting login HTML and non-image responses.
    const mime=bytes.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
    if(!mime)throw Error('リステージの1枚目の写真を取得できません。再取得してください。');
    return {bytes,mime};
  }
}
