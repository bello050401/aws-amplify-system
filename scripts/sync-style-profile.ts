/**
 * BaseProductArchive を読んで BELLO Style Profile を作り、新しい version
 * として保存する(既存版は isActive=false へ落とす)。
 *
 * 上書きではなく追記にするのは、生成物(GeneratedProductPage)が
 * styleProfileVersion を持つため —— 後から「どの分析でこの文章が
 * 生成されたか」を辿れるようにする。
 *
 * Run: AWS_PROFILE=Bello node scripts/with-server-only-stub.cjs scripts/sync-style-profile.ts
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { buildStyleProfile, type StyleProfileSourceItem } from "@/lib/ai/productIntro/styleProfile";

const SUFFIX = "j6up24p7lnczdmklzjdt3vrp4y-NONE";
const ARCHIVE = process.env.BASE_ARCHIVE_TABLE || `BaseProductArchive-${SUFFIX}`;
const PROFILE = process.env.STYLE_PROFILE_TABLE || `BelloStyleProfile-${SUFFIX}`;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-west-2" }));

async function scanAll(table: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }));
    out.push(...((res.Items ?? []) as Record<string, unknown>[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

async function main() {
  const archive = await scanAll(ARCHIVE);
  console.log(`archive rows: ${archive.length}`);

  const source: StyleProfileSourceItem[] = archive.map((r) => ({
    baseItemId: String(r.baseItemId),
    title: String(r.title ?? ""),
    description: String(r.detailRaw ?? ""),
    modifiedAt: (r.modifiedAt as string | null) ?? null,
    price: typeof r.price === "number" ? r.price : null,
  }));

  const profile = buildStyleProfile(source);

  const existing = await scanAll(PROFILE);
  const nextVersion = existing.reduce((max, r) => Math.max(max, Number(r.version) || 0), 0) + 1;

  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: PROFILE,
    Item: {
      id: randomUUID(),
      version: nextVersion,
      isActive: true,
      analyzedItemCount: profile.analyzedItemCount,
      analysisPeriodStart: profile.analysisPeriod.start,
      analysisPeriodEnd: profile.analysisPeriod.end,
      profileJson: JSON.stringify(profile),
      confidence: profile.confidence,
      generatedAt: profile.generatedAt,
      generatedBy: "scripts/sync-style-profile.ts",
      createdAt: now,
      updatedAt: now,
      __typename: "BelloStyleProfile",
    },
  }));

  // 旧版を落とす。AIが参照するのは isActive=true の1件だけという不変条件を保つ。
  for (const row of existing) {
    if (row.isActive !== true) continue;
    await ddb.send(new UpdateCommand({
      TableName: PROFILE,
      Key: { id: row.id },
      UpdateExpression: "SET isActive = :f, updatedAt = :t",
      ExpressionAttributeValues: { ":f": false, ":t": now },
    }));
  }

  const after = await scanAll(PROFILE);
  console.log(JSON.stringify({
    savedVersion: nextVersion,
    totalProfileRows: after.length,
    activeRows: after.filter((r) => r.isActive === true).length,
    analyzedItemCount: profile.analyzedItemCount,
    introExtractedCount: profile.introExtractedCount,
    confidence: profile.confidence,
    period: profile.analysisPeriod,
    requiredSections: profile.sectionRules.filter((s) => s.required).map((s) => `${s.heading}(${(s.ratio * 100).toFixed(0)}%)`),
    dimensionInIntroRatio: profile.sizePlacementRules.dimensionInIntroRatio,
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
