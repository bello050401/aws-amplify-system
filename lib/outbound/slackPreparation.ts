/** Preparation only: no token in browsers, no network call, and no sending enabled yet.
 * Later transport: files.getUploadURLExternal → bytes → files.completeUploadExternal.
 * https://docs.slack.dev/reference/methods/files.getUploadURLExternal/
 * https://docs.slack.dev/reference/methods/files.completeUploadExternal/
 */
export interface SlackOutboundConfiguration {
  channelId: string | null;
  templateReady: boolean;
  held: boolean;
  // Secret is resolved only by the server's AWS secret provider, never from client input.
  credentialConfigured: boolean;
}
export type SlackOutboundReceipt = {
  batchId:string; documentSha256:string; fileId:string|null;
  state:'NOT_SENT'|'UPLOADING'|'AWAITING_CONFIRMATION'|'SENT'|'FAILED'|'UNKNOWN';
  channelId:string; sentAt:string|null; messageTs:string|null;
};
export function slackPreparationStatus(config:SlackOutboundConfiguration) {
  if(config.held)return {ready:false,message:'送信データの作成は保留中です。'};
  if(!config.templateReady)return {ready:false,message:'川越の送信用テンプレートをお待ちしています。'};
  if(!config.channelId||!/^[CG][A-Z0-9]{8,}$/u.test(config.channelId))return {ready:false,message:'Slackの送信先を設定してください。'};
  if(!config.credentialConfigured)return {ready:false,message:'Slackとの接続が未設定です。'};
  return {ready:false,message:'送信前の接続確認が必要です。'};
}
/** UNKNOWN must be reconciled with the recorded file ID, never auto-sent again. */
export function canApplySlackInventoryUpdate(receipt:SlackOutboundReceipt,documentSha256:string) {
  return receipt.state==='SENT'&&!!receipt.fileId&&!!receipt.sentAt&&receipt.documentSha256===documentSha256;
}
