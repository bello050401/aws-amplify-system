import { createHash } from 'node:crypto';

/** Historical answers are examples, never current product facts or new policies. */
export const REPLY_HISTORY_VERSION = 1;
export const HISTORY_TOPICS = {
  RECEIPT: /領収書|但し書き|宛名|インボイス/,
  PAYMENT: /請求書|振込|振り込|支払|決済/,
  NEGOTIATION: /値下|値引|お安く|価格|金額|おいくら|割引/,
  DELIVERY: /発送|配送|送料|納品|搬入|お届け|設置|着日/,
  SIZE: /寸法|サイズ|幅|奥行|高さ|座面高|何センチ/,
  CONDITION: /傷|キズ|汚れ|状態|補修|欠品|破れ/,
  STOCK: /在庫|購入でき|購入可能|売り切れ|取置|取り置|まとめて|セット/,
  VISIT: /来店|訪問|伺|見に行|実物|営業時間|定休日/,
  RETURN: /返品|キャンセル|返金|保証/,
  SPEC: /素材|材質|型番|ブランド|カラー|色|重量|耐荷重/,
} as const;
export type HistoryTopic = keyof typeof HISTORY_TOPICS;
export type HistoricalReply = {
  id: string; conversationId: string; sourceId: string; channel: string;
  sourceUrl: string | null; sourceHash: string; sentAt: string;
  topics: HistoryTopic[]; question: string; reply: string; version: number;
};
export type HistoryMessage = { id: string; body: string; sentAt: string;
  direction: 'INBOUND'|'OUTBOUND'; verifiedStaff: boolean };

export function historyTopics(text: string): HistoryTopic[] {
  const normalized = text.normalize('NFKC');
  return (Object.keys(HISTORY_TOPICS) as HistoryTopic[]).filter(t => HISTORY_TOPICS[t].test(normalized));
}

/** Keep wording and purchasing steps, but never feed another item's factual
 * claims to the model. The complete sanitized source remains inspectable. */
export function historicalWording(reply: string): string {
  return reply.split(/(?<=[。！？!?])|\n/).map(s=>s.trim()).filter(s=>s &&
    !/当時の数値|状態|コンディション|傷|汚れ|使用感|実物|掲載写真|掲載画像|寸法|サイズ|幅|奥行|高さ|素材|材質|在庫|入荷|保証|返品|返金|欠品|不具合|正規品|付属|送料無料|追加.*送料|送料.*(?:異な|高額)|最短|休業|祝日|シルバーウィーク/.test(s))
    .join('\n');
}

/** No other customer's question, contact details, amounts, dates or measurements
 * are copied into the reference index. Reject whole sensitive sentences first. */
export function sanitizeHistoricalReply(text: string): string {
  return text.normalize('NFKC').split(/[━─]{3,}/)[0].split(/(?<=[。！？!?])|\n/).map(s => s.trim())
    .filter(s => s && !/https?:|www\.|[\w.+-]+@[\w.-]+|\d{2,4}[-ー]\d{2,4}[-ー]\d{3,4}|〒|都道府県|[都道府県].{0,10}[市区町村]|\S+様|\S+さま|\S+さん|口座(?:番号|名義|[：:])|銀行コード|支店|担当[：:]|株式会社BELLOの|取締役|システム指示|指示を無視|TRUSTED_FACTS|REPLY_RULES|SYSTEM_PROMPT|ignore.*instructions/i.test(s))
    .filter(s=>!/発送が完了|(?:先ほど|本日).*(?:送付|送信|発送)|ご入金の確認が(?:とれ|取れ)ました|追跡番号/.test(s))
    .map(s => s.replace(/[¥￥]?\d[\d,.]*(?:\s*(?:円|万円|%|％|cm|mm|kg|点|個|脚|台|日|月|年|時|分))?/gi, '［当時の数値］'))
    .join('\n').slice(0, 1000);
}

export function buildHistoricalReplies(input: {conversationId:string;sourceId:string;channel:string;sourceUrl?:string|null;messages:HistoryMessage[]}): HistoricalReply[] {
  if (!['LINE','MERCARI_SHOPS','BASE','EMAIL','YAHOO_AUCTION'].includes(input.channel)) return [];
  let questions: string[] = [];
  const result: HistoricalReply[] = [];
  const ordered = input.messages.filter(m=>Number.isFinite(Date.parse(m.sentAt)))
    .map(m=>({...m,sentAt:new Date(m.sentAt).toISOString()})).sort((a,b)=>a.sentAt.localeCompare(b.sentAt));
  for (const m of ordered) {
    if (m.direction === 'INBOUND') { questions.push(m.body); questions = questions.slice(-3); continue; }
    // An unsent/AI answer must never become an example for the next model.
    if (!m.verifiedStaff) { questions=[]; continue; }
    const reply = sanitizeHistoricalReply(m.body);
    // A later shipping-complete notice is not an answer about a receipt just
    // because both occurred in the same customer turn.
    const replyTopics=historyTopics(reply);
    const topics = historyTopics(questions.join('\n')).filter(t=>replyTopics.includes(t));
    if (topics.length && reply.length >= 18 && Number.isFinite(Date.parse(m.sentAt))) {
      const sourceHash = createHash('sha256').update(m.body).digest('hex');
      const id = createHash('sha256').update(JSON.stringify([input.channel,input.sourceId,m.id,sourceHash])).digest('hex');
      result.push({id,conversationId:input.conversationId,sourceId:input.sourceId,channel:input.channel,
        sourceUrl: safeHistoryUrl(input.sourceUrl),sourceHash,sentAt:m.sentAt,
        topics,question:topics.map(t=>HISTORY_LABELS[t]).join('・')+'についての問い合わせ',reply,version:REPLY_HISTORY_VERSION});
    }
    // Consecutive staff messages remain attached to the same customer turn.
    if (ordered[ordered.indexOf(m)+1]?.direction === 'INBOUND') questions=[];
  }
  return result;
}

export const HISTORY_LABELS: Record<HistoryTopic,string> = {
  RECEIPT:'領収書',PAYMENT:'支払い方法',NEGOTIATION:'価格相談',DELIVERY:'配送・送料',SIZE:'寸法',
  CONDITION:'状態',STOCK:'在庫・数量',VISIT:'来店',RETURN:'返品・キャンセル',SPEC:'商品仕様',
};

export function safeHistoryUrl(value?:string|null):string|null {
  if (!value) return null;
  try {
    const u=new URL(value);
    const mercari=u.origin==='https://mercari-shops.com' && /^\/seller\/shops\/[A-Za-z0-9_-]+\/inquiries\/[A-Za-z0-9_-]+$/.test(u.pathname);
    const line=u.origin==='https://chat.line.biz' && /^\/U[a-f0-9]{32}\/chat\/U[a-f0-9]{32}$/.test(u.pathname);
    return mercari||line ? u.origin+u.pathname : null;
  } catch {return null;}
}

/** Cover distinct questions first. A short follow-up still searches the complete
 * current customer context. Same-conversation and future answers are excluded. */
export function selectHistoricalReplies(rows:HistoricalReply[],input:{text:string;channel:string;conversationId:string;excludeSourceIds?:string[];before?:string}):HistoricalReply[] {
  const topics=historyTopics(input.text),excluded=new Set(input.excludeSourceIds??[]),seen=new Set<string>();
  const candidates=rows.filter(r=>r.version===REPLY_HISTORY_VERSION && r.channel===input.channel && r.conversationId!==input.conversationId &&
    !excluded.has(r.sourceId) && (!input.before||r.sentAt<input.before) && r.topics.some(t=>topics.includes(t)))
    .filter(r=>{if(seen.has(r.id))return false;seen.add(r.id);return true;})
    .sort((a,b)=>{
      const score=(r:HistoricalReply)=>r.topics.filter(t=>topics.includes(t)).length*10+(r.channel===input.channel?3:0);
      return score(b)-score(a)||b.sentAt.localeCompare(a.sentAt)||a.id.localeCompare(b.id);
    });
  const selected:HistoricalReply[]=[];
  for(const topic of topics){
    if(selected.some(r=>r.topics.includes(topic)))continue;
    const next=candidates.find(r=>r.topics.includes(topic)&&!selected.some(s=>s.sourceId===r.sourceId));
    if(next)selected.push(next);
    if(selected.length===4)break;
  }
  for(const r of candidates){if(selected.length===4)break;if(!selected.some(s=>s.sourceId===r.sourceId))selected.push(r);}
  return selected;
}
