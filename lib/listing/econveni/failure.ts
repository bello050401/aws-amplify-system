import {BaseListingApiError} from '../base/errors';
import {EconveniPreparationError} from './mapping';
import {EconveniWorkflowError} from './workflowStore';
import {EconveniHttpError} from './httpSession';
export type EconveniSaveResult={status:'DONE'|'WAIT'|'BLOCKED';message:string;productId?:string;nextAt?:number};
export function econveniFailure(error:unknown):EconveniSaveResult{
  if(error instanceof BaseListingApiError)return {status:'BLOCKED',message:error.message};
  if(error instanceof EconveniPreparationError)return {status:'BLOCKED',message:error.message};
  if(error instanceof EconveniWorkflowError&&error.code==='WAIT_INTERVAL')return {status:'WAIT',nextAt:error.readyAt,message:'eコンビニへの送信間隔を空けています。'};
  const messages:Record<string,string>={AUTH_REQUIRED:'eコンビニの接続設定からログインを確認してください。',ACCESS_DENIED:'eコンビニ側で接続が拒否されました。設定から接続を確認してください。',ADDITIONAL_AUTH:'eコンビニで追加認証が必要です。自動送信を停止しています。',BUSY_OR_STOPPED:'別の商品の処理中、または接続の確認が必要です。少し待って再確認してください。',VERIFY_REQUIRED:'前回の処理結果を確認できません。重複送信を防ぐため、再送せず結果を再確認してください。',CONTRACT_CHANGED:'eコンビニの保存項目・画像または画面形式を確認できませんでした。出品は実行していません。'};
  const code=error instanceof EconveniHttpError||error instanceof EconveniWorkflowError?error.code:'';
  return {status:'BLOCKED',message:messages[code]??'eコンビニの処理結果を確認できませんでした。再送せず、保存結果を確認してください。'};
}
