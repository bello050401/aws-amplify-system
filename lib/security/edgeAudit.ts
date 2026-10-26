import {isIP} from 'node:net';
import type {Row} from './types';

export type EdgeRecord={timestamp?:number;httpSourceName?:string;httpRequest?:{requestId?:string;clientIp?:string;uri?:string;httpMethod?:string;headers?:{name:string;value:string}[]}};
export type EdgeLookup=(ids:string[],from:number,to:number)=>Promise<EdgeRecord[]>;
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_+\/-]{16,200}={0,2}$/.test(id);
/** AWS-generated request ID plus host/path/method/time, never forwarded-IP headers.
 * No match or ambiguous evidence stays explicitly unverified. No auth decisions. */
export function matchEdgeIp(row:Row,records:EdgeRecord[],host:string):string|undefined {
 if(!validId(row.edgeRequestId)||typeof row.edgeAt!=='number'||typeof row.edgeTarget!=='string'||typeof row.edgeMethod!=='string')return;
 const found=records.filter(record=>{
  const r=record.httpRequest;if(!r)return false;
  const hosts=(r?.headers??[]).filter(h=>h.name.toLowerCase()==='host').map(h=>h.value.toLowerCase().replace(/:443$/,'').replace(/\.$/,''));
  return record.httpSourceName==='CF'&&r?.requestId===row.edgeRequestId&&hosts.length===1&&hosts[0]===host&&r.uri===row.edgeTarget&&r.httpMethod===row.edgeMethod&&
   typeof record.timestamp==='number'&&Math.abs(record.timestamp-Number(row.edgeAt)*1000)<=90000&&typeof r.clientIp==='string'&&isIP(r.clientIp)>0;
 });
 const ips=new Set(found.map(r=>r.httpRequest!.clientIp!));return ips.size===1?[...ips][0]:undefined;
}
export function createEdgeAuditEnricher(host:string,lookup:EdgeLookup,now=Date.now){
 const cache=new Map<string,{ip:string;until:number}>();
 return async(rows:Row[])=>{
  const eligible=rows.filter(r=>validId(r.edgeRequestId)&&typeof r.edgeAt==='number'&&r.edgeAt*1000>=now()-90*86400000&&r.edgeAt*1000<=now()+90000);
  const cacheKey=(r:Row)=>[r.edgeRequestId,r.edgeAt,r.edgeTarget,r.edgeMethod].join('|');
  const missing=eligible.filter(r=>!cache.has(cacheKey(r))||cache.get(cacheKey(r))!.until<=now());
  const records:EdgeRecord[]=[];
  // Each bounded batch keeps the AWS filter under 1,024 characters. Limit
  // concurrency to two; only ADMIN audit views incur these requests.
  const deadline=now()+2500;
  for(let start=0;start<missing.length&&now()<deadline;start+=8){
   const groups=[missing.slice(start,start+4),missing.slice(start+4,start+8)].filter(g=>g.length);
   const results=await Promise.allSettled(groups.map(g=>lookup(g.map(r=>r.edgeRequestId as string),Math.min(...g.map(r=>Number(r.edgeAt)))*1000-90000,Math.max(...g.map(r=>Number(r.edgeAt)))*1000+90000)));
   for(const r of results)if(r.status==='fulfilled')records.push(...r.value);
  }
  if(cache.size>500)cache.clear();
  return rows.map(row=>{
   const key=cacheKey(row),existing=cache.get(key),ip=existing&&existing.until>now()?existing.ip:matchEdgeIp(row,records,host);
   if(!ip)return row;
   cache.set(key,{ip,until:now()+60000});
   return {...row,[row.kind==='device'?'lastIp':'ip']:ip,edgeIpVerified:true};
  });
 };
}
