import {totals,type Invoice,type CalcConfig} from './model';
const ORIGIN='https://invoice.moneyforward.com';
type RecordValue=Record<string,unknown>;
export class ProviderFailure extends Error { constructor(readonly checkCode='VALIDATION'){super('PROVIDER_FAILURE');} }
// No general API proxy is exported. IDs come exclusively from this invocation's create responses.
export class NewInvoiceProvider {
 private partner=''; private billing=''; private pdf='';
 constructor(private token:string,private fetcher:typeof fetch=fetch){}
 allowed(method:string,path:string){return (method==='POST'&&(path==='/api/v3/partners'||path==='/api/v3/invoice_template_billings'||(!!this.partner&&path===`/api/v3/partners/${this.partner}/departments`)))||(method==='GET'&&!!this.pdf&&path===this.pdf);}
 private async json(path:string,body:RecordValue):Promise<RecordValue>{
  if(!this.allowed('POST',path))throw new ProviderFailure();
  const res=await this.fetcher(ORIGIN+path,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000),cache:'no-store'});
  // Never include provider response bodies (which contain invoice details) in an exception/log.
  if(!res.ok)throw new ProviderFailure(`${path.endsWith('/partners')?'PARTNER':path.endsWith('/departments')?'DEPARTMENT':'BILLING'}_HTTP_${res.status}`);return res.json();
 }
 private id(value:unknown){if(typeof value!=='string'||!/^[-_a-zA-Z0-9]{1,160}$/.test(value))throw new ProviderFailure();return value;}
 async create(input:Invoice,config:CalcConfig,number:string){
  if(!/^20\d{6}[1-9]\d{0,4}$/.test(number)||!number.startsWith(input.date.replaceAll('-','')))throw new ProviderFailure('NUMBER_INVALID');
  const p=await this.json('/api/v3/partners',{name:input.recipient,name_suffix:input.suffix});this.partner=this.id(p.id);
  // MF rejects an entirely blank department (422). Use the known issuer label;
  // never invent a recipient address, department or contact person.
  const d=await this.json(`/api/v3/partners/${this.partner}/departments`,{office_member_name:'株式会社BELLO'});const department=this.id(d.id);
  const result=await this.json('/api/v3/invoice_template_billings',{department_id:department,billing_date:input.date,due_date:input.dueDate,billing_number:number,
   items:input.lines.map(l=>({name:l.name,price:Number(l.price),quantity:Number(l.quantity),excise:l.tax}))});
  this.billing=this.id(result.id);const expected=totals(input.lines,config);const c=result.config as CalcConfig|undefined;
  // MF returns slash-separated dates although requests use ISO dates.
  const date=(value:unknown)=>typeof value==='string'?value.replaceAll('/','-'):'';
  if(result.billing_number!==number||date(result.billing_date)!==input.date||date(result.due_date)!==input.dueDate)throw new ProviderFailure('NUMBER_OR_DATE_MISMATCH');
  // Fixed MF settings are authoritative; a drift must never be reported as a correct invoice.
  if(!c||c.consumption_tax_display_type!=='internal'||c.rounding!==config.rounding||c.rounding_consumption_tax!==config.rounding_consumption_tax||Number(result.total_price)!==expected.total||Number(result.excise_price)!==expected.tax)throw new ProviderFailure();
  const rows=result.items as RecordValue[]|undefined;
  if(!Array.isArray(rows)||rows.length!==input.lines.length||rows.some((r,i)=>r.name!==input.lines[i].name||Number(r.price)!==Number(input.lines[i].price)||Number(r.quantity)!==Number(input.lines[i].quantity)||r.excise!==input.lines[i].tax))throw new ProviderFailure();
  const pdf=new URL(String(result.pdf_url));if(pdf.origin!==ORIGIN||pdf.pathname!==`/api/v3/billings/${this.billing}.pdf`||pdf.search||pdf.hash)throw new ProviderFailure();this.pdf=pdf.pathname;
  return {billingId:this.billing,number:typeof result.billing_number==='string'?result.billing_number:undefined};
 }
 async downloadNew(billingId:string){
  // Only called after decrypting an issuer-generated, owner-bound short-lived capability.
  this.billing=this.id(billingId);this.pdf=`/api/v3/billings/${this.billing}.pdf`;
  if(!this.allowed('GET',this.pdf))throw new ProviderFailure();
  const res=await this.fetcher(ORIGIN+this.pdf,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${this.token}`},signal:AbortSignal.timeout(20000),cache:'no-store'});
  if(!res.ok||!res.headers.get('content-type')?.includes('application/pdf'))throw new ProviderFailure();
  const reader=res.body?.getReader();if(!reader)throw new ProviderFailure();const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>4000000){await reader.cancel();throw new ProviderFailure();}chunks.push(n.value);}}finally{reader.releaseLock();}
  const data=Buffer.concat(chunks);if(data.subarray(0,5).toString()!=='%PDF-')throw new ProviderFailure();return data;
 }
}
