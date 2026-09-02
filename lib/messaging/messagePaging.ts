/**
 * 会話詳細のメッセージ取得単位。
 *
 * server-only なファイル(lib/messaging/service.ts)ではなくここに置くのは、
 * クライアントコンポーネント(MessagesInbox)からも同じ値を参照するため。
 * 数値を2箇所に書くと、片方だけ変えたときに「50件読んだつもりが40件」
 * のような静かなズレになる。
 */
export const MESSAGE_PAGE_SIZE = 50;
