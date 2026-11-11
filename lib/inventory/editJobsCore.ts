import { randomUUID, createHash } from "node:crypto";
import {
  GetCommand,
  UpdateCommand,
  QueryCommand,
  BatchWriteCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createInventoryPersistence } from "./categoryPersistenceCore";
import { inventoryCategoryIds } from "./categories";
import {
  transformInventoryEdit,
  validateEditRules,
  validateName,
  type InventoryEditRules,
} from "./editTransform";
import {
  applyInventoryDiff,
  inventoryDiff,
  inventoryFieldValue,
  moveInventoryHistory,
  readEditHistory,
  sameValue,
  type FieldDelta,
} from "./reversibleHistory";
import { sendInventoryTransaction } from "./historyTransaction";
import { withHumanEdits } from "./humanEdits";
import { parseCustomFields } from "./customFieldsCodecCore";
import {validateCustomFieldChanges,type InlineCustomDefinition} from './customFieldEdits';

type Row = Record<string, unknown>;
export type EditJobMode = "edit" | "undo" | "redo";
export type EditRowState =
  "CHANGE" | "UNCHANGED" | "ERROR" | "SAVED" | "CONFLICT" | "FAILED";
export interface EditPreviewRow {
  id: string;
  name: string;
  sku: string;
  state: EditRowState;
  before: Row;
  after: Row;
  delta: FieldDelta[];
  updatedAt: string;
  revision: number;
  error?: string;
  undoCount: number;
  redoCount: number;
  history?: ReturnType<typeof readEditHistory>;
  resultUpdatedAt?: string;
}
export interface EditJob {
  id: string;
  owner: string;
  actor: string;
  createdAt: string;
  expiresAt: number;
  ttl: number;
  mode: EditJobMode;
  rules?: InventoryEditRules;
  targetOperationId?: string;
  ids: string[];
  state: "PREPARING" | "READY" | "APPLYING" | "DONE" | "CANCELLED" | "FAILED";
  cancelled?: boolean;
  count: number;
  counts: Partial<Record<EditRowState, number>>;
  error?: string;
  leaseToken?: string;
}
const RETRY_DAYS = 7,
  PREVIEW_SECONDS = 3600,
  MAX_TARGETS = 1000;
const key = (id: string, sk = "META") => ({ pk: "EDIT#" + id, sk });
const uuid = (id: string) => /^[a-f0-9-]{36}$/i.test(id);
const transient = (error: unknown) =>
  [
    "ProvisionedThroughputExceededException",
    "ThrottlingException",
    "RequestLimitExceeded",
    "InternalServerError",
    "TimeoutError",
  ].includes((error as Error)?.name);
export async function boundedMap<T, R>(
  items: readonly T[],
  width: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        result[i] = await run(items[i], i);
      }
    }),
  );
  return result;
}
/** Dedicated temporary records contain IDs and changed fields, never inventory snapshots.
 * The item result and inventory delta commit together. A lost HTTP/SQS response is safe to retry. */
export function createInventoryEditJobs(p: {
  db: DynamoDBDocumentClient;
  table: (model: string) => string;
  jobsTable: string;
  readBatch: (ids: string[]) => Promise<Map<string, Row>>;
  enqueue: (id: string) => Promise<void>;
  authorizeWorker?: (owner: string) => Promise<boolean>;
  verifyRestoredImages?: (before: unknown, after: unknown) => Promise<void>;
  loadCustomDefinitions?: () => Promise<InlineCustomDefinition[]>;
  now?: () => number;
}) {
  const { db } = p,
    now = p.now ?? Date.now,
    store = createInventoryPersistence(db, p.table);
  const categoryChecks = new Map<string, Promise<void>>();
  async function validateLocation(before: Row, after: Row) {
    if (sameValue(before.locationId, after.locationId) || !after.locationId) return;
    const record = (await db.send(new GetCommand({TableName:p.table("Location"),Key:{id:after.locationId},ConsistentRead:true}))).Item;
    if (!record || record.isActive === false || record.deletedAt) throw Error("保管場所が無効です。選び直してください。");
  }
  const validateCategories = (ids: string[]) => {
    const key = JSON.stringify([...ids].sort());
    let checked = categoryChecks.get(key);
    if (!checked) {
      checked = store.validateCategoryIds(ids);
      categoryChecks.set(key, checked);
    }
    return checked;
  };
  const get = async (id: string) =>
    (
      await db.send(
        new GetCommand({
          TableName: p.jobsTable,
          Key: key(id),
          ConsistentRead: true,
        }),
      )
    ).Item as EditJob | undefined;
  const requireJob = async (id: string, owner?: string) => {
    if (!uuid(id)) throw Error("操作IDを確認してください。");
    const job = await get(id);
    if (!job || job.ttl <= now() / 1000)
      throw Error("操作結果の保存期間が終了しています。");
    if (owner && job.owner !== owner)
      throw Error("この操作を参照する権限がありません。");
    return job;
  };
  async function rows(id: string) {
    const all: EditPreviewRow[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: p.jobsTable,
          KeyConditionExpression: "pk=:p AND begins_with(sk,:r)",
          ExpressionAttributeValues: { ":p": key(id).pk, ":r": "ROW#" },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      all.push(...(page.Items ?? []).map((r) => r.row as EditPreviewRow));
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return all;
  }
  async function writeRows(job: EditJob, values: EditPreviewRow[]) {
    for (let offset = 0; offset < values.length; offset += 25) {
      let pending = values
        .slice(offset, offset + 25)
        .map((row) => ({
          PutRequest: {
            Item: { ...key(job.id, "ROW#" + row.id), row, ttl: job.ttl },
          },
        }));
      for (let attempt = 0; pending.length; attempt++) {
        if (attempt === 5)
          throw Error("プレビューの保存を確認できません。再試行してください。");
        const response = await db.send(
          new BatchWriteCommand({ RequestItems: { [p.jobsTable]: pending } }),
        );
        pending = (response.UnprocessedItems?.[p.jobsTable] ??
          []) as typeof pending;
        if (pending.length)
          await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
  }
  async function summarize(job: EditJob, state: EditJob["state"]) {
    const result = await rows(job.id),
      counts: EditJob["counts"] = {};
    for (const r of result) counts[r.state] = (counts[r.state] ?? 0) + 1;
    await db.send(
      new UpdateCommand({
        TableName: p.jobsTable,
        Key: key(job.id),
        UpdateExpression: "SET #s=:s, counts=:c",
        ConditionExpression: "leaseToken=:lease",
        ExpressionAttributeNames: { "#s": "state" },
        ExpressionAttributeValues: {
          ":s": state,
          ":c": counts,
          ":lease": job.leaseToken,
        },
      }),
    );
    return { ...job, state, counts };
  }
  async function create(
    input: {
      id: string;
      ids: string[];
      mode: EditJobMode;
      rules?: InventoryEditRules;
      targetOperationId?: string;
    },
    owner: string,
    actor: string,
  ) {
    if (
      !uuid(input.id) ||
      !["edit", "undo", "redo"].includes(input.mode) ||
      !Array.isArray(input.ids) ||
      !input.ids.length ||
      input.ids.length > MAX_TARGETS ||
      input.ids.some((id) => typeof id !== "string" || !id || id.length > 128)
    )
      throw Error("対象商品と操作を確認してください（最大1,000件）。");
    if (input.mode === "edit") validateEditRules(input.rules);
    const ids = [...new Set(input.ids)].sort(),
      fingerprint = createHash("sha256")
        .update(JSON.stringify({ ...input, ids }))
        .digest("hex");
    const old = await get(input.id);
    if (old) {
      await requireJob(input.id, owner);
      if ((old as unknown as Row).fingerprint !== fingerprint)
        throw Error("同じ操作IDで内容を変更できません。");
      if (old.state === "PREPARING") await p.enqueue(old.id);
      return old;
    }
    const job: EditJob = {
      id: input.id,
      owner,
      actor,
      createdAt: new Date(now()).toISOString(),
      expiresAt: Math.floor(now() / 1000) + PREVIEW_SECONDS,
      ttl: Math.floor(now() / 1000) + RETRY_DAYS * 86400,
      mode: input.mode,
      rules: input.rules,
      targetOperationId: input.targetOperationId,
      ids,
      state: "PREPARING",
      count: ids.length,
      counts: {},
    };
    // Shared operation metadata survives the temporary preview while any of the
    // two retained product deltas references it. No product snapshots are kept.
    const operation = {
      pk: "OP#" + job.id,
      sk: "META",
      id: job.id,
      ids,
      mode: job.mode,
      rules: job.rules,
      actor,
      owner,
      createdAt: job.createdAt,
      kind: "OPERATION",
    };
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: p.jobsTable,
                Item: { ...key(job.id), ...job, fingerprint, kind: "JOBS" },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: p.jobsTable,
                Item: operation,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      const existing = await get(job.id);
      if (
        !existing ||
        (existing as unknown as Row).fingerprint !== fingerprint ||
        existing.owner !== owner
      )
        throw error;
      return existing;
    }
    await p.enqueue(job.id);
    return job;
  }
  async function preview(job: EditJob, shouldYield: () => boolean, validateCustom: (before:Row,after:Row)=>Promise<void>) {
    const existing = await rows(job.id),
      done = new Set(existing.map((r) => r.id));
    for (let offset = 0; offset < job.ids.length; offset += 100) {
      if (shouldYield()) return await summarize(job, "PREPARING");
      if ((await requireJob(job.id)).cancelled)
        return await summarize(job, "CANCELLED");
      const ids = job.ids
          .slice(offset, offset + 100)
          .filter((id) => !done.has(id)),
        current = await p.readBatch(ids);
      const result = await boundedMap(ids, 8, async (id) => {
        const raw = current.get(id);
        const row: Row | undefined = raw
          ? { ...raw, categoryIds: inventoryCategoryIds(raw) }
          : undefined;
        const base: EditPreviewRow = {
          id,
          name: String(row?.name ?? id),
          sku: String(row?.sku ?? ""),
          state: "ERROR",
          before: {},
          after: {},
          delta: [],
          updatedAt: String(row?.updatedAt ?? ""),
          revision: Number(row?.revision ?? 0),
          undoCount: 0,
          redoCount: 0,
        };
        try {
          if (!row || row.deletedAt || row.listingPartition === "MERGED")
            throw Error("対象商品が見つかりません。");
          if (row.outboundBatchId)
            throw Error("出庫処理中です。完了後に再確認してください。");
          const history = readEditHistory(row);
          base.undoCount = history.cursor;
          base.redoCount = history.entries.length - history.cursor;
          const after: Row =
            job.mode === "edit"
              ? {
                  ...row,
                  ...transformInventoryEdit(
                    {
                      ...row,
                      name: String(row.name),
                      categoryIds: inventoryCategoryIds(row),
                      locationId: row.locationId,
                      customFields: row.customFields,
                    },
                    job.rules!,
                  ).after,
                }
              : moveInventoryHistory(row, job.mode, job.targetOperationId).row;
          if (
            row.outboundArrivalBatchId &&
            (!sameValue(row.categoryIds, after.categoryIds) || !sameValue(row.locationId, after.locationId) || !sameValue(row.quantity,after.quantity))
          )
            throw Error("到着確認待ちのためカテゴリ・保管場所・数量を変更できません。");
          await validateLocation(row, after);
          await validateCustom(row, after);
          base.delta = inventoryDiff(row, after);
          const fields = [...new Set(base.delta.map((d) => d.field))];
          const displayValue = (record: Row, field: string) => {
            const saved = inventoryFieldValue(record, field);
            return saved.present ? saved.value : null;
          };
          // Display only changed fields. The reversible delta is the canonical apply payload.
          base.before = Object.fromEntries(
            fields.map((f) => [f, displayValue(row, f)]),
          );
          base.after = Object.fromEntries(
            fields.map((f) => [f, displayValue(after, f)]),
          );
          if (job.mode === "edit" && !base.delta.length)
            base.state = "UNCHANGED";
          else {
            validateName(after.name);
            await validateCategories(
              inventoryCategoryIds(after).filter(
                (id) => !inventoryCategoryIds(row).includes(id),
              ),
            );
            base.state = "CHANGE";
          }
        } catch (error) {
          base.error =
            error instanceof Error
              ? error.message
              : "変更内容を確認できません。";
        }
        return base;
      });
      await writeRows(job, result);
    }
    return summarize(job, "READY");
  }
  async function applyOne(
    job: EditJob,
    preview: EditPreviewRow,
    current: Row | undefined,
    validateCustom: (before:Row,after:Row)=>Promise<void>,
  ) {
    if (preview.state !== "CHANGE") return;
    const receipt = () =>
      db.send(
        new GetCommand({
          TableName: p.jobsTable,
          Key: key(job.id, "ROW#" + preview.id),
          ConsistentRead: true,
        }),
      );
    try {
      if (
        !current ||
        current.deletedAt ||
        current.updatedAt !== preview.updatedAt ||
        Number(current.revision ?? 0) !== preview.revision
      )
        throw Error("CONFLICT");
      if (
        current.outboundBatchId ||
        (current.outboundArrivalBatchId &&
          preview.delta.some((d) =>
            ["categoryIds", "quantity", "locationId"].includes(d.field),
          ))
      )
        throw Error("CONFLICT");
      const normalized = {
          ...current,
          categoryIds: inventoryCategoryIds(current),
        },
        restored =
          job.mode === "edit"
            ? null
            : moveInventoryHistory(normalized, job.mode, job.targetOperationId);
      const after: Row =
        restored?.row ?? applyInventoryDiff(normalized, preview.delta, "redo");
      if (!sameValue(inventoryDiff(normalized, after), preview.delta))
        throw Error("CONFLICT");
      validateName(after.name);
      await validateLocation(current, after);
      await validateCustom(current, after);
      if (restored && preview.delta.some(delta => delta.field === 'images')) {
        if (!p.verifyRestoredImages) throw Error('画像の復元確認が設定されていません。管理者に確認してください。');
        await p.verifyRestoredImages(current.images, after.images);
      }
      const assigned = inventoryCategoryIds(after).filter(
        (id) => !inventoryCategoryIds(current).includes(id),
      );
      await validateCategories(assigned);
      const changed = [
          ...new Set(
            preview.delta.map((d) =>
              d.field.startsWith("customFields.") ? "customFields" : d.field,
            ),
          ),
        ],
        stamp = new Date(
          Math.max(now(), Date.parse(String(current.updatedAt)) + 1),
        ).toISOString();
      const patch: Row = {
        updatedAt: stamp,
        listUpdatedAt: stamp,
        updatedBy: job.actor,
      };
      for (const field of changed) patch[field] = after[field];
      if (changed.includes("categoryIds"))
        patch.categoryId = inventoryCategoryIds(after)[0];
      const custom = parseCustomFields(current.customFields) ?? {};
      patch.customFields = JSON.stringify(
        withHumanEdits(
          current,
          patch,
          custom,
          parseCustomFields(after.customFields) ?? {},
        ),
      );
      const names: Record<string, string> = {},
        values: Row = { ":v": current.updatedAt, ":false": false },
        sets: string[] = [],
        removes: string[] = [];
      for (const [field, value] of Object.entries(patch)) {
        const i = Object.keys(names).length,
          n = "#e" + i,
          v = ":e" + i;
        names[n] = field;
        if (value === undefined) removes.push(n);
        else {
          sets.push(n + "=" + v);
          values[v] = value;
        }
      }
      delete values[":false"];
      const saved = {
        ...preview,
        state: "SAVED" as const,
        resultUpdatedAt: stamp,
      };
      const writes = [
        // Each item has its own atomic receipt and revision check. Checking the
        // same job META in every transaction creates a hot transactional lock
        // across otherwise independent products. Cancellation/lease is checked
        // before dispatching each bounded batch; in-flight items may complete.
        {
          Update: {
            TableName: p.table("Inventory"),
            Key: { id: preview.id },
            UpdateExpression:
              "SET " +
              sets.join(",") +
              (removes.length ? " REMOVE " + removes.join(",") : ""),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ConditionExpression:
              "updatedAt=:v AND attribute_not_exists(outboundBatchId)",
          },
        },
        ...store.categoryLinkChanges(
          preview.id,
          inventoryCategoryIds(current),
          inventoryCategoryIds(after),
          stamp,
        ),
        ...assigned.map((id) => ({
          ConditionCheck: {
            TableName: p.table("Category"),
            Key: { id },
            ConditionExpression:
              "attribute_exists(id) AND (attribute_not_exists(isActive) OR isActive=:active)",
            ExpressionAttributeValues: { ":active": true },
          },
        })),
        {
          Put: {
            TableName: p.jobsTable,
            Item: {
              ...key(job.id, "ROW#" + preview.id),
              row: saved,
              ttl: job.ttl,
            },
            ConditionExpression: "#r.#s=:pending",
            ExpressionAttributeNames: { "#r": "row", "#s": "state" },
            ExpressionAttributeValues: { ":pending": "CHANGE" },
          },
        },
      ];
      await sendInventoryTransaction(
        db,
        { TransactItems: writes },
        {
          source:
            job.mode === "edit"
              ? "一覧一括編集"
              : job.mode === "undo"
                ? "戻る"
                : "進む",
          actor: job.actor,
          operationId: job.id,
          before: new Map([[preview.id, current]]),
          ...(restored
            ? {
                restore: new Map([
                  [
                    preview.id,
                    {
                      state: restored.state,
                      revision: Number(restored.row.revision),
                    },
                  ],
                ]),
              }
            : {}),
        },
      );
    } catch (error) {
      // Transaction may have committed before the transport failed. Never overwrite its receipt.
      const stored = (await receipt()).Item?.row as EditPreviewRow | undefined;
      if (stored?.state === "SAVED") return;
      if ((await requireJob(job.id)).cancelled) return;
      const reasons =
        (error as { CancellationReasons?: { Code?: string }[] })
          .CancellationReasons ?? [];
      if (
        transient(error) ||
        reasons.some((r) =>
          [
            "TransactionConflict",
            "ThrottlingError",
            "ProvisionedThroughputExceeded",
          ].includes(r.Code ?? ""),
        )
      )
        throw error;
      const conflict =
        (error as Error)?.message === "CONFLICT" ||
        (error as Error)?.name === "TransactionCanceledException";
      await db.send(
        new UpdateCommand({
          TableName: p.jobsTable,
          Key: key(job.id, "ROW#" + preview.id),
          UpdateExpression: "SET #r.#s=:s,#r.#e=:e",
          ConditionExpression: "#r.#s=:pending",
          ExpressionAttributeNames: {
            "#r": "row",
            "#s": "state",
            "#e": "error",
          },
          ExpressionAttributeValues: {
            ":pending": "CHANGE",
            ":s": conflict ? "CONFLICT" : "FAILED",
            ":e": conflict
              ? "他の操作で更新されています。最新状態で再プレビューしてください。"
              : error instanceof Error
                ? error.message
                : "保存できませんでした。",
          },
        }),
      );
    }
  }
  async function run(id: string, shouldYield: () => boolean = () => false) {
    // One fresh master read per worker run, shared across rows. Apply/restore
    // revalidates independently of preview; inactive or changed definitions fail closed.
    let definitions:Promise<InlineCustomDefinition[]>|undefined;
    const validateCustom=async(before:Row,after:Row)=>{
      const fields=inventoryDiff(before,after).filter(d=>d.field.startsWith('customFields.'));
      if(!fields.length)return;
      if(!p.loadCustomDefinitions)throw Error('追加項目の検証が設定されていません。管理者に確認してください。');
      definitions??=p.loadCustomDefinitions();
      const values=parseCustomFields(after.customFields)??{};
      validateCustomFieldChanges(Object.fromEntries(fields.map(d=>{const key=d.field.slice('customFields.'.length);return [key,values[key]??null];})),await definitions);
    };
    categoryChecks.clear();
    let job = await requireJob(id);
    if (!["PREPARING", "APPLYING"].includes(job.state)) return job;
    const token = randomUUID();
    try {
      await db.send(
        new UpdateCommand({
          TableName: p.jobsTable,
          Key: key(id),
          UpdateExpression: "SET leaseToken=:token,leaseExpires=:expires",
          ConditionExpression:
            "attribute_not_exists(leaseExpires) OR leaseExpires<:now",
          ExpressionAttributeValues: {
            ":token": token,
            ":expires": now() + 240000,
            ":now": now(),
          },
        }),
      );
    } catch (error) {
      if ((error as Error).name === "ConditionalCheckFailedException")
        throw Object.assign(Error("作業中です。完了をお待ちください。"), {
          name: "InventoryEditLeaseBusy",
        });
      throw error;
    }
    job = { ...(await requireJob(id)), leaseToken: token };
    try {
      if (p.authorizeWorker && !(await p.authorizeWorker(job.owner))) {
        await db.send(
          new UpdateCommand({
            TableName: p.jobsTable,
            Key: key(id),
            UpdateExpression: "SET #s=:failed,#e=:error",
            ConditionExpression: "leaseToken=:lease",
            ExpressionAttributeNames: { "#s": "state", "#e": "error" },
            ExpressionAttributeValues: {
              ":lease": token,
              ":failed": "FAILED",
              ":error": "実行者の編集権限が失効しています。",
            },
          }),
        );
        return { ...job, state: "FAILED" as const };
      }
      if (job.cancelled) return await summarize(job, "CANCELLED");
      if (job.state === "PREPARING") return await preview(job, shouldYield, validateCustom);
      if (job.state !== "APPLYING") return job;
      const pending = (await rows(id)).filter((r) => r.state === "CHANGE");
      for (let offset = 0; offset < pending.length; offset += 50) {
        if (shouldYield()) return await summarize(job, "APPLYING");
        const live = await requireJob(id);
        if (live.cancelled)
          return await summarize(job, "CANCELLED");
        if (live.leaseToken !== token || live.state !== 'APPLYING') throw Error('操作の実行状態が更新されています。結果を再確認してください。');
        const batch = pending.slice(offset, offset + 50),
          current = await p.readBatch(batch.map((r) => r.id));
        await boundedMap(batch, 8, (row) =>
          applyOne(job, row, current.get(row.id),validateCustom),
        );
        await summarize(job, "APPLYING");
      }
      return await summarize(job, "DONE");
    } finally {
      await db
        .send(
          new UpdateCommand({
            TableName: p.jobsTable,
            Key: key(id),
            UpdateExpression: "REMOVE leaseToken,leaseExpires",
            ConditionExpression: "leaseToken=:lease",
            ExpressionAttributeValues: { ":lease": token },
          }),
        )
        .catch(() => {});
    }
  }
  async function apply(id: string, owner: string) {
    const job = await requireJob(id, owner);
    if (job.state === "APPLYING") {
      await p.enqueue(id);
      return job;
    }
    if (job.state === "DONE") return job;
    if (job.state !== "READY" || job.expiresAt <= now() / 1000)
      throw Error("最新状態で再プレビューしてください。");
    if (job.counts.ERROR)
      throw Error("エラー商品を対象から外して再プレビューしてください。");
    if (!job.counts.CHANGE) throw Error("変更する商品がありません。");
    await db.send(
      new UpdateCommand({
        TableName: p.jobsTable,
        Key: key(id),
        UpdateExpression: "SET #s=:s",
        ConditionExpression: "#s=:ready AND attribute_not_exists(cancelled)",
        ExpressionAttributeNames: { "#s": "state" },
        ExpressionAttributeValues: { ":s": "APPLYING", ":ready": "READY" },
      }),
    );
    await p.enqueue(id);
    return { ...job, state: "APPLYING" as const };
  }
  async function cancel(id: string, owner: string) {
    const job = await requireJob(id, owner);
    if (["DONE", "CANCELLED", "FAILED"].includes(job.state)) return;
    await db.send(
      new UpdateCommand({
        TableName: p.jobsTable,
        Key: key(id),
        UpdateExpression: "SET cancelled=:yes",
        ExpressionAttributeValues: { ":yes": true },
      }),
    );
    // READY has no worker holding a lease. Stop it explicitly; a racing apply is
    // still rejected by its cancelled condition, never silently applied.
    try {
      await db.send(
        new UpdateCommand({
          TableName: p.jobsTable,
          Key: key(id),
          UpdateExpression: "SET #s=:stopped",
          ConditionExpression: "#s=:ready AND attribute_not_exists(leaseToken)",
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: {
            ":stopped": "CANCELLED",
            ":ready": "READY",
          },
        }),
      );
    } catch (error) {
      if ((error as Error).name !== "ConditionalCheckFailedException")
        throw error;
    }
    await p.enqueue(id);
  }
  async function status(id: string, owner: string, includeRunningRows = true) {
    const job = await requireJob(id, owner);
    // Polling needs progress counts, not the full preview for every second of a large job.
    return { job, rows: !includeRunningRows && ["PREPARING", "APPLYING"].includes(job.state) ? [] : await rows(id) };
  }
  async function operationTargets(id: string) {
    if (!uuid(id)) throw Error("操作IDを確認してください。");
    const operation = (
      await db.send(
        new GetCommand({
          TableName: p.jobsTable,
          Key: { pk: "OP#" + id, sk: "META" },
          ConsistentRead: true,
        }),
      )
    ).Item;
    if (!operation || operation.mode !== "edit")
      throw Error(
        "この保存は一括編集ではありません。商品ごとの「戻る・進む」を使用してください。",
      );
    return {
      id,
      ids: operation.ids as string[],
      actor: String(operation.actor),
      createdAt: String(operation.createdAt),
    };
  }
  async function failRun(id: string) {
    await requireJob(id);
    const result = await rows(id),
      counts: EditJob["counts"] = {};
    for (const row of result) counts[row.state] = (counts[row.state] ?? 0) + 1;
    await db.send(
      new UpdateCommand({
        TableName: p.jobsTable,
        Key: key(id),
        UpdateExpression: "SET #s=:failed,#e=:reason,counts=:counts",
        ConditionExpression:
          "(#s=:preparing OR #s=:applying) AND (attribute_not_exists(leaseExpires) OR leaseExpires<:now)",
        ExpressionAttributeNames: { "#s": "state", "#e": "error" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":preparing": "PREPARING",
          ":applying": "APPLYING",
          ":reason":
            "処理の再試行上限に達しました。保存済みの商品は保持されています。未保存の商品を再プレビューしてください。",
          ":counts": counts,
          ":now": now(),
        },
      }),
    );
  }
  return {
    create,
    run,
    apply,
    cancel,
    status,
    requireJob,
    rows,
    failRun,
    operationTargets,
  };
}
