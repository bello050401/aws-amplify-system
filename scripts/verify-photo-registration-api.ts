/**
 * 画像登録基盤 Phase 1 — 実行可能サービス層 (lib/photoRegistration/{service,
 * awsRepository,awsStorage}.ts) の合成試験。
 *
 * 実行:
 *   node scripts/qa/run-verify-with-server-only-noop.cjs scripts/verify-photo-registration-api.ts
 *
 * 【scripts/verify-photo-registration-contract.ts との違い】
 * あちらは types/validation/state.ts (永続化を一切知らない純粋関数) の
 * 契約試験。**このファイルは実際のservice.ts + awsRepository.ts +
 * awsStorage.tsを、外部IO (DynamoDB/S3のネットワーク呼び出し) だけを
 * 偽装して動かす。** 偽装したDynamoDB/S3クライアントは実際の
 * `@aws-sdk/lib-dynamodb` / `@aws-sdk/client-dynamodb` の Command クラスを
 * `instanceof` で判別し、ConditionExpression / UpdateExpression /
 * TransactWriteItemsを実際に評価する最小限のDynamoDB互換エンジンを内蔵する
 * — 「conditionsという文字列が存在すること」ではなく、「その条件が実際に
 * 競合を拒否すること」を確認する (docs/photo-registration-api-v1.md §7 の
 * 「示さないこと」を、このファイルの範囲では示せるようにする)。
 *
 * 【それでも証明できないこと】
 * - 実DynamoDBのTransactWriteItemsが持つ結果整合・リージョン間レイテンシ・
 *   実際のスロットリング挙動。
 * - 実S3の presigned URL 署名検証・実際のPUT/HEADレイテンシ・CORS。
 * - Cognito本体の認証・AppSyncの認可レイヤー (identity.claimsの形は
 *   AppSync Lambda direct resolverの実仕様通りだが、ここでは手で組み立てる)。
 * これらはstagingでの実AWS受入試験 (未実施) が必要。
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoPhotoRegistrationRepository } from "../lib/photoRegistration/awsRepository";
import { hexToBase64, S3PhotoStorage } from "../lib/photoRegistration/awsStorage";
import { PhotoRegistrationService } from "../lib/photoRegistration/service";
import { ConditionViolationError } from "../lib/photoRegistration/ports";
import type { TrustedClaims } from "../lib/photoRegistration/ports";
import type { PhotoErrorCode, PhotoResult } from "../lib/photoRegistration/types";

let passed = 0;
const failures: string[] = [];
const pendingTests: Promise<void>[] = [];
/**
 * 各testは独立した buildEnv() を使うため並行実行しても安全だが、
 * `test()` 自体は呼び出し即座に実行を開始する非同期関数であり、
 * その完了をここで確実に待たなければ集計 (passed/failures) が
 * 出揃う前に main() が結果を表示してしまう。そのため各Promiseを
 * pendingTests へ集約し、main() で Promise.all を待つ。
 */
function test(name: string, fn: () => Promise<void> | void): void {
  const promise = Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
    })
    .catch((error: unknown) => {
      failures.push(`${name}\n    ${(error as Error).stack ?? String(error)}`);
    });
  pendingTests.push(promise);
}

function expectOk<T>(result: PhotoResult<T>, label: string): T {
  assert.ok(result.ok, `${label}: expected ok, got ${result.ok ? "" : `${result.error} (${result.message})`}`);
  return result.value;
}
function expectErr(result: PhotoResult<unknown>, code: PhotoErrorCode, label: string): void {
  assert.equal(result.ok, false, `${label}: expected ${code}, got ok`);
  if (!result.ok) assert.equal(result.error, code, `${label}: expected ${code}, got ${result.error}`);
}

// ─────────────────────────────────────────────────────────────────────────
// 最小限のDynamoDB互換エンジン。ConditionExpression/UpdateExpressionの
// 対応範囲は awsRepository.ts が実際に生成する構文だけに絞る
// (汎用DynamoDBエミュレータを作るのが目的ではない)。
// ─────────────────────────────────────────────────────────────────────────

type Item = Record<string, unknown>;

function resolveName(raw: string, names?: Record<string, string>): string {
  return raw.startsWith("#") ? (names?.[raw] ?? raw) : raw;
}

function evalAtomic(atom: string, item: Item, names?: Record<string, string>, values?: Record<string, unknown>): boolean {
  const trimmed = atom.trim();
  let m: RegExpExecArray | null;
  if ((m = /^attribute_not_exists\(([^)]+)\)$/.exec(trimmed))) {
    const attr = resolveName(m[1], names);
    return item[attr] === undefined;
  }
  if ((m = /^attribute_exists\(([^)]+)\)$/.exec(trimmed))) {
    const attr = resolveName(m[1], names);
    return item[attr] !== undefined;
  }
  if ((m = /^(\S+)\s*<=\s*(:\S+)$/.exec(trimmed))) {
    const attr = resolveName(m[1], names);
    return (item[attr] as number | undefined) !== undefined && (item[attr] as number) <= (values?.[m[2]] as number);
  }
  if ((m = /^(\S+)\s*>=\s*(:\S+)$/.exec(trimmed))) {
    const attr = resolveName(m[1], names);
    return (item[attr] as number | undefined) !== undefined && (item[attr] as number) >= (values?.[m[2]] as number);
  }
  if ((m = /^(\S+)\s*<>\s*(:\S+)$/.exec(trimmed))) {
    const attr = resolveName(m[1], names);
    return item[attr] !== values?.[m[2]];
  }
  if ((m = /^(\S+)\s*=\s*(:\S+)$/.exec(trimmed))) {
    const attr = resolveName(m[1], names);
    return item[attr] === values?.[m[2]];
  }
  throw new Error(`FakeDynamoDB: unsupported condition atom: ${trimmed}`);
}

function evaluateCondition(expr: string | undefined, item: Item, names?: Record<string, string>, values?: Record<string, unknown>): boolean {
  if (!expr) return true;
  return expr.split(" OR ").some((group) => group.split(" AND ").every((atom) => evalAtomic(atom, item, names, values)));
}

function splitRespectingParens(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function applyUpdateExpression(item: Item, expr: string, names?: Record<string, string>, values?: Record<string, unknown>): Item {
  const next = { ...item };
  const [setPartRaw, removePartRaw] = expr.split(" REMOVE ");
  const setPart = setPartRaw.replace(/^SET\s+/, "");
  for (const clause of splitRespectingParens(setPart, ",")) {
    const eqIndex = clause.indexOf(" = ");
    const lhs = resolveName(clause.slice(0, eqIndex).trim(), names);
    const rhs = clause.slice(eqIndex + 3).trim();
    let ifNotExists: RegExpExecArray | null;
    if ((ifNotExists = /^if_not_exists\(([^,]+),\s*(.+)\)$/.exec(rhs))) {
      const existing = next[resolveName(ifNotExists[1].trim(), names)];
      next[lhs] = existing !== undefined ? existing : values?.[ifNotExists[2].trim()];
      continue;
    }
    const addMatch = /^(\S+)\s*\+\s*(:\S+)$/.exec(rhs);
    if (addMatch) {
      const base = (next[lhs] as number | undefined) ?? 0;
      next[lhs] = base + ((values?.[addMatch[2]] as number) ?? 0);
      continue;
    }
    if (rhs.startsWith(":")) {
      next[lhs] = values?.[rhs];
      continue;
    }
    throw new Error(`FakeDynamoDB: unsupported SET rhs: ${rhs}`);
  }
  if (removePartRaw) {
    for (const attr of removePartRaw.split(",")) delete next[resolveName(attr.trim(), names)];
  }
  return next;
}

class FakeTable {
  readonly items = new Map<string, Item>();
  private keyOf(key: { PK: string; SK: string }): string {
    return `${key.PK}|${key.SK}`;
  }
  get(key: { PK: string; SK: string }): Item | undefined {
    return this.items.get(this.keyOf(key));
  }
  putRaw(item: Item): void {
    this.items.set(this.keyOf(item as { PK: string; SK: string }), item);
  }
  deleteRaw(key: { PK: string; SK: string }): void {
    this.items.delete(this.keyOf(key));
  }
}

/** Inventory側は単一キー `{id}` (既存Inventoryモデルの想定、amplify/data/resource.tsとは独立したフェイク)。 */
class FakeInventoryTable {
  readonly items = new Map<string, Item>();
  get(id: string): Item | undefined {
    return this.items.get(id);
  }
  put(item: Item & { id: string }): void {
    this.items.set(item.id, item);
  }
}

class FakeDynamoDB {
  readonly photoTableName: string;
  readonly inventoryTableName: string;
  readonly table = new FakeTable();
  readonly inventoryTable = new FakeInventoryTable();

  constructor(photoTableName: string, inventoryTableName: string) {
    this.photoTableName = photoTableName;
    this.inventoryTableName = inventoryTableName;
  }

  private tableFor(name: string): FakeTable {
    if (name !== this.photoTableName) throw new Error(`FakeDynamoDB: unknown table ${name}`);
    return this.table;
  }

  asDocumentClient(): DynamoDBDocumentClient {
    const self = this;
    return {
      async send(command: unknown) {
        if (command instanceof GetCommand) {
          const input = command.input;
          if (input.TableName === self.inventoryTableName) {
            const item = self.inventoryTable.get((input.Key as { id: string }).id);
            return { Item: item };
          }
          const item = self.tableFor(input.TableName!).get(input.Key as { PK: string; SK: string });
          return { Item: item };
        }
        if (command instanceof QueryCommand) {
          return self.runQuery(command.input);
        }
        if (command instanceof TransactWriteCommand) {
          return self.runTransactWrite(command.input.TransactItems ?? []);
        }
        throw new Error(`FakeDynamoDB: unsupported command ${command?.constructor?.name}`);
      },
    } as unknown as DynamoDBDocumentClient;
  }

  private runQuery(input: import("@aws-sdk/lib-dynamodb").QueryCommandInput) {
    let all = [...this.table.items.values()];
    const values = input.ExpressionAttributeValues ?? {};
    if (input.IndexName === "GSI1") {
      all = all.filter((i) => i.GSI1PK === values[":pk"]);
      all.sort((a, b) => String(a.GSI1SK).localeCompare(String(b.GSI1SK)));
    } else if (input.IndexName === "GSI2") {
      all = all.filter((i) => i.GSI2PK === values[":pk"]);
      all.sort((a, b) => String(a.GSI2SK).localeCompare(String(b.GSI2SK)));
    } else {
      all = all.filter((i) => i.PK === values[":pk"]);
      if (input.KeyConditionExpression?.includes("begins_with")) {
        const pfx = values[":pfx"] as string;
        all = all.filter((i) => String(i.SK).startsWith(pfx));
      }
      all.sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
    }
    if (input.FilterExpression === "id = :id") all = all.filter((i) => i.id === values[":id"]);
    if (input.ScanIndexForward === false) all.reverse();

    let startIndex = 0;
    if (input.ExclusiveStartKey) {
      const idx = all.findIndex((i) => i.PK === input.ExclusiveStartKey!.PK && i.SK === input.ExclusiveStartKey!.SK);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }
    const page = all.slice(startIndex, input.Limit ? startIndex + input.Limit : undefined);
    const hasMore = input.Limit !== undefined && startIndex + input.Limit < all.length;
    return {
      Items: page,
      LastEvaluatedKey: hasMore ? { PK: page[page.length - 1].PK, SK: page[page.length - 1].SK } : undefined,
    };
  }

  private runTransactWrite(items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>) {
    const reasons: { Code: string }[] = [];
    let anyFailed = false;
    for (const ti of items) {
      if (ti.Put) {
        const table = ti.Put.TableName === this.inventoryTableName ? null : this.tableFor(ti.Put.TableName!);
        const existing = table ? table.get(ti.Put.Item as { PK: string; SK: string }) ?? {} : this.inventoryTable.get((ti.Put.Item as { id: string }).id) ?? {};
        const ok = evaluateCondition(ti.Put.ConditionExpression, existing, ti.Put.ExpressionAttributeNames, ti.Put.ExpressionAttributeValues);
        reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
        if (!ok) anyFailed = true;
      } else if (ti.Update) {
        const existing = this.tableFor(ti.Update.TableName!).get(ti.Update.Key as { PK: string; SK: string }) ?? {};
        const ok = evaluateCondition(ti.Update.ConditionExpression, existing, ti.Update.ExpressionAttributeNames, ti.Update.ExpressionAttributeValues);
        reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
        if (!ok) anyFailed = true;
      } else if (ti.Delete) {
        reasons.push({ Code: "None" });
      } else if (ti.ConditionCheck) {
        const existing =
          ti.ConditionCheck.TableName === this.inventoryTableName
            ? this.inventoryTable.get((ti.ConditionCheck.Key as { id: string }).id) ?? {}
            : this.tableFor(ti.ConditionCheck.TableName!).get(ti.ConditionCheck.Key as { PK: string; SK: string }) ?? {};
        const ok = evaluateCondition(ti.ConditionCheck.ConditionExpression, existing, ti.ConditionCheck.ExpressionAttributeNames, ti.ConditionCheck.ExpressionAttributeValues);
        reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
        if (!ok) anyFailed = true;
      }
    }
    if (anyFailed) {
      throw new TransactionCanceledException({
        message: "The conditional request failed",
        $metadata: {},
        CancellationReasons: reasons,
      });
    }
    for (const ti of items) {
      if (ti.Put) {
        if (ti.Put.TableName === this.inventoryTableName) this.inventoryTable.put(ti.Put.Item as Item & { id: string });
        else this.tableFor(ti.Put.TableName!).putRaw(ti.Put.Item as Item);
      } else if (ti.Update) {
        const table = this.tableFor(ti.Update.TableName!);
        const existing = table.get(ti.Update.Key as { PK: string; SK: string }) ?? (ti.Update.Key as Item);
        table.putRaw(applyUpdateExpression(existing, ti.Update.UpdateExpression!, ti.Update.ExpressionAttributeNames, ti.Update.ExpressionAttributeValues));
      } else if (ti.Delete) {
        this.tableFor(ti.Delete.TableName!).deleteRaw(ti.Delete.Key as { PK: string; SK: string });
      }
    }
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────
// フェイクS3: 実S3Client (ダミー静的credentials) を1つ使い、send()だけを
// 差し替えてHeadObjectのネットワークI/Oを偽装する (presigned PUTの署名計算は
// send()を経由しないオフライン処理なのでそのまま実SDKの経路を使う。下の
// headClient() 内コメント参照)。
// ─────────────────────────────────────────────────────────────────────────

interface FakeS3Object {
  contentLength: number;
  contentType: string;
  sha256Hex: string;
}

class FakeS3 {
  readonly objects = new Map<string, FakeS3Object>();
  put(key: string, obj: FakeS3Object): void {
    this.objects.set(key, obj);
  }
  /** completePhotoAssetUpload試験用: HeadObjectで観測される値を意図的に書き換える。 */
  corrupt(key: string, patch: Partial<FakeS3Object>): void {
    const existing = this.objects.get(key);
    if (existing) this.objects.set(key, { ...existing, ...patch });
  }

  /**
   * `S3PhotoStorage` は presign (`getSignedUrl`) と HeadObject の両方に同じ
   * `s3Client` を使う (実運用では実S3Client 1つで両方行う設計)。`getSignedUrl`
   * は `client.middlewareStack.clone()` と `client.config`（`endpointProvider`
   * 等）を直接触るため、プレーンなfakeオブジェクトでは `.clone()` が無く例外
   * になる（`middlewareStack`が存在しない）。一方で `getSignedUrl` は
   * `client.send()` を経由しない（オフライン署名のみ、ネットワークに出ない）。
   * そこで実 `S3Client` インスタンスを使い、`send()` だけを差し替えて
   * HeadObjectのネットワークI/Oのみを偽装する — 外部IO (実ネットワーク呼出)
   * だけを偽装し、SDKの署名・設定機構はそのまま使う。
   */
  headClient(): S3Client {
    const self = this;
    const client = new S3Client({
      region: "us-west-2",
      credentials: { accessKeyId: "test-access-key-id", secretAccessKey: "test-secret-access-key" },
    });
    (client as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        assert.equal(command.input.ChecksumMode, "ENABLED", "HeadObjectはChecksumMode=ENABLEDを指定しなければS3がChecksumSHA256を返さない (実装済みのバグ修正の回帰試験)");
        const obj = self.objects.get(command.input.Key!);
        if (!obj) {
          const error = new Error("NotFound") as Error & { name: string };
          error.name = "NotFound";
          throw error;
        }
        return {
          ContentLength: obj.contentLength,
          ContentType: obj.contentType,
          ChecksumSHA256: hexToBase64(obj.sha256Hex),
        };
      }
      throw new Error(`FakeS3: unsupported command ${(command as { constructor: { name: string } })?.constructor?.name}`);
    };
    return client;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// テスト環境の組み立て
// ─────────────────────────────────────────────────────────────────────────

const PHOTO_TABLE = "PhotoRegistrationTest";
const INVENTORY_TABLE = "InventoryTest";
const BUCKET = "bello-photo-registration-test";

function buildEnv() {
  const ddb = new FakeDynamoDB(PHOTO_TABLE, INVENTORY_TABLE);
  const fakeS3 = new FakeS3();
  const repository = new DynamoPhotoRegistrationRepository({
    ddb: ddb.asDocumentClient(),
    tableName: PHOTO_TABLE,
    inventoryTableName: INVENTORY_TABLE,
    now: () => new Date("2026-09-16T00:00:00.000Z"),
  });
  const storage = new S3PhotoStorage({ s3Client: fakeS3.headClient(), bucketName: BUCKET });
  const service = new PhotoRegistrationService({
    repository,
    storage,
    authConfig: { photoDeviceGroupDeployed: true },
  });
  return { ddb, fakeS3, repository, storage, service };
}

function deviceClaims(deviceUserId = "device-1", deviceId = "BELLO-PHOTO-PC-01"): TrustedClaims {
  return { userId: deviceUserId, groups: ["PHOTO_DEVICE"], deviceId };
}
function staffClaims(): TrustedClaims {
  return { userId: "staff-1", groups: ["EDITOR"], deviceId: null };
}
function adminClaims(): TrustedClaims {
  return { userId: "admin-1", groups: ["ADMIN"], deviceId: null };
}
function viewerClaims(): TrustedClaims {
  return { userId: "viewer-1", groups: ["VIEWER"], deviceId: null };
}

function hash(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

interface UploadResultItem {
  kind: string;
  clientAssetId: string;
  photoAssetId: string;
  uploads?: { variant: string; s3Key: string; uploadUrl: string; expectedBytes: number; expectedMimeType: string; expectedSha256: string }[];
}

/** requestPhotoAssetUploads -> presigned URLどおりに"アップロード成功"をFakeS3へ記録 -> completePhotoAssetUpload まで一括で行う。 */
async function uploadAndCompleteOne(
  env: ReturnType<typeof buildEnv>,
  batchId: string,
  seed: number,
  claims: TrustedClaims,
): Promise<string> {
  const requested = expectOk(
    await env.service.requestPhotoAssetUploads(
      { batchId, assets: [{ clientAssetId: `client-${seed}`, fileName: `DSC${seed}.JPG`, processed: { mimeType: "image/jpeg", fileSize: 1_200_000, sha256: hash(seed) }, thumbnail: { mimeType: "image/jpeg", fileSize: 40_000, sha256: hash(seed + 1_000_000) } }] },
      claims,
    ),
    `uploadAndCompleteOne(${seed})/request`,
  );
  const item = requested.items[0] as UploadResultItem;
  assert.equal(item.kind, "CREATE_ASSET");
  for (const upload of item.uploads!) {
    assert.ok(upload.uploadUrl.startsWith("https://"), "presigned URLが生成されていない");
    env.fakeS3.put(upload.s3Key, { contentLength: upload.expectedBytes, contentType: upload.expectedMimeType, sha256Hex: upload.expectedSha256 });
  }
  expectOk(
    await env.service.completePhotoAssetUpload(
      {
        photoAssetId: item.photoAssetId,
        processed: { sha256: hash(seed), fileSize: 1_200_000, width: 3000, height: 2000 },
        thumbnail: { sha256: hash(seed + 1_000_000), fileSize: 40_000, width: 400, height: 267 },
      },
      claims,
    ),
    `uploadAndCompleteOne(${seed})/complete`,
  );
  return item.photoAssetId;
}

async function createAndFillBatch(env: ReturnType<typeof buildEnv>, sessionId: string, count: number): Promise<string> {
  const created = expectOk(
    await env.service.createPhotoBatch({ localImportSessionId: sessionId, sourceDeviceId: "BELLO-PHOTO-PC-01", sourceSdCardId: "SD-A", imageCountOriginal: count, expectedAssetCount: count }, deviceClaims()),
    "createAndFillBatch/create",
  );
  for (let i = 0; i < count; i += 1) await uploadAndCompleteOne(env, created.batchId, 1000 + i, deviceClaims());
  return created.batchId;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. fail closed
// ─────────────────────────────────────────────────────────────────────────

test("fail closed: table名/bucket名が空ならコンストラクタが例外を投げる", () => {
  const env = buildEnv();
  assert.throws(() => new DynamoPhotoRegistrationRepository({ ddb: env.ddb.asDocumentClient(), tableName: "", inventoryTableName: INVENTORY_TABLE, now: () => new Date() }));
  assert.throws(() => new DynamoPhotoRegistrationRepository({ ddb: env.ddb.asDocumentClient(), tableName: PHOTO_TABLE, inventoryTableName: "", now: () => new Date() }));
  assert.throws(() => new S3PhotoStorage({ s3Client: env.fakeS3.headClient(), bucketName: "" }));
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 権限境界 (auth.ts + service.ts)
// ─────────────────────────────────────────────────────────────────────────

test("権限: VIEWER相当 (未知group) はcreatePhotoBatchを拒否される", async () => {
  const env = buildEnv();
  expectErr(await env.service.createPhotoBatch({ localImportSessionId: "s", imageCountOriginal: 1, expectedAssetCount: 1 }, viewerClaims()), "PERMISSION_DENIED", "viewer create");
});

test("権限: PHOTO_DEVICEはlinkPhotoBatchToInventoryを呼べない", async () => {
  const env = buildEnv();
  expectErr(await env.service.linkPhotoBatchToInventory({ batchId: "x", inventoryId: "y" }, deviceClaims()), "PERMISSION_DENIED", "device link");
});

test("権限: STAFFはrestorePhotoAssetを呼べない (ADMIN限定、§47)", async () => {
  const env = buildEnv();
  expectErr(await env.service.restorePhotoAsset({ photoAssetId: "does-not-matter" }, staffClaims()), "PERMISSION_DENIED", "staff restore");
});

test("権限: PHOTO_DEVICE groupが未デプロイ扱い (fail closed) だとPHOTO_DEVICE権限は一切通らない", async () => {
  const env = buildEnv();
  const lockedService = new PhotoRegistrationService({ repository: env.repository, storage: env.storage, authConfig: { photoDeviceGroupDeployed: false } });
  expectErr(await lockedService.createPhotoBatch({ localImportSessionId: "s", imageCountOriginal: 1, expectedAssetCount: 1 }, deviceClaims()), "PERMISSION_DENIED", "photoDeviceGroupDeployed=false");
});

test("権限: PHOTO_DEVICEは自分が作成していないbatchのsourceDeviceIdへ書き込めない (batch所属チェック)", async () => {
  const env = buildEnv();
  const created = expectOk(await env.service.createPhotoBatch({ localImportSessionId: "s-owner", sourceDeviceId: "PC-01", imageCountOriginal: 1, expectedAssetCount: 1 }, deviceClaims("device-1", "PC-01")), "create");
  const otherDevice = deviceClaims("device-2", "PC-02");
  expectErr(
    await env.service.requestPhotoAssetUploads({ batchId: created.batchId, assets: [{ clientAssetId: "c1", fileName: "a.jpg", processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(1) }, thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(2) } }] }, otherDevice),
    "PERMISSION_DENIED",
    "別端末からの書き込み",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 3. createPhotoBatch: 同時二重送信 (§93.5 ケースB) — 実際のConditionExpressionで拒否されることを確認
// ─────────────────────────────────────────────────────────────────────────

test("createPhotoBatch: 同時に2回送信しても実DynamoDB条件付きPutで1つのbatchしか作られない", async () => {
  const env = buildEnv();
  const input = { localImportSessionId: "s-race", sourceDeviceId: "BELLO-PHOTO-PC-01", sourceSdCardId: "SD-A", imageCountOriginal: 10, expectedAssetCount: 10 };
  const [a, b] = await Promise.all([env.service.createPhotoBatch(input, deviceClaims()), env.service.createPhotoBatch(input, deviceClaims())]);
  const okA = expectOk(a, "1回目");
  const okB = expectOk(b, "2回目");
  assert.equal(okA.batchId, okB.batchId, "同一sessionIdの同時送信は同じbatchIdへ収束しなければならない");
  const batchItems = [...env.ddb.table.items.values()].filter((i) => i.entityType === "PhotoBatch");
  assert.equal(batchItems.length, 1, "PhotoBatch行が1つだけ作られていること (重複作成されていない)");
});

// ─────────────────────────────────────────────────────────────────────────
// 4. requestPhotoAssetUploads: 同一画像を別clientAssetIdで同時送信 → hash条件で片方がDUPLICATE_SKIPへ収束
// ─────────────────────────────────────────────────────────────────────────

test("requestPhotoAssetUploads: 同じ画像を2つの別clientAssetIdで同時送信しても、hashの条件付きPutで二重作成されない", async () => {
  const env = buildEnv();
  const created = expectOk(await env.service.createPhotoBatch({ localImportSessionId: "s-hash-race", sourceDeviceId: "BELLO-PHOTO-PC-01", imageCountOriginal: 2, expectedAssetCount: 2 }, deviceClaims()), "create");
  const makeInput = (clientAssetId: string) => ({
    batchId: created.batchId,
    assets: [{ clientAssetId, fileName: "same.jpg", processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(42) }, thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(43) } }],
  });
  const [a, b] = await Promise.all([
    env.service.requestPhotoAssetUploads(makeInput("client-A"), deviceClaims()),
    env.service.requestPhotoAssetUploads(makeInput("client-B"), deviceClaims()),
  ]);
  const okA = expectOk(a, "A");
  const okB = expectOk(b, "B");
  const kinds = [okA.items[0] as UploadResultItem, okB.items[0] as UploadResultItem].map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["CREATE_ASSET", "DUPLICATE_SKIP"], "片方はCREATE_ASSET、もう片方はhash条件に負けてDUPLICATE_SKIPへ収束する");
  const assetItems = [...env.ddb.table.items.values()].filter((i) => i.entityType === "PhotoAsset");
  assert.equal(assetItems.length, 1, "同じsha256のPhotoAssetは1件しか作られない");
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 300枚境界: decideレベルの事前チェックだけでなく、実TransactWriteの条件が
//    「残り枠を超える同時登録」を拒否することを確認 (§93.5 / §7.6)
// ─────────────────────────────────────────────────────────────────────────

test("300枚境界: 残り1枠に2件が同時request → 実transactionの条件で片方だけ成功する", async () => {
  const env = buildEnv();
  const created = expectOk(await env.service.createPhotoBatch({ localImportSessionId: "s-300", sourceDeviceId: "BELLO-PHOTO-PC-01", imageCountOriginal: 300, expectedAssetCount: 300 }, deviceClaims()), "create");
  // 25件chunkで299枚まで埋める (300枚上限のすぐ手前)。
  for (let offset = 0; offset < 299; offset += 25) {
    const seeds = Array.from({ length: Math.min(25, 299 - offset) }, (_, i) => offset + i + 1);
    const assets = seeds.map((s) => ({ clientAssetId: `bulk-${s}`, fileName: `b${s}.jpg`, processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(s) }, thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(s + 500_000) } }));
    expectOk(await env.service.requestPhotoAssetUploads({ batchId: created.batchId, assets }, deviceClaims()), `bulk offset=${offset}`);
  }
  const batchBefore = await env.repository.getBatchById(created.batchId);
  assert.equal(batchBefore?.manifest.registeredAssetCount, 299, "事前状態: 299枚登録済み、残り1枠");

  const makeLastSlotInput = (clientAssetId: string, seed: number) => ({
    batchId: created.batchId,
    assets: [{ clientAssetId, fileName: "last.jpg", processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(seed) }, thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(seed + 900_000) } }],
  });
  const [a, b] = await Promise.all([
    env.service.requestPhotoAssetUploads(makeLastSlotInput("client-last-A", 9001), deviceClaims()),
    env.service.requestPhotoAssetUploads(makeLastSlotInput("client-last-B", 9002), deviceClaims()),
  ]);
  const results = [a, b];
  const oks = results.filter((r) => r.ok);
  const errs = results.filter((r) => !r.ok);
  assert.equal(oks.length, 1, "残り1枠に対して同時登録できるのは1件だけ");
  assert.equal(errs.length, 1, "もう片方は再読込の末にASSET_LIMIT_EXCEEDEDで拒否される");
  if (!errs[0].ok) assert.equal(errs[0].error, "ASSET_LIMIT_EXCEEDED");

  const batchAfter = await env.repository.getBatchById(created.batchId);
  assert.equal(batchAfter?.manifest.registeredAssetCount, 300, "最終的にちょうど300枚で頭打ちになる (301枚は作られない)");
});

// ─────────────────────────────────────────────────────────────────────────
// 6. completePhotoAssetUpload: S3検証・二重送信・S3成功→DB再開
// ─────────────────────────────────────────────────────────────────────────

test("completePhotoAssetUpload: S3に無い画像はUPLOAD_NOT_COMPLETE (欠損画像)", async () => {
  const env = buildEnv();
  const created = expectOk(await env.service.createPhotoBatch({ localImportSessionId: "s-missing", sourceDeviceId: "BELLO-PHOTO-PC-01", imageCountOriginal: 1, expectedAssetCount: 1 }, deviceClaims()), "create");
  const requested = expectOk(
    await env.service.requestPhotoAssetUploads({ batchId: created.batchId, assets: [{ clientAssetId: "c1", fileName: "a.jpg", processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(1) }, thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(2) } }] }, deviceClaims()),
    "request",
  );
  const item = requested.items[0] as UploadResultItem;
  // FakeS3へ何もPUTしない = アップロードされていない状態を再現。
  expectErr(
    await env.service.completePhotoAssetUpload({ photoAssetId: item.photoAssetId, processed: { sha256: hash(1), fileSize: 100, width: 10, height: 10 }, thumbnail: { sha256: hash(2), fileSize: 10, width: 4, height: 4 } }, deviceClaims()),
    "UPLOAD_NOT_COMPLETE",
    "S3に実体が無い",
  );
});

test("completePhotoAssetUpload: HeadObjectはChecksumMode=ENABLEDを指定する (回帰: これが無いとchecksumが常に取得不能になる)", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-checksum-mode", 1);
  const batch = await env.repository.getBatchById(batchId);
  assert.equal(batch?.manifest.completedAssetCount, 1, "FakeS3のassert (ChecksumMode=ENABLED) を経由して正常完了していること自体が回帰試験");
});

test("completePhotoAssetUpload: S3のchecksumが宣言と不一致ならHASH_MISMATCH", async () => {
  const env = buildEnv();
  const created = expectOk(await env.service.createPhotoBatch({ localImportSessionId: "s-hashmismatch", sourceDeviceId: "BELLO-PHOTO-PC-01", imageCountOriginal: 1, expectedAssetCount: 1 }, deviceClaims()), "create");
  const requested = expectOk(
    await env.service.requestPhotoAssetUploads({ batchId: created.batchId, assets: [{ clientAssetId: "c1", fileName: "a.jpg", processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(1) }, thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(2) } }] }, deviceClaims()),
    "request",
  );
  const item = requested.items[0] as UploadResultItem;
  for (const upload of item.uploads!) env.fakeS3.put(upload.s3Key, { contentLength: upload.expectedBytes, contentType: upload.expectedMimeType, sha256Hex: hash(999) });
  expectErr(
    await env.service.completePhotoAssetUpload({ photoAssetId: item.photoAssetId, processed: { sha256: hash(1), fileSize: 100, width: 10, height: 10 }, thumbnail: { sha256: hash(2), fileSize: 10, width: 4, height: 4 } }, deviceClaims()),
    "HASH_MISMATCH",
    "S3実体のchecksumが違う",
  );
});

test("completePhotoAssetUpload: 二重送信はNO_OP (S3成功後、DB反映を確認できず再送するケースの再開)", async () => {
  const env = buildEnv();
  const created = expectOk(await env.service.createPhotoBatch({ localImportSessionId: "s-resume", sourceDeviceId: "BELLO-PHOTO-PC-01", imageCountOriginal: 1, expectedAssetCount: 1 }, deviceClaims()), "create");
  const photoAssetId = await uploadAndCompleteOne(env, created.batchId, 5000, deviceClaims());
  const again = expectOk(
    await env.service.completePhotoAssetUpload({ photoAssetId, processed: { sha256: hash(5000), fileSize: 1_200_000, width: 3000, height: 2000 }, thumbnail: { sha256: hash(5000 + 1_000_000), fileSize: 40_000, width: 400, height: 267 } }, deviceClaims()),
    "resend",
  );
  assert.equal(again.status, "READY");
  const batch = await env.repository.getBatchById(created.batchId);
  assert.equal(batch?.manifest.completedAssetCount, 1, "二重送信でcompletedAssetCountが2重加算されていない");
});

test("completePhotoAssetUpload: 同時に2回complete送信してもcompletedAssetCountは1しか増えない (実transaction条件)", async () => {
  const env = buildEnv();
  const created = expectOk(await env.service.createPhotoBatch({ localImportSessionId: "s-double-complete", sourceDeviceId: "BELLO-PHOTO-PC-01", imageCountOriginal: 1, expectedAssetCount: 1 }, deviceClaims()), "create");
  const requested = expectOk(
    await env.service.requestPhotoAssetUploads({ batchId: created.batchId, assets: [{ clientAssetId: "c1", fileName: "a.jpg", processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(1) }, thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(2) } }] }, deviceClaims()),
    "request",
  );
  const item = requested.items[0] as UploadResultItem;
  for (const upload of item.uploads!) env.fakeS3.put(upload.s3Key, { contentLength: upload.expectedBytes, contentType: upload.expectedMimeType, sha256Hex: upload.expectedSha256 });
  const completeInput = { photoAssetId: item.photoAssetId, processed: { sha256: hash(1), fileSize: 100, width: 10, height: 10 }, thumbnail: { sha256: hash(2), fileSize: 10, width: 4, height: 4 } };
  const [a, b] = await Promise.all([env.service.completePhotoAssetUpload(completeInput, deviceClaims()), env.service.completePhotoAssetUpload(completeInput, deviceClaims())]);
  expectOk(a, "1回目");
  expectOk(b, "2回目 (NO_OPへ収束)");
  const batch = await env.repository.getBatchById(created.batchId);
  assert.equal(batch?.manifest.completedAssetCount, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// 7. completePhotoBatch: 25chunk/300境界のfinalize、二重finalize
// ─────────────────────────────────────────────────────────────────────────

// createAndFillBatchは1件ずつrequestPhotoAssetUploadsを呼ぶ (25件chunkでの
// 登録自体は上の「300枚境界」試験が実際に検証している)。ここでは300枚
// finalizeまで実際に完走することを確認する。
test("completePhotoBatch: 300枚を実際に登録・完了・finalizeできる", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-300-finalize", 300);
  const finalized = expectOk(await env.service.completePhotoBatch({ batchId, imageCountProcessed: 300, imageCountUploaded: 300 }, deviceClaims()), "finalize");
  assert.equal(finalized.status, "READY_FOR_REVIEW");
  const batch = await env.repository.getBatchById(batchId);
  assert.equal(batch?.manifest.completedAssetCount, 300);
});

test("completePhotoBatch: 二重finalizeはNO_OP", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-double-finalize", 2);
  expectOk(await env.service.completePhotoBatch({ batchId, imageCountProcessed: 2, imageCountUploaded: 2 }, deviceClaims()), "1回目");
  const second = expectOk(await env.service.completePhotoBatch({ batchId, imageCountProcessed: 2, imageCountUploaded: 2 }, deviceClaims()), "2回目");
  assert.equal(second.status, "READY_FOR_REVIEW");
});

test("completePhotoBatch: 26件chunkはIOに触れる前にCHUNK_TOO_LARGEで拒否される", async () => {
  const env = buildEnv();
  const created = expectOk(await env.service.createPhotoBatch({ localImportSessionId: "s-chunk26", sourceDeviceId: "BELLO-PHOTO-PC-01", imageCountOriginal: 26, expectedAssetCount: 26 }, deviceClaims()), "create");
  const assets = Array.from({ length: 26 }, (_, i) => ({ clientAssetId: `c${i}`, fileName: `f${i}.jpg`, processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(i + 1) }, thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(i + 1_000) } }));
  expectErr(await env.service.requestPhotoAssetUploads({ batchId: created.batchId, assets }, deviceClaims()), "CHUNK_TOO_LARGE", "26件chunk");
  const batch = await env.repository.getBatchById(created.batchId);
  assert.equal(batch?.manifest.registeredAssetCount, 0, "検証で落ちたのでDBへは一切書き込まれていない");
});

// ─────────────────────────────────────────────────────────────────────────
// 8. linkPhotoBatchToInventory: 二者同時登録、権限越境、削除済みInventory
// ─────────────────────────────────────────────────────────────────────────

test("link: 二者同時登録は実DynamoDB条件で片方だけ成功する (§59)", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-link-race", 2);
  expectOk(await env.service.completePhotoBatch({ batchId, imageCountProcessed: 2, imageCountUploaded: 2 }, deviceClaims()), "finalize");
  env.ddb.inventoryTable.put({ id: "inv-1" });

  const [a, b] = await Promise.all([
    env.service.linkPhotoBatchToInventory({ batchId, inventoryId: "inv-1" }, staffClaims()),
    env.service.linkPhotoBatchToInventory({ batchId, inventoryId: "inv-1" }, adminClaims()),
  ]);
  const oks = [a, b].filter((r) => r.ok);
  const errs = [a, b].filter((r) => !r.ok);
  assert.equal(oks.length, 1, "同時linkは1件だけ成功する");
  assert.equal(errs.length, 1);
  if (!errs[0].ok) assert.equal(errs[0].error, "BATCH_ALREADY_LINKED", "後から読み直した側はBATCH_ALREADY_LINKEDになる");
});

test("link: 削除済みInventoryへはINVENTORY_NOT_FOUND", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-link-deleted-inv", 1);
  expectOk(await env.service.completePhotoBatch({ batchId, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims()), "finalize");
  env.ddb.inventoryTable.put({ id: "inv-deleted", deletedAt: "2026-01-01T00:00:00.000Z" });
  expectErr(await env.service.linkPhotoBatchToInventory({ batchId, inventoryId: "inv-deleted" }, staffClaims()), "INVENTORY_NOT_FOUND", "論理削除済み");
});

test("link: decide後・commit前にInventoryが削除された場合、実transactionのConditionCheckが書込みを拒否する (弱いassert対策)", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-link-tocctou", 1);
  expectOk(await env.service.completePhotoBatch({ batchId, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims()), "finalize");
  env.ddb.inventoryTable.put({ id: "inv-race" });

  const batch = await env.repository.getBatchById(batchId);
  const inventory = await env.repository.lookupInventory("inv-race");
  const { decideLinkBatchToInventory } = await import("../lib/photoRegistration/state");
  const decision = expectOk(decideLinkBatchToInventory({ batchId, inventoryId: "inv-race" }, { batch: batch!, inventory }), "decide (読取時点ではInventoryは生きている)");

  // ここで decide が読んだ後に、別のリクエストが同じInventoryを削除したことにする。
  env.ddb.inventoryTable.put({ id: "inv-race", deletedAt: "2026-01-01T00:00:00.000Z" });

  await assert.rejects(
    () => env.repository.applyLink(decision, "2026-09-16T00:00:00.000Z"),
    (error: unknown) => error instanceof ConditionViolationError,
    "decide時点の読み取りが古くなっていても、実transactionのConditionCheckが書込みを拒否しなければならない",
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 9. 削除 / 選択の競合 (§68) — 弱いassertではなく実transaction条件で閉じることを確認
// ─────────────────────────────────────────────────────────────────────────

test("削除×選択の競合: 出品で選択中のPhotoAssetを削除しようとするとASSET_IN_USE (decide層は素通しでも、実transaction条件が拒否する)", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-delete-vs-select", 1);
  expectOk(await env.service.completePhotoBatch({ batchId, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims()), "finalize");
  env.ddb.inventoryTable.put({ id: "inv-select" });
  expectOk(await env.service.linkPhotoBatchToInventory({ batchId, inventoryId: "inv-select" }, staffClaims()), "link");

  const assets = await env.repository.getAssetsForBatch(batchId);
  const photoAssetId = assets[0].id;

  expectOk(await env.service.setListingImageSelection({ listingId: "listing-1", photoAssetIds: [photoAssetId] }, "inv-select", { maxImages: 20 }, staffClaims()), "select");

  // service.deletePhotoAsset内部のdecideDeleteAssetは常にactiveListingSelectionCount=0を渡す
  // (GSI逆引きを使わないため、§68コメント参照) — つまりここでASSET_IN_USEを検知できるのは
  // 実DynamoDB transactionの `listingSelectionCount = 0` 条件だけである。
  expectErr(await env.service.deletePhotoAsset({ photoAssetId }, staffClaims()), "ASSET_IN_USE", "選択中の画像削除は実transaction条件で拒否される");
});

test("削除×選択の競合: 選択を外した後は削除できる", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-delete-after-unselect", 1);
  expectOk(await env.service.completePhotoBatch({ batchId, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims()), "finalize");
  env.ddb.inventoryTable.put({ id: "inv-unselect" });
  expectOk(await env.service.linkPhotoBatchToInventory({ batchId, inventoryId: "inv-unselect" }, staffClaims()), "link");
  const assets = await env.repository.getAssetsForBatch(batchId);
  const photoAssetId = assets[0].id;
  expectOk(await env.service.setListingImageSelection({ listingId: "listing-2", photoAssetIds: [photoAssetId] }, "inv-unselect", { maxImages: 20 }, staffClaims()), "select");
  expectOk(await env.service.setListingImageSelection({ listingId: "listing-2", photoAssetIds: [] }, "inv-unselect", { maxImages: 20 }, staffClaims()), "unselect");
  expectOk(await env.service.deletePhotoAsset({ photoAssetId }, staffClaims()), "delete後");
});

test("復元: ADMINのみ実行でき、統計 (expected/registered) が正しく戻る", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-restore", 2);
  const assets = await env.repository.getAssetsForBatch(batchId);
  const photoAssetId = assets[0].id;
  expectOk(await env.service.deletePhotoAsset({ photoAssetId }, staffClaims()), "delete");
  let batch = await env.repository.getBatchById(batchId);
  assert.equal(batch?.manifest.expectedAssetCount, 1);

  const restored = expectOk(await env.service.restorePhotoAsset({ photoAssetId }, adminClaims()), "restore");
  assert.equal(restored.status, "READY", "READY状態からの削除→復元はREADYへ戻る (completeを経ていたため)");
  batch = await env.repository.getBatchById(batchId);
  assert.equal(batch?.manifest.expectedAssetCount, 2);
  assert.equal(batch?.manifest.registeredAssetCount, 2);
  assert.equal(batch?.manifest.completedAssetCount, 2);
});

// ─────────────────────────────────────────────────────────────────────────
// 10. 読み取り専用一覧・ページング (Scanを使わないことの構造的保証)
// ─────────────────────────────────────────────────────────────────────────

test("listUnregisteredBatches: 未登録一覧はGSI1経由で取得でき、Scanは一切使われない (FakeDynamoDBがQuery/Get/TransactWrite以外を拒否することで保証)", async () => {
  const env = buildEnv();
  const idA = await createAndFillBatch(env, "s-list-a", 1);
  await env.service.completePhotoBatch({ batchId: idA, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims());
  const idB = await createAndFillBatch(env, "s-list-b", 1);
  await env.service.completePhotoBatch({ batchId: idB, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims());

  const page1 = expectOk(await env.service.listUnregisteredBatches(1, null, staffClaims()), "page1");
  assert.equal(page1.items.length, 1);
  assert.ok(page1.nextCursor, "1件目取得後、2件目があるのでcursorが返る");
  const page2 = expectOk(await env.service.listUnregisteredBatches(1, page1.nextCursor, staffClaims()), "page2");
  assert.equal(page2.items.length, 1);
  assert.notEqual(page1.items[0].id, page2.items[0].id, "ページングで別のbatchが返る");
  assert.equal(page2.nextCursor, null, "2件しか無いので2ページ目でcursorは終端");
});

test("listUnregisteredBatches: VIEWER相当は読み取り専用一覧も拒否される", async () => {
  const env = buildEnv();
  expectErr(await env.service.listUnregisteredBatches(10, null, viewerClaims()), "PERMISSION_DENIED", "viewer list");
});

test("listBatchesForInventory: linkしたbatchがInventory別一覧に現れる (§4.7 複数撮影バッチ)", async () => {
  const env = buildEnv();
  const idA = await createAndFillBatch(env, "s-inv-list-a", 1);
  await env.service.completePhotoBatch({ batchId: idA, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims());
  env.ddb.inventoryTable.put({ id: "inv-multi" });
  expectOk(await env.service.linkPhotoBatchToInventory({ batchId: idA, inventoryId: "inv-multi" }, staffClaims()), "link A");

  const idB = await createAndFillBatch(env, "s-inv-list-b", 1);
  await env.service.completePhotoBatch({ batchId: idB, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims());
  expectOk(await env.service.linkPhotoBatchToInventory({ batchId: idB, inventoryId: "inv-multi" }, staffClaims()), "link B (再撮影)");

  const page = expectOk(await env.service.listBatchesForInventory("inv-multi", 10, null, staffClaims()), "list");
  assert.equal(page.items.length, 2, "同一Inventoryへ複数PhotoBatchを紐付け可能");
});

// ─────────────────────────────────────────────────────────────────────────
// 実行
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  await Promise.all(pendingTests);
  console.log(`\n[verify-photo-registration-api] ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`\nFAIL: ${failure}`);
    process.exitCode = 1;
  }
}

void main();
