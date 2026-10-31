import type {SoldOutResult} from '../inventory/soldOutInput';
export type SaleChannel='BASE'|'MERCARI'|'YAHOO'|'DIRECT';
export type YahooSaleStatus='WON'|'ADDRESS_CONFIRMED'|'AWAITING_SHIPMENT';
export const YAHOO_STATUS_LABELS:Record<YahooSaleStatus,string>={WON:'落札',ADDRESS_CONFIRMED:'住所確定',AWAITING_SHIPMENT:'発送待ち'};
export const CHANNELS:Record<SaleChannel,{label:string;market:string}>={BASE:{label:'BASE',market:'ベイス'},MERCARI:{label:'メルカリShops',market:'メルカリSHOP'},YAHOO:{label:'Yahoo!オークション',market:'ヤフオク'},DIRECT:{label:'直接取引',market:'直接取引'}};
export type SaleCandidate={
 id:string; state:'PENDING'|'DONE'|'DELETED'; channel:SaleChannel; source:'GMAIL'|'DIRECT'|'INVOICE'|'BASE_API';
 name:string; quantity:number|null; unitPrice:number|null; orderId:string; identifierType:'ORDER'|'AUCTION'|'INVOICE'|'MANUAL';
 saleDate:string; receivedAt:string; createdAt:string; updatedAt:string; suggestedInventoryId?:string;
 shipping:number|null; orderTotal:number|null; payment:string; warnings:string[]; orderLineCount:number;
 feeAllocation?:{index:number;amounts:number[]};
 externalListingId?:string; orderLineId?:string;
 yahooStatus?:YahooSaleStatus; yahooEvents?:Partial<Record<YahooSaleStatus,string>>;
 orderRoute?:'WEB'|'PAY_ID_APP'|'UNKNOWN';
 confirmedLineFee?:number;
 result?:SoldOutResult; completedBy?:string; completedAt?:string; deletedBy?:string; deletedAt?:string;
 completedSale?:{quantity:number;total:number|null;commission:number|null;shippingReceived?:number|null;date:string;identifier:string};
};
export type FeeRule={rateBps:number;fixed:number;serviceBps:number;rounding:'ROUND'|'FLOOR'|'YAHOO_TAX'};
export type FeeConfig={base:FeeRule;baseExternal:FeeRule;basePayId:FeeRule;mercari:FeeRule;yahoo:FeeRule;direct:FeeRule};
// Defaults are editable in the admin UI and persisted separately from order data.
export const DEFAULT_FEES:FeeConfig={
 base:{rateBps:360,fixed:40,serviceBps:300,rounding:'ROUND'},
 baseExternal:{rateBps:460,fixed:40,serviceBps:300,rounding:'ROUND'},
 basePayId:{rateBps:360,fixed:40,serviceBps:590,rounding:'ROUND'},
 mercari:{rateBps:1000,fixed:0,serviceBps:0,rounding:'FLOOR'},
 yahoo:{rateBps:909,fixed:0,serviceBps:0,rounding:'YAHOO_TAX'},
 direct:{rateBps:0,fixed:0,serviceBps:0,rounding:'ROUND'},
};
// Yahoo's advertised 10% includes tax. Official settlement: round 9.09%, then floor tax.
// Normalize only our former standard presets; keep explicitly customized fee rules.
export function currentYahooFee(rule:FeeRule):FeeRule {
 return ((rule.rounding==='YAHOO_TAX' && [909,1000].includes(rule.rateBps)) || rule.rounding==='ROUND' && rule.rateBps===1000) && !rule.fixed && !rule.serviceBps
   ? {...DEFAULT_FEES.yahoo} : rule;
}
export function currentFeeConfig(config:FeeConfig):FeeConfig { return {...config,yahoo:currentYahooFee(config.yahoo)}; }
export function calculateFee(channel:SaleChannel,amount:number,payment:string,config:FeeConfig=DEFAULT_FEES,viaPayId=false){
 if(!Number.isSafeInteger(amount)||amount<0)throw Error('手数料の計算対象額を確認してください。');
 const key=channel==='BASE'?(viaPayId?'basePayId':/Amazon\s*Pay|PayPal|PayPay/i.test(payment)?'baseExternal':'base'):channel==='MERCARI'?'mercari':channel==='YAHOO'?'yahoo':'direct';
 const r=key==='yahoo'?currentYahooFee(config.yahoo):config[key],round=r.rounding==='FLOOR'?Math.floor:Math.round;
 const fee=round(amount*r.rateBps/10000)+r.fixed;
 return fee+(r.rounding==='YAHOO_TAX'?Math.floor(fee/10):round(amount*r.serviceBps/10000));
}
export function validateFeeConfig(value:unknown):FeeConfig{
 const v=value as FeeConfig;if(!v||typeof v!=='object')throw Error('手数料設定を確認してください。');
 return Object.fromEntries(Object.keys(DEFAULT_FEES).map(k=>{const r=v[k as keyof FeeConfig];if(!r||!['ROUND','FLOOR','YAHOO_TAX'].includes(r.rounding)||![r.rateBps,r.serviceBps,r.fixed].every(n=>Number.isSafeInteger(n)&&n>=0)||r.rateBps>10000||r.serviceBps>10000||r.fixed>100000)throw Error('手数料設定を確認してください。');return [k,{rateBps:r.rateBps,serviceBps:r.serviceBps,fixed:r.fixed,rounding:r.rounding}];})) as FeeConfig;
}
export function allocateFee(total:number,amounts:number[]):number[]{
 if(!Number.isSafeInteger(total)||total<0||!amounts.length||amounts.some(n=>!Number.isSafeInteger(n)||n<0))throw Error('INVALID_FEE');
 const sum=amounts.reduce((a,b)=>a+b,0);if(!Number.isSafeInteger(sum)||sum<=0)throw Error('INVALID_FEE');
 const raw=amounts.map(n=>BigInt(n)*BigInt(total)),div=BigInt(sum),result=raw.map(n=>Number(n/div));
 const rank=raw.map((n,i)=>({i,remainder:n%div})).sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:a.i-b.i);
 for(let i=0,left=total-result.reduce((a,b)=>a+b,0);i<left;i++)result[rank[i].i]++;
 return result;
}
