/**
 * 画像登録基盤 Phase 1 — Web UI / server action 境界 (lib/photoRegistration/
 * webAdapter.ts) の合成試験。
 *
 * 実行:
 *   node scripts/qa/run-verify-with-server-only-noop.cjs scripts/verify-photo-registration-web.ts
 *
 * scripts/verify-photo-registration-api.ts と同じ考え方 — 実際の
 * DynamoPhotoRegistrationRepository / S3PhotoStorage / PhotoRegistrationService
 * を、外部IO (DynamoDB/S3のネットワーク呼び出し) だけ偽装して動かす。
 * PhotoRegistrationWebAdapterはrepository/service/presignGetUrlを注入される
 * だけのクラスなので、ここでは getPhotoRegistrationWebAdapter() (実AWS
 * クライアントを構築するシングルトン) は「fail closed」試験でのみ呼び、
 * それ以外はすべて手で組み立てたfakeに対して直接試験する。
 *
 * 【証明できないこと】(scripts/verify-photo-registration-api.tsと同様)
 * 実DynamoDB/S3のネットワーク挙動、実Cognito認証、ブラウザからの実PUT。
 * 導線(NAV_ITEMS)の確認は静的ソース文字列の確認であり、実際にレンダリング
 * したUIを検証したものではない(jsdom等を要するため、このスクリプトの
 * 対象外)。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoPhotoRegistrationRepository } from "../lib/photoRegistration/awsRepository";
import { hexToBase64, S3PhotoStorage } from "../lib/photoRegistration/awsStorage";
import { PhotoRegistrationService } from "../lib/photoRegistration/service";
import type { TrustedClaims } from "../lib/photoRegistration/ports";
import type { PhotoResult } from "../lib/photoRegistration/types";
import {
  getPhotoRegistrationWebAdapter,
  MAX_WEB_UPLOAD_FILES_PER_REQUEST,
  PhotoRegistrationWebAdapter,
  validateWebUploadFileName,
  type WebBatchDetail,
} from "../lib/photoRegistration/webAdapter";

let passed = 0;
const failures: string[] = [];
const pendingTests: Promise<void>[] = [];

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
function expectErr(result: PhotoResult<unknown>, code: string, label: string): void {
  assert.equal(result.ok, false, `${label}: expected ${code}, got ok`);
  if (!result.ok) assert.equal(result.error, code, `${label}: expected ${code}, got ${result.error}`);
}

// ─────────────────────────────────────────────────────────────────────────
// 最小限のDynamoDB互換フェイク (verify-photo-registration-api.tsと同じ
// 対応範囲 — awsRepository.tsが実際に生成する構文だけに絞る)。
// ─────────────────────────────────────────────────────────────────────────

type Item = Record<string, unknown>;

function resolveName(raw: string, names?: Record<string, string>): string {
  return raw.startsWith("#") ? (names?.[raw] ?? raw) : raw;
}

function evalAtomic(atom: string, item: Item, names?: Record<string, string>, values?: Record<string, unknown>): boolean {
  const trimmed = atom.trim();
  let m: RegExpExecArray | null;
  if ((m = /^attribute_not_exists\(([^)]+)\)$/.exec(trimmed))) return item[resolveName(m[1], names)] === undefined;
  if ((m = /^attribute_exists\(([^)]+)\)$/.exec(trimmed))) return item[resolveName(m[1], names)] !== undefined;
  if ((m = /^(\S+)\s*<=\s*(:\S+)$/.exec(trimmed))) {
    const attr = resolveName(m[1], names);
    return (item[attr] as number | undefined) !== undefined && (item[attr] as number) <= (values?.[m[2]] as number);
  }
  if ((m = /^(\S+)\s*>=\s*(:\S+)$/.exec(trimmed))) {
    const attr = resolveName(m[1], names);
    return (item[attr] as number | undefined) !== undefined && (item[attr] as number) >= (values?.[m[2]] as number);
  }
  if ((m = /^(\S+)\s*<>\s*(:\S+)$/.exec(trimmed))) return item[resolveName(m[1], names)] !== values?.[m[2]];
  if ((m = /^(\S+)\s*=\s*(:\S+)$/.exec(trimmed))) return item[resolveName(m[1], names)] === values?.[m[2]];
  throw new Error(`FakeDynamoDB: unsupported condition atom: ${trimmed}`);
}

function evaluateCondition(expr: string | undefined, item: Item, names?: Record<string, string>, values?: Record<string, unknown>): boolean {
  if (!expr) return true;
  return expr.split(" OR ").some((group) => group.split(" AND ").every((atom) => evalAtomic(atom, item, names, values)));
}

function splitRespectingParens(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of input) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
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
  if (removePartRaw) for (const attr of removePartRaw.split(",")) delete next[resolveName(attr.trim(), names)];
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
}

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
  readonly table = new FakeTable();
  readonly inventoryTable = new FakeInventoryTable();
  constructor(
    readonly photoTableName: string,
    readonly inventoryTableName: string,
  ) {}

  asDocumentClient(): DynamoDBDocumentClient {
    return {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) {
          const input = command.input;
          if (input.TableName === this.inventoryTableName) return { Item: this.inventoryTable.get((input.Key as { id: string }).id) };
          return { Item: this.table.get(input.Key as { PK: string; SK: string }) };
        }
        if (command instanceof QueryCommand) return this.runQuery(command.input);
        if (command instanceof TransactWriteCommand) return this.runTransactWrite(command.input.TransactItems ?? []);
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
    return { Items: page, LastEvaluatedKey: hasMore ? { PK: page[page.length - 1].PK, SK: page[page.length - 1].SK } : undefined };
  }

  private runTransactWrite(items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>) {
    const reasons: { Code: string }[] = [];
    let anyFailed = false;
    for (const ti of items) {
      if (ti.Put) {
        const isInv = ti.Put.TableName === this.inventoryTableName;
        const existing = isInv ? this.inventoryTable.get((ti.Put.Item as { id: string }).id) ?? {} : this.table.get(ti.Put.Item as { PK: string; SK: string }) ?? {};
        const ok = evaluateCondition(ti.Put.ConditionExpression, existing, ti.Put.ExpressionAttributeNames, ti.Put.ExpressionAttributeValues);
        reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
        if (!ok) anyFailed = true;
      } else if (ti.Update) {
        const existing = this.table.get(ti.Update.Key as { PK: string; SK: string }) ?? {};
        const ok = evaluateCondition(ti.Update.ConditionExpression, existing, ti.Update.ExpressionAttributeNames, ti.Update.ExpressionAttributeValues);
        reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
        if (!ok) anyFailed = true;
      } else if (ti.ConditionCheck) {
        const isInv = ti.ConditionCheck.TableName === this.inventoryTableName;
        const existing = isInv ? this.inventoryTable.get((ti.ConditionCheck.Key as { id: string }).id) ?? {} : this.table.get(ti.ConditionCheck.Key as { PK: string; SK: string }) ?? {};
        const ok = evaluateCondition(ti.ConditionCheck.ConditionExpression, existing, ti.ConditionCheck.ExpressionAttributeNames, ti.ConditionCheck.ExpressionAttributeValues);
        reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
        if (!ok) anyFailed = true;
      } else if (ti.Delete) {
        reasons.push({ Code: "None" });
      }
    }
    if (anyFailed) throw new TransactionCanceledException({ message: "The conditional request failed", $metadata: {}, CancellationReasons: reasons });
    for (const ti of items) {
      if (ti.Put) {
        if (ti.Put.TableName === this.inventoryTableName) this.inventoryTable.put(ti.Put.Item as Item & { id: string });
        else this.table.putRaw(ti.Put.Item as Item);
      } else if (ti.Update) {
        const existing = this.table.get(ti.Update.Key as { PK: string; SK: string }) ?? (ti.Update.Key as Item);
        this.table.putRaw(applyUpdateExpression(existing, ti.Update.UpdateExpression!, ti.Update.ExpressionAttributeNames, ti.Update.ExpressionAttributeValues));
      }
    }
    return {};
  }
}

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
  headClient(): S3Client {
    const client = new S3Client({ region: "us-west-2", credentials: { accessKeyId: "test-access-key-id", secretAccessKey: "test-secret-access-key" } });
    (client as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        const obj = this.objects.get(command.input.Key!);
        if (!obj) {
          const error = new Error("NotFound") as Error & { name: string };
          error.name = "NotFound";
          throw error;
        }
        return { ContentLength: obj.contentLength, ContentType: obj.contentType, ChecksumSHA256: hexToBase64(obj.sha256Hex) };
      }
      throw new Error(`FakeS3: unsupported command ${(command as { constructor: { name: string } })?.constructor?.name}`);
    };
    return client;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 環境の組み立て
// ─────────────────────────────────────────────────────────────────────────

const PHOTO_TABLE = "PhotoRegistrationWebTest";
const INVENTORY_TABLE = "InventoryWebTest";
const BUCKET = "bello-photo-registration-web-test";

/** presigned GET URLの発行だけを行う — getSignedUrlはネットワークを使わないオフライン署名なので、実S3Clientをダミーcredentialsで使うだけでよい (awsStorage.tsと同じ手法)。 */
function buildPresignGetUrl() {
  return async (s3Key: string) => `https://${BUCKET}.s3.us-west-2.amazonaws.com/${encodeURIComponent(s3Key)}?X-Amz-Signature=test`;
}

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
  const authConfig = { photoDeviceGroupDeployed: true };
  const service = new PhotoRegistrationService({ repository, storage, authConfig });
  const adapter = new PhotoRegistrationWebAdapter({ service, repository, authConfig, presignGetUrl: buildPresignGetUrl() });
  return { ddb, fakeS3, repository, storage, service, adapter };
}

function deviceClaims(): TrustedClaims {
  return { userId: "device-1", groups: ["PHOTO_DEVICE"], deviceId: "BELLO-PHOTO-PC-01" };
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

async function createAndFillBatch(env: ReturnType<typeof buildEnv>, sessionId: string, count: number): Promise<string> {
  const created = expectOk(
    await env.service.createPhotoBatch({ localImportSessionId: sessionId, sourceDeviceId: "BELLO-PHOTO-PC-01", sourceSdCardId: "SD-A", imageCountOriginal: count, expectedAssetCount: count }, deviceClaims()),
    "createAndFillBatch/create",
  );
  for (let i = 0; i < count; i += 1) {
    const seed = 1000 + i;
    const requested = expectOk(
      await env.service.requestPhotoAssetUploads(
        {
          batchId: created.batchId,
          assets: [{ clientAssetId: `client-${seed}`, fileName: `DSC${seed}.JPG`, processed: { mimeType: "image/jpeg", fileSize: 1_200_000, sha256: hash(seed) }, thumbnail: { mimeType: "image/jpeg", fileSize: 40_000, sha256: hash(seed + 1_000_000) } }],
        },
        deviceClaims(),
      ),
      `fill/request(${seed})`,
    );
    const item = requested.items[0] as UploadResultItem;
    for (const upload of item.uploads!) env.fakeS3.put(upload.s3Key, { contentLength: upload.expectedBytes, contentType: upload.expectedMimeType, sha256Hex: upload.expectedSha256 });
    expectOk(
      await env.service.completePhotoAssetUpload(
        { photoAssetId: item.photoAssetId, processed: { sha256: hash(seed), fileSize: 1_200_000, width: 3000, height: 2000 }, thumbnail: { sha256: hash(seed + 1_000_000), fileSize: 40_000, width: 400, height: 267 } },
        deviceClaims(),
      ),
      `fill/complete(${seed})`,
    );
  }
  return created.batchId;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. fail closed
// ─────────────────────────────────────────────────────────────────────────

test("fail closed: 画像登録用のtable/bucket環境変数が未設定 (現状は常にこう) だとgetPhotoRegistrationWebAdapter()はnullを返す", () => {
  delete process.env.PHOTO_REGISTRATION_TABLE_NAME;
  delete process.env.PHOTO_REGISTRATION_INVENTORY_TABLE_NAME;
  delete process.env.PHOTO_REGISTRATION_BUCKET_NAME;
  assert.equal(getPhotoRegistrationWebAdapter(), null, "AWS未接続の間は例外を投げずnullを返す (fail closed)");
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 権限境界 — getBatchDetail (serviceに対応メソッドが無いためwebAdapter自身がゲートする)
// ─────────────────────────────────────────────────────────────────────────

test("権限: VIEWER相当 (未知group) はgetBatchDetailを拒否される", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-viewer", 1);
  expectErr(await env.adapter.getBatchDetail(batchId, viewerClaims(), { page: 1, pageSize: 24 }), "PERMISSION_DENIED", "viewer detail");
});

test("権限: STAFF/ADMINはgetBatchDetailを呼べる", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-staff", 1);
  expectOk(await env.adapter.getBatchDetail(batchId, staffClaims(), { page: 1, pageSize: 24 }), "staff detail");
  expectOk(await env.adapter.getBatchDetail(batchId, adminClaims(), { page: 1, pageSize: 24 }), "admin detail");
});

test("権限: restoreAssetはADMIN限定のままWeb経由でも維持される (service.tsへの委譲)", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-restore-perm", 1);
  const assets = await env.repository.getAssetsForBatch(batchId);
  expectOk(await env.adapter.deleteAsset({ photoAssetId: assets[0].id }, staffClaims()), "delete");
  expectErr(await env.adapter.restoreAsset({ photoAssetId: assets[0].id }, staffClaims()), "PERMISSION_DENIED", "STAFFのrestoreは拒否される");
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 入力制限 (fileNameの危険拡張子・件数上限)
// ─────────────────────────────────────────────────────────────────────────

test("入力制限: 危険な拡張子(.exe)はfileNameで拒否される", () => {
  expectErr(validateWebUploadFileName("malware.exe", "image/jpeg"), "INVALID_INPUT", "exe拒否");
  expectErr(validateWebUploadFileName("script.svg", "image/jpeg"), "INVALID_INPUT", "svg拒否");
});

test("入力制限: mimeTypeと拡張子が食い違うと拒否される", () => {
  expectErr(validateWebUploadFileName("photo.png", "image/jpeg"), "INVALID_INPUT", "png拡張子+jpeg mimeは拒否");
});

test("入力制限: 許可されたJPEG/PNG/WebPの正しい拡張子は受理される", () => {
  expectOk(validateWebUploadFileName("photo.jpg", "image/jpeg"), "jpg");
  expectOk(validateWebUploadFileName("photo.PNG", "image/png"), "PNG(大文字拡張子)");
  expectOk(validateWebUploadFileName("photo.webp", "image/webp"), "webp");
});

test(`入力制限: requestWebUploadsは${MAX_WEB_UPLOAD_FILES_PER_REQUEST}件を超えるとDBへ触れずINVALID_INPUTで拒否する`, async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-toomany", 1);
  const assets = Array.from({ length: MAX_WEB_UPLOAD_FILES_PER_REQUEST + 1 }, (_, i) => ({
    clientAssetId: `too-many-${i}`,
    fileName: `f${i}.jpg`,
    processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(5000 + i) },
    thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(6000 + i) },
  }));
  const before = await env.repository.getAssetsForBatch(batchId);
  expectErr(await env.adapter.requestWebUploads({ batchId, assets, additionalExpectedCount: null }, staffClaims()), "INVALID_INPUT", "21件は拒否");
  const after = await env.repository.getAssetsForBatch(batchId);
  assert.equal(after.length, before.length, "検証で落ちたのでDBへは一切書き込まれていない");
});

test("入力制限: 危険な拡張子を含むrequestWebUploadsはDBへ触れずINVALID_INPUTで拒否する", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-dangerous-ext", 1);
  const before = await env.repository.getAssetsForBatch(batchId);
  expectErr(
    await env.adapter.requestWebUploads(
      { batchId, assets: [{ clientAssetId: "bad-1", fileName: "evil.exe", processed: { mimeType: "image/jpeg", fileSize: 100, sha256: hash(7001) }, thumbnail: { mimeType: "image/jpeg", fileSize: 10, sha256: hash(7002) } }], additionalExpectedCount: null },
      staffClaims(),
    ),
    "INVALID_INPUT",
    "危険拡張子は拒否",
  );
  const after = await env.repository.getAssetsForBatch(batchId);
  assert.equal(after.length, before.length, "検証で落ちたのでDBへは一切書き込まれていない");
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 一覧 / 詳細変換 (署名URL・並び順・ページング)
// ─────────────────────────────────────────────────────────────────────────

test("一覧: listUnregisteredBatchesはREADY_FOR_REVIEWのbatchだけを返す (service.tsへの委譲)", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-list", 1);
  await env.service.completePhotoBatch({ batchId, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims());
  const page = expectOk(await env.adapter.listUnregisteredBatches(10, null, staffClaims()), "list");
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, batchId);
});

test("一覧サムネイル: 1商品の読取失敗で同じチャンク全体を失敗させない", async () => {
  const env = buildEnv();
  const original = env.repository.listBatchesForInventory.bind(env.repository);
  env.repository.listBatchesForInventory = async (...args) => {
    if (args[0] === "broken") throw new Error("simulated single-item failure");
    return original(...args);
  };
  const result = expectOk(await env.adapter.listPrimaryPhotoThumbnails(["broken", "healthy"], staffClaims()), "thumbnails");
  assert.deepEqual(result, { broken: null, healthy: null });
});

test("詳細変換: 各AssetにPROCESSED/THUMBNAILの署名URLが付き、sequence順に並ぶ", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-detail", 3);
  const detail = expectOk(await env.adapter.getBatchDetail(batchId, staffClaims(), { page: 1, pageSize: 24 }), "detail") as WebBatchDetail;
  assert.equal(detail.totalAssetCount, 3);
  assert.equal(detail.assets.length, 3);
  assert.deepEqual(detail.assets.map((a) => a.sequence), [...detail.assets.map((a) => a.sequence)].sort((a, b) => a - b), "sequence昇順");
  for (const asset of detail.assets) {
    assert.ok(asset.thumbnailUrl?.startsWith("https://"), "thumbnailUrlが署名URLとして生成されている");
    assert.ok(asset.processedUrl?.startsWith("https://"), "processedUrlが署名URLとして生成されている");
  }
  assert.equal(detail.actorRole, "STAFF");
});

test("詳細変換: ページングは指定pageSizeで分割し、総数はtotalAssetCountで正しく返る", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-detail-paging", 5);
  const page1 = expectOk(await env.adapter.getBatchDetail(batchId, staffClaims(), { page: 1, pageSize: 2 }), "page1") as WebBatchDetail;
  assert.equal(page1.assets.length, 2);
  assert.equal(page1.totalAssetCount, 5);
  const page3 = expectOk(await env.adapter.getBatchDetail(batchId, staffClaims(), { page: 3, pageSize: 2 }), "page3") as WebBatchDetail;
  assert.equal(page3.assets.length, 1, "5件を2件ずつに分けた最終ページは1件");
  const outOfRange = expectOk(await env.adapter.getBatchDetail(batchId, staffClaims(), { page: 999, pageSize: 2 }), "out of range page") as WebBatchDetail;
  assert.equal(outOfRange.page, 3, "範囲外のpageは最終ページへ丸められる (存在しないページで空UIにならない)");
});

test("詳細変換: 存在しないbatchIdはBATCH_NOT_FOUND", async () => {
  const env = buildEnv();
  expectErr(await env.adapter.getBatchDetail("does-not-exist", staffClaims(), { page: 1, pageSize: 24 }), "BATCH_NOT_FOUND", "not found");
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 操作dispatch (Web追加upload → complete → finalize、削除/復元、link)
// ─────────────────────────────────────────────────────────────────────────

test("操作dispatch: Web追加upload一式 (request→PUT相当→complete→finalize) がREADY_FOR_REVIEWのbatchに新しいrevisionを開いて完走する", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-additional", 1);
  expectOk(await env.service.completePhotoBatch({ batchId, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims()), "finalize初回");

  const requested = expectOk(
    await env.adapter.requestWebUploads(
      { batchId, assets: [{ clientAssetId: "web-1", fileName: "web1.jpg", processed: { mimeType: "image/jpeg", fileSize: 200_000, sha256: hash(8001) }, thumbnail: { mimeType: "image/jpeg", fileSize: 20_000, sha256: hash(8002) } }], additionalExpectedCount: 1 },
      staffClaims(),
    ),
    "web request",
  );
  const item = requested.items[0] as UploadResultItem;
  assert.equal(item.kind, "CREATE_ASSET");
  for (const upload of item.uploads!) {
    assert.ok(upload.uploadUrl.startsWith("https://"), "presigned PUT URLが生成されている");
    env.fakeS3.put(upload.s3Key, { contentLength: upload.expectedBytes, contentType: upload.expectedMimeType, sha256Hex: upload.expectedSha256 });
  }
  expectOk(
    await env.adapter.completeWebUpload({ photoAssetId: item.photoAssetId, processed: { sha256: hash(8001), fileSize: 200_000, width: 800, height: 600 }, thumbnail: { sha256: hash(8002), fileSize: 20_000, width: 200, height: 150 } }, staffClaims()),
    "web complete",
  );

  const finalized = expectOk(await env.adapter.finalizeWebUpload(batchId, staffClaims()), "web finalize");
  assert.equal(finalized.status, "READY_FOR_REVIEW");
  const batch = await env.repository.getBatchById(batchId);
  assert.equal(batch?.manifest.expectedAssetCount, 2, "追加upload後は予定枚数が2枚になる");
  assert.equal(batch?.manifest.registeredAssetCount, 2);
  assert.equal(batch?.manifest.completedAssetCount, 2);
  assert.equal(batch?.manifest.openRevision, null, "finalizeでrevisionが閉じる");
});

test("操作dispatch: finalizeWebUploadはクライアント申告ではなくサーバーmanifestの枚数を使う (信頼境界)", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-finalize-trust", 2);
  // クライアントからは枚数を一切渡していない (finalizeWebUpload(batchId, claims)のシグネチャに枚数引数自体が無い)。
  const finalized = expectOk(await env.adapter.finalizeWebUpload(batchId, staffClaims()), "finalize");
  assert.equal(finalized.status, "READY_FOR_REVIEW");
});

test("操作dispatch: deleteAsset/restoreAssetがWeb経由でもmanifestを正しく増減させる", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-delete-restore", 2);
  const assets = await env.repository.getAssetsForBatch(batchId);
  expectOk(await env.adapter.deleteAsset({ photoAssetId: assets[0].id }, staffClaims()), "delete");
  let batch = await env.repository.getBatchById(batchId);
  assert.equal(batch?.manifest.expectedAssetCount, 1);

  const restored = expectOk(await env.adapter.restoreAsset({ photoAssetId: assets[0].id }, adminClaims()), "restore");
  assert.equal(restored.status, "READY");
  batch = await env.repository.getBatchById(batchId);
  assert.equal(batch?.manifest.expectedAssetCount, 2);
});

test("操作dispatch: linkToInventoryはREADY_FOR_REVIEWのbatchを未削除Inventoryへ紐付ける", async () => {
  const env = buildEnv();
  const batchId = await createAndFillBatch(env, "s-web-link", 1);
  await env.service.completePhotoBatch({ batchId, imageCountProcessed: 1, imageCountUploaded: 1 }, deviceClaims());
  env.ddb.inventoryTable.put({ id: "inv-web-1" });
  const linked = expectOk(await env.adapter.linkToInventory({ batchId, inventoryId: "inv-web-1" }, staffClaims()), "link");
  assert.equal(linked.status, "LINKED");
  const detail = expectOk(await env.adapter.getBatchDetail(batchId, staffClaims(), { page: 1, pageSize: 10 }), "detail after link") as WebBatchDetail;
  assert.equal(detail.batch.inventoryId, "inv-web-1");
});

// ─────────────────────────────────────────────────────────────────────────
// 6. 導線 (NAV_ITEMS配線) — 静的ソースの文字列確認。実レンダリングは対象外。
// ─────────────────────────────────────────────────────────────────────────

test("導線: InventoryNavRail.tsx のNAV_ITEMSに画像登録エントリとbadge hookが配線されている", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const navRailSource = readFileSync(path.join(here, "..", "app", "inventory", "InventoryNavRail.tsx"), "utf8");
  assert.match(navRailSource, /key:\s*"photo-registration"/, "NAV_ITEMSに画像登録キーが無い");
  assert.match(navRailSource, /href:\s*"\/inventory\/photo-registration"/, "画像登録のhrefが無い");
  assert.match(navRailSource, /label:\s*"画像登録"/, "画像登録のラベルが無い");
  assert.match(navRailSource, /export function usePhotoRegistrationBadge/, "badge hookがexportされていない");
});

test("導線: MobileBottomNav.tsx がInventoryNavRail.tsxと同じNAV_ITEMS/badge hookを共有している (デスクトップ/モバイルで食い違わない)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mobileSource = readFileSync(path.join(here, "..", "app", "inventory", "MobileBottomNav.tsx"), "utf8");
  assert.match(mobileSource, /import\s*\{\s*NAV_ITEMS,\s*usePhotoRegistrationBadge\s*\}\s*from\s*"\.\/InventoryNavRail"/, "NAV_ITEMS/usePhotoRegistrationBadgeの共有importが無い");
});

// ─────────────────────────────────────────────────────────────────────────
// 実行
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  await Promise.all(pendingTests);
  console.log(`\n[verify-photo-registration-web] ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`\nFAIL: ${failure}`);
    process.exitCode = 1;
  }
}

void main();
