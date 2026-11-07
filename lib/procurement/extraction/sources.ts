import {parse} from 'parse5';
import {createHash} from 'node:crypto';
import type {EvidenceBlock,SourceDocument,SourceIdentity} from './types';
type Node = {nodeName?:string;tagName?:string;value?:string;attrs?:{name:string;value:string}[];childNodes?:Node[]};
const attr=(n:Node,k:string)=>n.attrs?.find(a=>a.name===k)?.value||'';
const walk=(n:Node):Node[]=>[n,...(n.childNodes||[]).flatMap(walk)];
const text=(n:Node):string=>n.nodeName==='#text'?n.value||'':(n.childNodes||[]).map(text).join('');
export const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
/** Preserve cells, rows and paragraph boundaries. Scripts/advertising are not evidence. */
export function descriptionBlocks(html:string):EvidenceBlock[]{
  if(html.length>2_000_000)throw Error('DESCRIPTION_TOO_LARGE');
  const result:EvidenceBlock[]=[];let current='',heading='',table='',row=0,seq=0;
  const add=(s:string,cells?:string[])=>{const value=s.replace(/[\t\u00a0 ]+/g,' ').trim();if(value)result.push({id:'b'+result.length,text:value,heading,table:table||undefined,row:table?row:undefined,cells,verified:true});};
  const flush=()=>{add(current);current='';};
  const plain=(n:Node):string=>['script','style','noscript','iframe'].includes(n.tagName||'')?'':n.tagName==='br'?'\n':n.nodeName==='#text'?n.value||'':(n.childNodes||[]).map(plain).join('');
  const visit=(n:Node)=>{
    const tag=n.tagName||'';
    if(['script','style','noscript','iframe','nav','footer'].includes(tag))return;
    if(n.nodeName==='#text'){current+=n.value||'';return;}
    if(tag==='br'){flush();return;}
    if(tag==='table'){flush();const old=table;table='t'+seq++;for(const c of n.childNodes||[])visit(c);flush();table=old;return;}
    if(tag==='tr'){
      flush();row++;const cells=(n.childNodes||[]).filter(c=>['td','th'].includes(c.tagName||''));
      // Layout tables commonly contain complete descriptions: descend into those,
      // but keep actual header/value rows intact for axis order and common units.
      if(cells.length&&cells.length<=8&&!cells.some(c=>walk(c).some(x=>x.tagName==='table'))){
        const values=cells.map(plain);if(values.every(s=>!s.includes('\n')&&s.length<180)){add(values.join(' | '),values);return;}
      }
    }
    const boundary=/^(p|div|li|tr|h[1-6]|center)$/.test(tag);if(boundary)flush();
    if(/^h[1-6]$/.test(tag)){heading=plain(n).trim();add(heading);return;}
    for(const c of n.childNodes||[])visit(c);if(boundary)flush();
  };
  visit(parse(html) as Node);flush();if(result.length>2000)throw Error('DESCRIPTION_TOO_MANY_BLOCKS');return result;
}
/** The exact auction-ID object and its full descriptionHtml were observed in
 * Yahoo's page data. Meta/JSON-LD summaries are truncated and never used. */
export function yahooDescription(html:string,identity:SourceIdentity):SourceDocument{
  const all=walk(parse(html) as Node),found:string[]=[];
  const inspect=(value:unknown,depth=0)=>{if(depth>35||!value||typeof value!=='object')return;
    const v=value as Record<string,unknown>;
    if(v.auctionId===identity.externalId&&typeof v.descriptionHtml==='string')found.push(v.descriptionHtml);
    for(const child of Object.values(v))inspect(child,depth+1);
  };
  for(const script of all.filter(n=>n.tagName==='script'&&attr(n,'id')==='__NEXT_DATA__')){try{inspect(JSON.parse(text(script)));}catch{throw Error('DESCRIPTION_DATA_INVALID');}}
  const distinct=[...new Set(found)];
  if(distinct.length!==1)throw Error('DESCRIPTION_NOT_VERIFIED');
  const body=distinct[0];return {identity,hash:sha(body),acquiredAt:new Date().toISOString(),url:`https://auctions.yahoo.co.jp/jp/auction/${identity.externalId}`,format:'yahoo-description-html-v1',complete:true,targetVerified:true,originalDescriptionHtml:body,blocks:descriptionBlocks(body),issues:[]};
}
export function restageSheetLinks(html:string,identity:SourceIdentity){
  const all=walk(parse(html) as Node),value=(id:string)=>attr(all.find(n=>attr(n,'id')===id)||{},'value');
  if(value('choiceGoodsId')!==identity.externalId||value('choiceAuctionDate')!==identity.date?.replaceAll('-','/'))throw Error('RESTAGE_TARGET_MISMATCH');
  const links=all.filter(n=>n.tagName==='img'&&attr(n,'alt')==='出品票').map(n=>new URL(attr(n,'src'),'https://real.next-restage.co.jp/restage/').href);
  return [...new Set(links)].map(url=>{
    const u=new URL(url),key=u.searchParams.get('imageKey');
    if(u.origin!=='https://real.next-restage.co.jp'||u.pathname!=='/restage/common.action'||u.searchParams.get('action')!=='get_image'||!key?.match(new RegExp('^'+identity.externalId+'/[0-9]+\\.png$')))throw Error('RESTAGE_DOCUMENT_URL_INVALID');
    return {url,key};
  });
}
