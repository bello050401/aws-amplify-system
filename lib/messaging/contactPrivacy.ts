/** Inquiry content only. Opaque channel/order identifiers and inventory records are not contact details. */
import municipalities from './jpMunicipalities.json';
const PREF='(?:北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)';
const addressEnd='(?=です|なのですが|になります|となります|から|まで|へ|にて|に(?:お願い|住|届|配|送|お)|でお願い|をお願い|への|。|、|[\\r\\n<>]|$)';
const address=new RegExp('('+PREF+')([^\\r\\n<>。、「」]{0,160}?)'+addressEnd,'g');
const prefecture=new RegExp(PREF);
const escape=(v:string)=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Official municipality names avoid mistaking surnames such as 中村 for an address.
const municipality=new RegExp('(?:'+municipalities.names.map(escape).join('|')+')([^\\r\\n<>。、「」]{0,160}?)'+addressEnd,'g');
const cityDestination=new RegExp('(?:'+municipalities.names.filter(n=>n.endsWith('市')&&n.length>=3).map(n=>escape(n.slice(0,-1))).join('|')+')(?=まで|へ|に(?:届け|配達))','g');
const regionOnly=(value:string)=>value.match(prefecture)?.[0]??'[住所削除]';
const labelledAddress=/(住所|配送先|送付先|送り先|お届け先|所在地|Address)\s*[:：]\s*[^\r\n<>。]+/gi;
const contactKey=/^(?:address|address[1-3]|addressLine[1-3]|street|streetAddress|city|municipality|town|building|roomNumber|postalCode|zipCode|zip|postcode|phone|phoneNumber|telephone|tel|fax|email|emailAddress|contactAddress|deliveryAddress|shippingAddress|billingAddress|customerPhone|customerEmail|customerAddress|buyerPhone|buyerEmail|buyerAddress)$/i;
const referenceKey=/^(?:id|pk|sk|.*Id|.*Ids|.*Token|.*Hash|.*Key|.*By|digest|fingerprint|checksum|signature|who|actor|owner|account|channel|direction|senderType|status|state|version)$/;
export function redactInquiryContacts(value:string):string{
 // Do not normalize the entire product title / message. Only contact spans are replaced.
 const redacted=value
  .replace(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[連絡先削除]')
  .replace(/(?<![A-Za-z0-9])(?:\+81[-\s]?(?:\(0\))?\d{1,4}|0\d{1,4})[-‐‑–ー－\s(（]\d{1,4}[-‐‑–ー－\s)）]\d{3,4}(?![A-Za-z0-9])/g,'[連絡先削除]')
  .replace(/(?<![A-Za-z0-9])(?:0[789]0\d{8}|0[1-9]\d{8})(?![A-Za-z0-9])/g,'[連絡先削除]')
  .replace(/(?:電話|TEL|FAX|携帯|連絡先)\s*[:：]?\s*[+＋\d０-９()（）\s－ー-]{8,25}/gi,'[連絡先削除]')
  .replace(/〒\s*[0-9０-９]{3}[-－\s]?[0-9０-９]{4}|(?<![A-Za-z0-9])\d{3}-\d{4}(?![A-Za-z0-9])/g,'[郵便番号削除]')
  .replace(labelledAddress,(whole,label)=>label+'：'+regionOnly(whole))
  .replace(address,(_,region,detail)=>region+(detail.trim()&&!/^\[住所削除\]$/.test(detail.trim())?'[住所削除]':detail.trim()))
  .replace(municipality,'[住所削除]')
  .replace(cityDestination,'[住所削除]')
  .replace(/(?:LINE\s*ID|ラインID)\s*[:：]\s*[a-z0-9_.-]+/gi,'[連絡先削除]');
 // Postal forms often put town, street and building on separate lines.
 let followingAddress=0,streetWasRedacted=false;
 return redacted.split(/(\r?\n)/).map(line=>{
  if(line==='\n'||line==='\r\n')return line;
  if(line.includes('[住所削除]')||/^(?:住所|配送先|送付先|送り先|お届け先)\s*[:：]/.test(line)){followingAddress=3;streetWasRedacted=false;return line;}
  if(!followingAddress)return line;
  followingAddress--;
  if(!line.trim())return line;
  if(/[:：?？。]|です|ます|ください|お願い|送料|配送|配達|振込|確認|名前|氏名|電話|連絡先|メール|購入|日時|商品|サイズ/i.test(line)){followingAddress=0;return line;}
  const street=/(?:町|丁目|番地|番|号|条|通).*?[0-9０-９一二三四五六七八九十]|[0-9０-９]+[-－][0-9０-９]+/.test(line);
  if(line.trim().length<=100&&(street||streetWasRedacted||/マンション|ハイツ|コーポ|レジデンス|ビル|アパート|メゾン|号室/.test(line))){streetWasRedacted=street;return '[住所削除]';}
  followingAddress=0;return line;
 }).join('');
}
export function redactInquiryRecord<T>(value:T):T{
 if(typeof value==='string'){
  const trimmed=value.trim();
  if(trimmed.startsWith('{')||trimmed.startsWith('['))try{const v=JSON.parse(value);if(v&&typeof v==='object'){const redacted=redactInquiryRecord(v);return (JSON.stringify(redacted)===JSON.stringify(v)?value:JSON.stringify(redacted)) as T;}}catch{}
  return redactInquiryContacts(value) as T;
 }
 if(Array.isArray(value))return value.map(v=>redactInquiryRecord(v)) as T;
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){
  return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,referenceKey.test(key)?v:contactKey.test(key)&&v!=null&&v!==''?(/address|street/i.test(key)?regionOnly(typeof v==='string'?v:JSON.stringify(v)):'[連絡先削除]'):redactInquiryRecord(v)])) as T;
 }
 return value;
}
