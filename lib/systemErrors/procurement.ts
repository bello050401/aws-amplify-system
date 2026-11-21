import { reportServerSystemError } from './server';
import { safeErrorClass } from './client';

/** User corrections, expired logins and supplier throttling are not code repairs. */
export function isExpectedProcurementError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  if (['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error.name)) return false;
  return /GMAIL_(?:RATE_LIMIT|AUTH_REQUIRED)|ログイン|権限|再接続|認証|有効期限|別の画面|登録中|処理中|更新中|数量.*(?:入力|確認|不正)|金額.*(?:入力|確認|変更)|送料.*(?:入力|確認)|点数.*(?:入力|確認)|取得結果が不正|取得内容を確認してから|全商品の取得結果を確認|落札内容が変更|全落札の台帳集計|全体の数量|0より大き|を選択してください|を入力してください|金額変更通知|同名の既存商品/.test(error.message);
}
export async function reportProcurementError(error: unknown, provider: 'yahoo' | 'trefac' | 'restage', operation: 'fetch' | 'enrich' | 'register'): Promise<boolean> {
  if (isExpectedProcurementError(error)) return false;
  return reportServerSystemError({ code: operation === 'enrich' ? 'PROCUREMENT_ENRICH_FAILED' : operation === 'register' ? 'PROCUREMENT_REGISTER_FAILED' : 'PROCUREMENT_FETCH_FAILED',
    surface: 'server', component: `procurement-${provider}`, operation, errorClass: safeErrorClass(error) });
}
