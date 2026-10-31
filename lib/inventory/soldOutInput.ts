import { ZAICO_FIELD_CHOICES } from './zaicoFieldChoices';
import {saleAmounts,type SalePricing} from './salePricing';

export const SOLD_OUT_MARKETS = ZAICO_FIELD_CHOICES.market;
export interface SoldOutRequest {
  mutationId: string; inventoryId: string; expectedUpdatedAt: string;
  quantity: number; name: string; saleEndDate: string;
  externalProductId: string; market: string; salePrice: number | null;
  saleCommission?: number|null;
  /** Buyer-paid shipping for this sale, once per transaction; excluded from item revenue and fees. */
  saleShippingReceived?: number|null;
  sourceCandidateId?:string;
  /** UI hint only; the server derives eligibility from the stored Yahoo notification. */
  awaitingYahooPayment?:boolean;
  pricing?:SalePricing;
}
export interface SoldOutResult { sourceId: string; soldId: string; remainingQuantity: number; soldQuantity: number; updatedAt: string }
export class SoldOutError extends Error {
  constructor(public code: 'INVALID' | 'CONFLICT' | 'UNCONFIRMED', message: string) { super(message); }
}
export function japanToday(now = new Date()): string { return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
export function validateSoldOut(request: SoldOutRequest, available?: number, currentMarket = ''): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invalid = (message: string): never => { throw new SoldOutError('INVALID', message); };
  if (!request || !uuid.test(request.mutationId) || !uuid.test(request.inventoryId) || !Number.isFinite(Date.parse(request.expectedUpdatedAt))) invalid('商品を開き直してから登録してください。');
  if (!Number.isSafeInteger(request.quantity) || request.quantity < 1) invalid('売却数量は1以上の整数で入力してください。');
  if (available !== undefined && (!Number.isSafeInteger(available) || request.quantity > available)) invalid('売却数量が在庫数量を超えています。');
  if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 2000) invalid('商品名を2000文字以内で入力してください。');
  if (request.awaitingYahooPayment) {
    if(request.market!=='ヤフオク'||!request.sourceCandidateId||request.saleEndDate!=='')invalid('未入金のヤフオク通知を選び直してください。');
  } else if (typeof request.saleEndDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(request.saleEndDate) || !Number.isFinite(Date.parse(request.saleEndDate)) || new Date(request.saleEndDate).toISOString().slice(0,10) !== request.saleEndDate) invalid('販売終了日を正しく入力してください。');
  if (typeof request.externalProductId !== 'string' || request.externalProductId.length > 256) invalid('IDは256文字以内で入力してください。');
  if (typeof request.market !== 'string' || (request.market && request.market !== currentMarket && !(SOLD_OUT_MARKETS as readonly string[]).includes(request.market))) invalid('市場を選択肢から選んでください。');
  if (request.salePrice !== null && (!Number.isSafeInteger(request.salePrice) || request.salePrice < 0)) invalid('販売価格は0以上の整数で入力してください。');
  if (request.saleCommission!=null&&(!Number.isSafeInteger(request.saleCommission)||request.saleCommission<0))invalid('販売手数料は0以上の整数で入力してください。');
  if (request.saleShippingReceived!=null&&(!Number.isSafeInteger(request.saleShippingReceived)||request.saleShippingReceived<0))invalid('受取送料は0以上の整数で入力してください。');
  if(request.sourceCandidateId!==undefined&&!/^[a-f0-9]{64}$/.test(request.sourceCandidateId))invalid('購入通知を開き直してください。');
  if(request.sourceCandidateId&&(request.salePrice==null||request.saleCommission==null))invalid('販売価格と販売手数料を確認して入力してください。');
  if(request.pricing){
    let a;try{a=saleAmounts(request.pricing);}catch(e){invalid((e as Error).message);}
    if(a!.quantity!==request.quantity||a!.salePrice!==request.salePrice||a!.saleCommission!==(request.saleCommission??null))invalid('売却数量・単価・手数料の合計が一致しません。');
  }
}
