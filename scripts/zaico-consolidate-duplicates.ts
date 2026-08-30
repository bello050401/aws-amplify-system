/**
 * ZAICO重複統合スクリプト(staging専用)。
 *
 * docs/zaico-duplicate-consolidation-plan-20260830.md の実行版。承認済みの
 * 方針は以下:
 *   - 正本 = 同一 sourceInventoryId のうち createdAt が最古(同点は id で
 *     安定ソート)。UI上の「在庫ID」である若いSKUが維持される。
 *   - 超過レコードは**物理削除**する(論理削除ではない)。
 *   - 「その重複自身が作られた」ことを記録した InventoryHistory は正本へ
 *     付け替えず、そのまま残す(承認事項3)。
 *   - 各ZAICO IDについて ZaicoSourceLink を正本へ向けて整備する。旧コード
 *     時代に同期された分はリンクを持たないため、これを作らないと以後の
 *     同期がフォールバックの全件スキャンを走らせ続け、原子的claimの保護も
 *     掛からない。
 *
 * 固有内容の扱い(実測に基づく設計):
 *   超過側にしか無い情報がある場合、その情報を正本へ機械的にマージする
 *   のではなく、**そのレコードを削除対象から外す**。理由は実データを見て
 *   分かったことで、判断が業務側にあるため:
 *     - 「正本に無い画像」に見えた11枚のZAICO画像は、実際には正本が持つ
 *       のと同じ写真(sourceUrlが完全一致)を別のS3キーへ再ダウンロード
 *       したものだった。移しても同じ写真が二重に並ぶだけ。
 *     - 一方2件は、同一ZAICO商品でありながら正本が「発送完了」、超過側が
 *       「出品待ち」という食い違ったカテゴリを持ち、超過側にEC出品下書きと
 *       利用者アップロード画像が付いていた。「発送完了」はEC出品の除外
 *       カテゴリなので、下書きだけを正本へ移すと除外カテゴリのレコードに
 *       下書きが乗ることになる。どちらの状態が正しいかはこのスクリプトが
 *       決めてよいものではない。
 *   よって固有内容を持つ超過レコードは削除せず残し、報告する(承認条件:
 *   「想定外の重要参照やデータ不整合が見つかった場合のみ、その対象の削除を
 *   止めて報告」)。同じグループ内の純粋な重複は予定どおり削除する。
 *
 * 安全設計:
 *   - 既定は dry-run。実際の書き込みは --execute を明示した時だけ。
 *   - 削除対象は「このスクリプト自身がその実行時に全件スキャンから計算した
 *     超過集合」に限定する。事前に作った id リストを信用しない。
 *   - 削除直前に1件ずつ再取得し、(a) まだ存在し (b) sourceInventoryId が
 *     計算時と一致し (c) 正本ではない ことを確認してから削除する。
 *   - 想定外の参照(ChannelListing/PriceHistory 等)を持つ超過レコードは
 *     削除せずスキップし、報告する(承認条件: 「想定外の重要参照やデータ
 *     不整合が見つかった場合のみ、その対象の削除を止めて報告」)。
 *   - ZAICO同期スケジュールが DISABLED であることを開始時に確認する。
 *     有効なままなら実行を拒否する(承認条件4)。
 *
 * 使い方:
 *   npx tsx scripts/zaico-consolidate-duplicates.ts            # dry-run
 *   npx tsx scripts/zaico-consolidate-duplicates.ts --execute  # 実行
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PROFILE = process.env.AWS_PROFILE_NAME ?? "Bello";
const REGION = "us-west-2";
const SUFFIX = "j6up24p7lnczdmklzjdt3vrp4y-NONE";
const T = (name: string) => `${name}-${SUFFIX}`;
const ZAICO_SCHEDULE = "amplify-d4hkkg7dty2du-cla-zaicosyncworkerlambdasch-JCU7FY8GOKX0";

const EXECUTE = process.argv.includes("--execute");
/** 固有内容を持つ超過レコードを、正本へ引き継いだうえで削除する。 */
const MERGE_HELD = process.argv.includes("--merge-held");
const OUT_DIR = process.argv.includes("--out-dir")
  ? process.argv[process.argv.indexOf("--out-dir") + 1]
  : ".";

const credentials = fromIni({ profile: PROFILE });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, credentials }));

/**
 * EventBridge Scheduler の状態は AWS CLI 経由で読む。@aws-sdk/client-scheduler
 * はこのリポジトリに入っていないため、この1つの確認のためだけに依存を
 * 増やすことはしない(CLIはこの手順の前提として既に必須)。
 */
function getScheduleState(name: string): string {
  const out = execFileSync(
    "aws",
    ["scheduler", "get-schedule", "--name", name, "--group-name", "default",
      "--profile", PROFILE, "--region", REGION, "--no-cli-pager", "--query", "State", "--output", "text"],
    { encoding: "utf8", env: { ...process.env, AWS_PAGER: "", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } },
  );
  return out.trim();
}

type Row = Record<string, unknown>;

/** Scan a whole table, following LastEvaluatedKey. Never returns a partial table. */
async function scanAll(table: string): Promise<Row[]> {
  const items: Row[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key as never }));
    items.push(...((res.Items ?? []) as Row[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return items;
}

const str = (r: Row, k: string): string | null => (typeof r[k] === "string" ? (r[k] as string) : null);

async function main(): Promise<void> {
  console.log(`=== ZAICO重複統合 ${EXECUTE ? "【実行モード】" : "【dry-run】"} ===\n`);

  // --- 承認条件4: 同期が止まっていることを確認する -------------------
  const schedState = getScheduleState(ZAICO_SCHEDULE);
  console.log(`zaico-sync-worker スケジュール: ${schedState}`);
  if (schedState !== "DISABLED") {
    throw new Error("ZAICO同期スケジュールがDISABLEDではありません。統合前に必ず停止すること。");
  }
  const jobs = await scanAll(T("ZaicoSyncJob"));
  const running = jobs.filter((j) => ["PENDING", "RUNNING"].includes(str(j, "status") ?? ""));
  console.log(`ZaicoSyncJob: ${jobs.map((j) => str(j, "status")).join(", ") || "(なし)"}`);
  if (running.length > 0) throw new Error("実行中のZaicoSyncJobがあります。完了/キャンセルを待つこと。");

  // --- 全件取得 ------------------------------------------------------
  const [inv, hist, drafts, links] = await Promise.all([
    scanAll(T("Inventory")),
    scanAll(T("InventoryHistory")),
    scanAll(T("ListingDraft")),
    scanAll(T("ZaicoSourceLink")),
  ]);
  // 想定外の参照元。0件であることが前提だが、毎回実測して確かめる。
  const [channelListings, priceHistories] = await Promise.all([
    scanAll(T("ChannelListing")),
    scanAll(T("PriceHistory")),
  ]);
  console.log(`\nInventory=${inv.length} History=${hist.length} ListingDraft=${drafts.length} ZaicoSourceLink=${links.length}`);
  console.log(`ChannelListing=${channelListings.length} PriceHistory=${priceHistories.length}`);

  // 生データのローカル退避(3つ目の復旧手段)
  const snapshot = path.join(OUT_DIR, `zaico-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(snapshot, JSON.stringify({ inv, hist, drafts, links, channelListings, priceHistories }, null, 1));
  console.log(`生データスナップショット: ${snapshot}`);

  // --- グループ化と正本判定 -------------------------------------------
  const groups = new Map<string, Row[]>();
  for (const i of inv) {
    const src = str(i, "sourceInventoryId");
    if (!src || str(i, "sourceSystem") !== "ZAICO") continue;
    if (!groups.has(src)) groups.set(src, []);
    groups.get(src)!.push(i);
  }
  const dupGroups = [...groups.entries()].filter(([, v]) => v.length > 1);

  const canonicalById = new Map<string, Row>(); // src -> canonical row
  const excess: { row: Row; canonical: Row; src: string }[] = [];
  for (const [src, v] of dupGroups) {
    const sorted = [...v].sort(
      (a, b) => (str(a, "createdAt") ?? "").localeCompare(str(b, "createdAt") ?? "") || (str(a, "id") ?? "").localeCompare(str(b, "id") ?? ""),
    );
    canonicalById.set(src, sorted[0]);
    for (const r of sorted.slice(1)) excess.push({ row: r, canonical: sorted[0], src });
  }
  console.log(`\ndistinct ZAICO ID : ${groups.size}`);
  console.log(`重複グループ数     : ${dupGroups.length}`);
  console.log(`超過レコード数     : ${excess.length}`);
  console.log(`統合後の想定件数   : ${inv.length - excess.length}`);

  const excessIds = new Set(excess.map((e) => e.row["id"] as string));
  const canonicalIds = new Set([...canonicalById.values()].map((r) => r["id"] as string));
  // 正本と超過が交差したら計算が壊れている。絶対に削除へ進まない。
  for (const id of excessIds) {
    if (canonicalIds.has(id)) throw new Error(`内部矛盾: ${id} が正本と超過の両方に含まれています。中止します。`);
  }

  // --- 想定外の参照チェック -------------------------------------------
  const refBy = (rows: Row[], field: string): Map<string, Row[]> => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const k = str(r, field);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  };
  const draftsBy = refBy(drafts, "inventoryId");
  const clBy = refBy(channelListings, "inventoryId");
  const phBy = refBy(priceHistories, "inventoryId");
  const histBy = refBy(hist, "inventoryId");

  const blocked: { id: string; reason: string }[] = [];
  for (const e of excess) {
    const id = e.row["id"] as string;
    if ((clBy.get(id) ?? []).length) blocked.push({ id, reason: `ChannelListing ${clBy.get(id)!.length}件` });
    if ((phBy.get(id) ?? []).length) blocked.push({ id, reason: `PriceHistory ${phBy.get(id)!.length}件` });
  }
  if (blocked.length) {
    console.log(`\n!! 想定外の参照を持つ超過レコード ${blocked.length} 件 — これらは削除しません:`);
    for (const b of blocked) console.log(`   ${b.id}: ${b.reason}`);
  } else {
    console.log(`\n想定外の参照(ChannelListing/PriceHistory)を持つ超過レコード: 0 件`);
  }
  const blockedIds = new Set(blocked.map((b) => b.id));

  // --- 超過側の固有内容を判定する -------------------------------------
  //
  // 画像の同一性は storageKey ではなく **sourceUrl** で見る。ZAICO由来の
  // 画像は、同期のたびに同じ写真が別のS3キーへ再ダウンロードされるため、
  // storageKeyで比較すると「正本に無い画像」に見えてしまう。実測では、
  // 超過側にしか無いように見えた11枚のZAICO画像は全て、正本が既に持って
  // いる写真と sourceUrl が完全一致していた——正本へ移すと同じ写真が
  // 二重に並ぶだけで、業務上の利得は無い。
  //
  // 逆に sourceUrl を持たず storageKey だけを持つ画像は、ZAICO由来では
  // なく**利用者がBELLO側でアップロードした画像**であり、その超過レコード
  // にしか存在しない実データである。
  const imageIdentity = (im: Record<string, unknown>): string =>
    (typeof im["sourceUrl"] === "string" && im["sourceUrl"]) ||
    (typeof im["storageKey"] === "string" && im["storageKey"]) ||
    JSON.stringify(im);
  const isUserUploaded = (im: Record<string, unknown>): boolean => !im["sourceUrl"] && Boolean(im["storageKey"]);

  type Held = {
    src: string; excessId: string; excessSku: string | null;
    canonicalId: string; canonicalSku: string | null; reasons: string[];
    draftIds: string[]; uploadedImages: Record<string, unknown>[];
  };
  const held: Held[] = [];
  for (const e of excess) {
    const id = e.row["id"] as string;
    const reasons: string[] = [];

    const draftIds = (draftsBy.get(id) ?? []).map((d) => d["id"] as string);
    if (draftIds.length) reasons.push(`EC出品下書き ${draftIds.length}件`);

    const exImages = (Array.isArray(e.row["images"]) ? e.row["images"] : []) as Record<string, unknown>[];
    const canImages = (Array.isArray(e.canonical["images"]) ? e.canonical["images"] : []) as Record<string, unknown>[];
    const canIdentities = new Set(canImages.map(imageIdentity));
    const uniqueImages = exImages.filter((im) => !canIdentities.has(imageIdentity(im)));
    const uploaded = uniqueImages.filter(isUserUploaded);
    if (uploaded.length) reasons.push(`利用者アップロード画像 ${uploaded.length}枚`);

    const exCat = str(e.row, "categoryId");
    const canCat = str(e.canonical, "categoryId");
    if (exCat && canCat && exCat !== canCat) reasons.push(`カテゴリ不一致(超過=${exCat.slice(0, 8)} 正本=${canCat.slice(0, 8)})`);

    if (reasons.length) {
      held.push({
        src: e.src, excessId: id, excessSku: str(e.row, "sku"),
        canonicalId: e.canonical["id"] as string, canonicalSku: str(e.canonical, "sku"),
        reasons, draftIds, uploadedImages: uploaded,
      });
    }
  }

  // 既定では、固有内容を持つ超過レコードはその1件だけを削除対象から外す
  // (グループ全体は止めない——同じグループの純粋な重複は予定どおり削除する)。
  //
  // --merge-held を付けると、固有内容を正本へ引き継いだうえで削除する。
  // 引き継ぐのは「その超過レコードにしか無い実データ」だけ:
  //   - ListingDraft.inventoryId を正本へ付け替える
  //   - 利用者がアップロードした画像(sourceUrlを持たない)を正本の images へ
  //     追加する
  // カテゴリは引き継がない。ZAICO同期が最新のZAICO情報で在庫情報を上書き
  // する運用のため、「発送完了」「出品待ち」のどちらを残すかを人手で決めても
  // 次の同期で上書きされる——ここで固定するのはかえって誤解を生む。
  console.log(`\n=== 固有内容を持つ超過レコード: ${held.length} 件 (${MERGE_HELD ? "引き継いでから削除" : "削除しない"}) ===`);
  for (const h of held) {
    console.log(`  ZAICO ${h.src}: ${h.excessSku}(${h.excessId.slice(0, 8)})  正本=${h.canonicalSku}(${h.canonicalId.slice(0, 8)})`);
    for (const r of h.reasons) console.log(`      - ${r}`);
  }
  if (!MERGE_HELD) for (const h of held) blockedIds.add(h.excessId);

  // --- ZaicoSourceLink バックフィル計画 --------------------------------
  // リンクidの組み立て規則は lib/inventory/zaicoSyncEngine.ts の
  // buildZaicoSourceLinkId(`${sourceSystem}#${sourceInventoryId}`)と一致して
  // いなければならない。ここでimportするとserver-onlyを引き込むため、実データ
  // 側で規則が今も成立していることを確認して同等性を担保する。
  for (const l of links) {
    const src = str(l, "sourceInventoryId");
    const id = str(l, "id");
    if (src && id !== `ZAICO#${src}`) {
      throw new Error(`ZaicoSourceLinkのid規則が想定と異なります(id=${id}, src=${src})。中止します。`);
    }
  }
  const linkBySrc = new Map(links.map((l) => [str(l, "sourceInventoryId") ?? "", l]));
  const missingLinks = [...groups.entries()].filter(([src]) => !linkBySrc.has(src));
  const wrongLinks = [...groups.entries()].filter(([src, v]) => {
    const l = linkBySrc.get(src);
    if (!l) return false;
    const target = str(l, "inventoryId");
    const survivor = canonicalById.get(src) ?? v[0];
    return target !== (survivor["id"] as string);
  });
  console.log(`\n=== ZaicoSourceLink ===`);
  console.log(`  リンク未作成      : ${missingLinks.length} 件 -> 正本を指すリンクを作成`);
  console.log(`  削除される行を指す: ${wrongLinks.filter(([src]) => { const l = linkBySrc.get(src)!; return excessIds.has(str(l, "inventoryId") ?? ""); }).length} 件 -> 正本へ張り替え`);

  console.log(`\n削除予定 : ${excess.length - blockedIds.size} 件`);
  console.log(`削除しない: ${blockedIds.size} 件(固有内容あり / 想定外参照あり)`);
  console.log(`InventoryHistory: 付け替えない(承認事項3) — 超過を指す ${excess.reduce((n, e) => n + (histBy.get(e.row["id"] as string) ?? []).length, 0)} 件はそのまま残る`);

  if (!EXECUTE) {
    console.log(`\n--- dry-run のためここで終了。書き込みは一切行っていません。---`);
    console.log(`実行するには --execute を付けてください。`);
    return;
  }

  // ================= ここから実書き込み =================
  if (MERGE_HELD && held.length) {
    console.log(`\n=== 固有内容を正本へ引き継ぎ ===`);
    for (const h of held) {
      for (const draftId of h.draftIds) {
        await ddb.send(new UpdateCommand({
          TableName: T("ListingDraft"), Key: { id: draftId },
          UpdateExpression: "SET inventoryId = :inv, updatedAt = :now",
          // 付け替え元が想定どおりであることを条件にする——別の同期や操作が
          // 先にこのdraftを動かしていた場合は、黙って上書きせず失敗させる。
          ConditionExpression: "inventoryId = :from",
          ExpressionAttributeValues: { ":inv": h.canonicalId, ":from": h.excessId, ":now": new Date().toISOString() },
        }));
        console.log(`  ListingDraft ${draftId.slice(0, 8)} : ${h.excessSku} -> ${h.canonicalSku}`);
      }
      if (h.uploadedImages.length) {
        // 正本の既存画像は一切変更しない。取り込む画像は必ず isPrimary:false
        // にする——正本には既にprimaryがあり、primaryが2枚ある状態は不正。
        // どれを主写真にするかはUIから1クリックで変えられる。
        const cur = await ddb.send(new GetCommand({ TableName: T("Inventory"), Key: { id: h.canonicalId } }));
        const curImages = (Array.isArray(cur.Item?.["images"]) ? cur.Item!["images"] : []) as Record<string, unknown>[];
        const curIdentities = new Set(curImages.map(imageIdentity));
        const toAdd: Record<string, unknown>[] = h.uploadedImages
          .filter((im) => !curIdentities.has(imageIdentity(im)))
          .map((im, i) => ({ ...im, isPrimary: false, sortOrder: curImages.length + i }));
        if (toAdd.length) {
          await ddb.send(new UpdateCommand({
            TableName: T("Inventory"), Key: { id: h.canonicalId },
            UpdateExpression: "SET images = :img, updatedAt = :now",
            ExpressionAttributeValues: { ":img": [...curImages, ...toAdd], ":now": new Date().toISOString() },
          }));
          for (const im of toAdd) console.log(`  画像 ${String(im["storageKey"]).slice(0, 40)} -> ${h.canonicalSku} (isPrimary=false で追加)`);
        }
      }
    }
  }

  console.log(`\n=== ZaicoSourceLink を正本へ整備 ===`);
  let linkWrites = 0;
  for (const [src] of groups) {
    const survivor = canonicalById.get(src) ?? groups.get(src)![0];
    const survivorId = survivor["id"] as string;
    const existing = linkBySrc.get(src);
    const target = existing ? str(existing, "inventoryId") : null;
    if (target === survivorId) continue;
    const linkId = `ZAICO#${src}`;
    const now = new Date().toISOString();
    await ddb.send(new UpdateCommand({
      TableName: T("ZaicoSourceLink"), Key: { id: linkId },
      UpdateExpression: "SET inventoryId = :inv, sourceSystem = :ss, sourceInventoryId = :src, updatedAt = :now, createdAt = if_not_exists(createdAt, :now), #tn = :tn",
      ExpressionAttributeNames: { "#tn": "__typename" },
      ExpressionAttributeValues: { ":inv": survivorId, ":ss": "ZAICO", ":src": src, ":now": now, ":tn": "ZaicoSourceLink" },
    }));
    linkWrites++;
  }
  console.log(`  ${linkWrites} 件のリンクを作成/張り替え`);

  console.log(`\n=== 超過レコードを物理削除 ===`);
  let deleted = 0;
  const skipped: string[] = [];
  for (const e of excess) {
    const id = e.row["id"] as string;
    if (blockedIds.has(id)) { skipped.push(`${id}(固有内容/想定外参照のため保護)`); continue; }
    // 削除直前の再確認 — 計算時の前提が今も成立しているか1件ずつ確かめる
    const cur = await ddb.send(new GetCommand({ TableName: T("Inventory"), Key: { id } }));
    if (!cur.Item) { skipped.push(`${id}(既に存在しない)`); continue; }
    if (str(cur.Item as Row, "sourceInventoryId") !== e.src) { skipped.push(`${id}(sourceInventoryIdが変化)`); continue; }
    if (canonicalIds.has(id)) { skipped.push(`${id}(正本)`); continue; }
    await ddb.send(new DeleteCommand({
      TableName: T("Inventory"), Key: { id },
      // 競合で別の行に化けていた場合に備え、削除条件でも同一性を縛る
      ConditionExpression: "id = :id AND sourceInventoryId = :src",
      ExpressionAttributeValues: { ":id": id, ":src": e.src },
    }));
    deleted++;
    if (deleted % 50 === 0) console.log(`  ${deleted} 件削除...`);
  }
  console.log(`  削除完了: ${deleted} 件`);
  if (skipped.length) { console.log(`  スキップ: ${skipped.length} 件`); for (const s of skipped) console.log(`    ${s}`); }

  // --- 事後検証 -------------------------------------------------------
  console.log(`\n=== 事後検証(再スキャン) ===`);
  const [inv2, drafts2, links2] = await Promise.all([scanAll(T("Inventory")), scanAll(T("ListingDraft")), scanAll(T("ZaicoSourceLink"))]);
  const g2 = new Map<string, Row[]>();
  for (const i of inv2) {
    const src = str(i, "sourceInventoryId");
    if (!src) continue;
    if (!g2.has(src)) g2.set(src, []);
    g2.get(src)!.push(i);
  }
  const stillDup = [...g2.entries()].filter(([, v]) => v.length > 1);
  console.log(`  Inventory 件数        : ${inv2.length}`);
  console.log(`  distinct ZAICO ID     : ${g2.size}`);
  console.log(`  残存重複グループ      : ${stillDup.length}`);
  const invIds = new Set(inv2.map((i) => i["id"] as string));
  const orphanDrafts = drafts2.filter((d) => { const k = str(d, "inventoryId"); return k && !invIds.has(k); });
  console.log(`  参照先を失ったListingDraft: ${orphanDrafts.length}`);
  const orphanLinks = links2.filter((l) => { const k = str(l, "inventoryId"); return k && !invIds.has(k); });
  console.log(`  参照先を失ったZaicoSourceLink: ${orphanLinks.length}`);
  console.log(`  ZaicoSourceLink 件数  : ${links2.length}`);
  if (stillDup.length) { console.log(`  !! 残存重複:`); for (const [src, v] of stillDup.slice(0, 10)) console.log(`     ${src}: ${v.length}件`); }
}

main().catch((err) => {
  console.error("\n統合スクリプトが失敗しました:", err);
  process.exit(1);
});
