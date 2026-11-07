/** Paused by BELLO. Purchase-notification ingestion lives in saleCandidates and is independent. */
export const MESSAGES_PAUSED=false;
/** Evaluation release: external customer delivery remains disabled at the server. */
export const CUSTOMER_DELIVERY_ENABLED=false;
export function assertMessagesEnabled(){if(MESSAGES_PAUSED)throw Error('メッセージ機能は現在停止中です。');}
