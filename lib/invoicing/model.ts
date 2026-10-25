// Shared by the web app and the isolated issuer. No persistence or network access.
export const UNKNOWN_RESULT = '請求書の保存結果を確認できませんでした。重複発行を防ぐため、マネーフォワード側で確認してください。';
export const TAXES = {ten_percent: {label:'10%',rate:10}, eight_percent_as_reduced_tax_rate:{label:'8%（軽減）',rate:8}, non_taxable:{label:'非課税',rate:0}, untaxable:{label:'不課税',rate:0}} as const;
export type Tax = keyof typeof TAXES;
export type Line = {name:string; price:string; quantity:string; tax:Tax};
export type Invoice = {recipient:string; suffix:'様'|'御中'; date:string; dueDate:string; lines:Line[]};
export type Rounding = 'round_down'|'round_up'|'round_off';
export type CalcConfig = {rounding:Rounding; rounding_consumption_tax:Rounding; consumption_tax_display_type:'internal'};
export const DEFAULT_CONFIG:CalcConfig={rounding:'round_down',rounding_consumption_tax:'round_down',consumption_tax_display_type:'internal'};
export function todayJst(){return new Date(Date.now()+9*3600000).toISOString().slice(0,10);}
export function nextMonthEnd(date=todayJst()){const [y,m]=date.split('-').map(Number);return new Date(Date.UTC(y,m+1,0)).toISOString().slice(0,10);}
function fixed(value:string){if(!/^\d{1,10}(\.\d{1,2})?$/.test(value))throw new Error('単価と数量は小数点以下2桁までの数値で入力してください。');const [a,b='']=value.split('.');return BigInt(a)*100n+BigInt(b.padEnd(2,'0'));}
function round(n:bigint,d:bigint,mode:Rounding){return mode==='round_up'?(n+d-1n)/d:mode==='round_off'?(n*2n+d)/(d*2n):n/d;}
export function totals(lines:Line[],config:CalcConfig=DEFAULT_CONFIG){
 const groups=new Map<Tax,bigint>();const amounts=lines.map(line=>{const amount=round(fixed(line.price)*fixed(line.quantity),10000n,config.rounding);groups.set(line.tax,(groups.get(line.tax)??0n)+amount);return Number(amount);});
 const taxes=Array.from(groups,([tax,gross])=>({tax,gross:Number(gross),amount:Number(round(gross*BigInt(TAXES[tax].rate),BigInt(100+TAXES[tax].rate),config.rounding_consumption_tax))}));
 const total=amounts.reduce((a,b)=>a+b,0);if(total>9999999999)throw new Error('合計金額が上限を超えています。');
 return {amounts,taxes,total,tax:taxes.reduce((a,b)=>a+b.amount,0)};
}
function dateValid(s:unknown):s is string{return typeof s==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}
export function validateInvoice(raw:unknown):Invoice{
 if(!raw||typeof raw!=='object')throw new Error('入力内容を確認してください。');const v=raw as Invoice;
 if(typeof v.recipient!=='string'||!v.recipient.trim()||v.recipient.trim().length>100||!['様','御中'].includes(v.suffix))throw new Error('宛名と敬称を入力してください。');
 if(!dateValid(v.date)||!dateValid(v.dueDate))throw new Error('請求日と支払期限を確認してください。');
 if(!Array.isArray(v.lines)||v.lines.length<1||v.lines.length>50)throw new Error('品目を1〜50件選択してください。');
 const lines=v.lines.map(l=>{if(!l||typeof l.name!=='string'||!l.name.trim()||l.name.trim().length>450||!Object.hasOwn(TAXES,l.tax))throw new Error('品目名と税区分を確認してください。');if(typeof l.price!=='string'||typeof l.quantity!=='string'||fixed(l.quantity)<=0n||fixed(l.quantity)>100000000n||fixed(l.price)>999999999900n)throw new Error('単価と数量を確認してください。');return {name:l.name.trim(),price:l.price,quantity:l.quantity,tax:l.tax};});
 totals(lines);return {recipient:v.recipient.trim(),suffix:v.suffix,date:v.date,dueDate:v.dueDate,lines};
}
