"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getBaseClient } from "@/lib/base";
import { extractProductIntro } from "@/lib/ai/productIntro/extract";
import { splitBaseDescription, toPlainText } from "@/lib/base/archive/sections";
import { baseBrandHint, baseTitleCore } from "@/lib/base/archive/similar";
import { buildStyleProfile, type StyleProfileSourceItem } from "@/lib/ai/productIntro/styleProfile";

/**
 * 過去BASE商品の取り込みと、文体プロファイルの作り直し。
 *
 * ## 読み取りだけ
 *
 * BASEに対して行うのは商品一覧の取得のみ。BASEへは何も書き込まない
 * (書き込みは lib/integrations/writeGuard.ts が別途止めている)。
 *
 * ## 再実行しても重複しない
 *
 * BaseProductArchive の識別子はBASEの item_id そのもの。同じ商品を
 * 何度取り込んでも行は1つで、中身が新しくなるだけ。
 */

export interface BaseArchiveStatus {
  archivedItems: number;
  withIntro: number;
  periodStart: string | null;
  periodEnd: string | null;
  lastSyncedAt: string | null;
  styleProfileVersion: number | null;
  styleProfileAnalyzedItems: number | null;
  styleProfileGeneratedAt: string | null;
  styleProfileConfidence: number | null;
}

export type BaseArchiveActionResult<T> = { ok: true; data: T } | { ok: false; error: string; correlationId: string };

async function listAllArchive() {
  const rows: Awaited<ReturnType<typeof serverDataClient.models.BaseProductArchive.list>>["data"] = [];
  let nextToken: string | null | undefined;
  do {
    const { data, nextToken: nt, errors } = await serverDataClient.models.BaseProductArchive.list({
      limit: 200,
      nextToken: nextToken ?? undefined,
      ...inventoryAuthMode,
    });
    if (errors) throw new Error(`過去BASE商品の取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
    rows.push(...data);
    nextToken = nt;
  } while (nextToken);
  return rows;
}

export async function getBaseArchiveStatusAction(): Promise<BaseArchiveActionResult<BaseArchiveStatus>> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    if (!role) return { ok: false, error: "ログインが必要です。", correlationId };

    const rows = await listAllArchive();
    const times = rows.map((r) => r.modifiedAt).filter((t): t is string => Boolean(t)).sort();
    const synced = rows.map((r) => r.syncedAt).filter((t): t is string => Boolean(t)).sort();

    const { data: profiles, errors } = await serverDataClient.models.BelloStyleProfile.list({ ...inventoryAuthMode, limit: 100 });
    if (errors) throw new Error(`文体プロファイルの取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
    const active = profiles.find((p) => p.isActive === true) ?? null;

    return {
      ok: true,
      data: {
        archivedItems: rows.length,
        withIntro: rows.filter((r) => r.introText).length,
        periodStart: times[0] ?? null,
        periodEnd: times[times.length - 1] ?? null,
        lastSyncedAt: synced[synced.length - 1] ?? null,
        styleProfileVersion: active?.version ?? null,
        styleProfileAnalyzedItems: active?.analyzedItemCount ?? null,
        styleProfileGeneratedAt: active?.generatedAt ?? null,
        styleProfileConfidence: active?.confidence ?? null,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "状態の取得に失敗しました。", correlationId };
  }
}

export interface BaseArchiveSyncSummary {
  fetched: number;
  saved: number;
  withIntro: number;
  failed: number;
}

/**
 * BASEから過去商品を取り込む。BASEのAPI制限を尊重して順に読む。
 */
export async function syncBaseArchiveAction(): Promise<BaseArchiveActionResult<BaseArchiveSyncSummary>> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    if (!canEditInventory(role)) return { ok: false, error: "この操作にはADMINまたはEDITOR権限が必要です。", correlationId };

    // 既存のBASEクライアントをそのまま使う(認証・トークン更新も既存経路)。
    const search = await getBaseClient().search({ query: "", limit: 1000 });
    const items = search.items;
    const now = new Date().toISOString();

    let saved = 0;
    let failed = 0;
    let withIntro = 0;

    for (const item of items) {
      const sections = splitBaseDescription(item.description);
      const intro = extractProductIntro(item.description);
      if (intro.ok) withIntro++;

      const { errors } = await serverDataClient.models.BaseProductArchive.create(
        {
          baseItemId: item.itemId,
          title: item.title,
          detailRaw: item.description,
          detailText: toPlainText(item.description),
          introText: intro.ok ? intro.intro : undefined,
          sectionsJson: JSON.stringify(sections.map((s) => ({ kind: s.kind, heading: s.heading, order: s.order, length: s.body.length }))),
          price: item.price,
          stock: item.stock,
          visible: item.isPublished,
          imageUrlsJson: JSON.stringify(item.images.map((i) => i.url)),
          variationsJson: JSON.stringify(item.variations ?? []),
          itemUrl: item.itemUrl || undefined,
          brandHintsJson: JSON.stringify([baseBrandHint(item.title)].filter(Boolean)),
          titleCore: baseTitleCore(item.title),
          syncedAt: now,
        },
        inventoryAuthMode,
      );

      if (errors) {
        // 既に存在する行は create が衝突する。その場合は更新する。
        const { errors: updateErrors } = await serverDataClient.models.BaseProductArchive.update(
          {
            baseItemId: item.itemId,
            title: item.title,
            detailRaw: item.description,
            detailText: toPlainText(item.description),
            introText: intro.ok ? intro.intro : undefined,
            price: item.price,
            stock: item.stock,
            visible: item.isPublished,
            titleCore: baseTitleCore(item.title),
            syncedAt: now,
          },
          inventoryAuthMode,
        );
        if (updateErrors) {
          failed++;
          continue;
        }
      }
      saved++;
    }

    revalidatePath("/inventory/settings");
    return { ok: true, data: { fetched: items.length, saved, withIntro, failed } };
  } catch (err) {
    console.error("[syncBaseArchiveAction] failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: err instanceof Error ? err.message : "BASE商品の取り込みに失敗しました。", correlationId };
  }
}

/**
 * 取り込み済みの過去商品から文体プロファイルを作り直す。
 * 既存版は上書きせず、新しい version として積む(生成物がversionを
 * 参照するので、後から突き合わせられるようにする)。
 */
export async function rebuildStyleProfileAction(): Promise<BaseArchiveActionResult<{ version: number; analyzed: number; confidence: number }>> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    if (role !== "ADMIN") return { ok: false, error: "この操作にはADMIN権限が必要です。", correlationId };
    const who = await getCurrentInventoryUserEmail();

    const rows = await listAllArchive();
    if (rows.length === 0) {
      return { ok: false, error: "過去BASE商品が取り込まれていません。先に「BASE商品を取り込む」を実行してください。", correlationId };
    }

    const source: StyleProfileSourceItem[] = rows.map((r) => ({
      baseItemId: r.baseItemId,
      title: r.title ?? "",
      description: r.detailRaw ?? "",
      modifiedAt: r.modifiedAt ?? null,
      price: r.price ?? null,
    }));
    const profile = buildStyleProfile(source);

    const { data: existing, errors: listErrors } = await serverDataClient.models.BelloStyleProfile.list({ ...inventoryAuthMode, limit: 100 });
    if (listErrors) throw new Error(listErrors.map((e) => e.message).join("; "));
    const nextVersion = existing.reduce((max, p) => Math.max(max, p.version ?? 0), 0) + 1;

    const { errors } = await serverDataClient.models.BelloStyleProfile.create(
      {
        version: nextVersion,
        isActive: true,
        analyzedItemCount: profile.analyzedItemCount,
        analysisPeriodStart: profile.analysisPeriod.start ?? undefined,
        analysisPeriodEnd: profile.analysisPeriod.end ?? undefined,
        profileJson: JSON.stringify(profile),
        confidence: profile.confidence,
        generatedAt: profile.generatedAt,
        generatedBy: who ?? undefined,
      },
      inventoryAuthMode,
    );
    if (errors) throw new Error(errors.map((e) => e.message).join("; "));

    // 旧版を落とす。AIが参照するのは isActive の1件、という不変条件を保つ。
    for (const p of existing) {
      if (p.isActive !== true) continue;
      await serverDataClient.models.BelloStyleProfile.update({ id: p.id, isActive: false }, inventoryAuthMode);
    }

    revalidatePath("/inventory/settings");
    return { ok: true, data: { version: nextVersion, analyzed: profile.analyzedItemCount, confidence: profile.confidence } };
  } catch (err) {
    console.error("[rebuildStyleProfileAction] failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: err instanceof Error ? err.message : "文体プロファイルの作成に失敗しました。", correlationId };
  }
}
