/** Paused by BELLO. Purchase-notification ingestion lives in saleCandidates and is independent. */
export const MESSAGES_PAUSED=true;
export function assertMessagesEnabled(){if(MESSAGES_PAUSED)throw Error('メッセージ機能は現在停止中です。');}
