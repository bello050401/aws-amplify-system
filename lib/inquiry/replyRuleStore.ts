import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { unwrapList, unwrapWriteRequired } from "@/lib/amplify/listAll";
import type { MessageChannel } from "@/lib/messaging/types";
import type { ReplyRuleCategory, ReplyRuleRecord } from "./replyRuleSelection";

/**
 * 2026-09-03 指示書 §16/§26: 返信ルールの読み書き。
 *
 * ── 削除はソフトデリート ────────────────────────────────────────
 *
 * §26が推奨している。加えて、AI処理ログが「この返信でどのルールを
 * 使ったか」をidで参照するため、物理削除すると**過去のログから根拠が
 * 消える**。監査できないログは無いのと同じなので、行は残す。
 */

interface ReplyRuleRow {
  id: string;
  title: string;
  category: ReplyRuleCategory;
  description?: string | null;
  conditions?: string | null;
  instruction: string;
  priority?: number | null;
  enabled?: boolean | null;
  channelScope?: unknown;
  productCategoryScope?: unknown;
  version?: number | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * a.json() は書いたときの型そのままで返るとは限らない(AppSync経由だと
 * 文字列で返ることがある)。両方を受ける — lib/inquiry/draftStore.ts の
 * parseJson と同じ理由。
 */
function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toRecord(row: ReplyRuleRow): ReplyRuleRecord {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description ?? null,
    conditions: row.conditions ?? null,
    instruction: row.instruction,
    priority: row.priority ?? 100,
    enabled: row.enabled ?? true,
    channelScope: parseStringArray(row.channelScope) as MessageChannel[],
    productCategoryScope: parseStringArray(row.productCategoryScope),
    version: row.version ?? 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 有効なルールを全件読む。件数は運用上多くても数十件なので全件で問題ない
 * (§41「無駄な全件fetch禁止」は一覧画面の話。ここはAIへ渡す前の母集団で、
 *  絞り込みは selectReplyRules が行う)。
 */
export async function listActiveReplyRules(): Promise<ReplyRuleRecord[]> {
  const rows = unwrapList(
    await serverDataClient.models.ReplyRule.list({ ...inventoryAuthMode, limit: 500 }),
    "返信ルール",
  ) as unknown as ReplyRuleRow[];
  return rows.filter((r) => !r.deletedAt).map(toRecord);
}

/** 管理画面の一覧。無効なものも出す(有効/無効を切り替えるため)。 */
export async function listReplyRulesForAdmin(): Promise<ReplyRuleRecord[]> {
  const rows = unwrapList(
    await serverDataClient.models.ReplyRule.list({ ...inventoryAuthMode, limit: 500 }),
    "返信ルール",
  ) as unknown as ReplyRuleRow[];
  return rows
    .filter((r) => !r.deletedAt)
    .map(toRecord)
    .sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title, "ja"));
}

export interface ReplyRuleInput {
  title: string;
  category: ReplyRuleCategory;
  description: string | null;
  conditions: string | null;
  instruction: string;
  priority: number;
  enabled: boolean;
  channelScope: MessageChannel[];
  productCategoryScope: string[];
}

export async function createReplyRule(input: ReplyRuleInput, who: string | null): Promise<ReplyRuleRecord> {
  const row = unwrapWriteRequired(
    await serverDataClient.models.ReplyRule.create(
      {
        title: input.title,
        category: input.category,
        description: input.description ?? undefined,
        conditions: input.conditions ?? undefined,
        instruction: input.instruction,
        priority: input.priority,
        enabled: input.enabled,
        channelScope: input.channelScope,
        productCategoryScope: input.productCategoryScope,
        version: 1,
        createdBy: who ?? undefined,
        updatedBy: who ?? undefined,
      },
      inventoryAuthMode,
    ),
    "返信ルールの作成",
  ) as unknown as ReplyRuleRow;
  return toRecord(row);
}

/**
 * 更新すると version が +1 される。どの版で生成した返信なのかを
 * AI処理ログから追えるようにするため(§16-1 の version フィールド)。
 */
export async function updateReplyRule(id: string, input: ReplyRuleInput, who: string | null): Promise<ReplyRuleRecord> {
  const current = unwrapList(
    await serverDataClient.models.ReplyRule.list({ ...inventoryAuthMode, limit: 500 }),
    "返信ルール",
  ) as unknown as ReplyRuleRow[];
  const found = current.find((r) => r.id === id);
  const nextVersion = (found?.version ?? 1) + 1;

  const row = unwrapWriteRequired(
    await serverDataClient.models.ReplyRule.update(
      {
        id,
        title: input.title,
        category: input.category,
        description: input.description ?? undefined,
        conditions: input.conditions ?? undefined,
        instruction: input.instruction,
        priority: input.priority,
        enabled: input.enabled,
        channelScope: input.channelScope,
        productCategoryScope: input.productCategoryScope,
        version: nextVersion,
        updatedBy: who ?? undefined,
      },
      inventoryAuthMode,
    ),
    "返信ルールの更新",
  ) as unknown as ReplyRuleRow;
  return toRecord(row);
}

export async function setReplyRuleEnabled(id: string, enabled: boolean, who: string | null): Promise<void> {
  unwrapWriteRequired(
    await serverDataClient.models.ReplyRule.update({ id, enabled, updatedBy: who ?? undefined }, inventoryAuthMode),
    "返信ルールの有効/無効切替",
  );
}

/** ソフトデリート(§26)。物理削除しない理由はファイル冒頭のコメント参照。 */
export async function softDeleteReplyRule(id: string, who: string | null): Promise<void> {
  unwrapWriteRequired(
    await serverDataClient.models.ReplyRule.update(
      { id, deletedAt: new Date().toISOString(), deletedBy: who ?? undefined },
      inventoryAuthMode,
    ),
    "返信ルールの削除",
  );
}
