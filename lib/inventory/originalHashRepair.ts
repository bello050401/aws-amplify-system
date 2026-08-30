import "server-only";
import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { serverDataClient, inventoryAuthMode } from "@/lib/amplify/dataClient";
import { computeOriginalHash } from "@/lib/imageProcessing/pipeline";

/**
 * 夜間長時間・全課題解決指示書 §5 の根本修正。
 *
 * ## 何が起きていたか
 *
 * 商品詳細で「画像を自動加工」を押しても、
 *   「2件の画像はoriginalHash未計算のため加工を予約できませんでした
 *    （詳細画面で画像を保存し直すと自己修復されます）」
 * と表示され、加工状況が 0/2 のまま進まない状態になっていた。
 * 利用者に「画像を保存し直す」という無関係な操作を強いており、
 * 指示書はこれを完成扱いしないと明記している。
 *
 * ## 欠落していた理由(実測)
 *
 * `originalHash`は、画像バイト列のSHA-256をアップロード/取り込み時に
 * 計算して保存するフィールド。ZAICO同期には2つの経路があり、
 *   - `amplify/functions/zaico-sync-worker/lambdaSyncPort.ts` は
 *     取り込んだバイト列からhashを計算して保存する
 *   - それ以前のブラウザ駆動同期経路は計算していなかった
 * ため、旧経路で同期された商品の画像だけがhashを持たない。
 *
 * staging実データでの実測: 画像1,009枚中 **146枚**にhashが無く、
 * **138商品**は保有画像が全てhash無し——これが利用者の見た「0/2」。
 *
 * ## この修正の方針
 *
 * 加工予約の時点でhashが欠けていたら、サーバー側で元画像を取得して
 * hashを計算し、Inventoryへ保存したうえで**そのまま予約を続行する**。
 * 利用者に何かをやり直させない。
 *
 * 計算済みのhashは決して再計算しない(`ensureOriginalHash`は既存値が
 * あれば即座にそれを返す)ため、1,000件規模でも毎回の再ダウンロードは
 * 発生しない——修復は1画像につき最初の一度だけ。
 *
 * 元画像が本当に存在しない場合だけ、利用者が理解できる回復可能エラー
 * (`OriginalImageMissingError`)を投げる。内部stackやSecretは出さない。
 */

/** 元画像がS3に存在せず、hashを計算しようがない場合。呼び出し側はこの1枚だけをスキップし、他の画像の予約は続行する。 */
export class OriginalImageMissingError extends Error {
  readonly storageKey: string;
  constructor(storageKey: string) {
    super("元画像が見つからないため、この画像の加工を予約できませんでした。画像を登録し直してください。");
    this.name = "OriginalImageMissingError";
    this.storageKey = storageKey;
  }
}

/**
 * S3上の自オブジェクトのバイト列を取得する。
 *
 * 導入済みの@aws-amplify/storageのサーバー面には「オブジェクトのバイト
 * 列を直接取る」APIが無い(getProperties/getUrl/list/remove/copy/
 * uploadDataのみ)ため、短命の署名付きGET URLを取ってfetchする——
 * `lib/inventory/thumbnail.ts`のgenerateInventoryThumbnailが既に
 * 使っているのと同じ手段をそのまま踏襲する(新しい取得経路を増やさない)。
 */
async function fetchOwnObjectBytes(storageKey: string): Promise<Buffer | null> {
  try {
    const { url } = await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => getUrl(contextSpec, { path: storageKey }),
    });
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 指定したInventoryの`images`のうち、`storageKey`が一致するものへ
 * `originalHash`を書き戻す。
 *
 * `images`はInventoryのcustom type配列なので、部分更新はできず配列全体を
 * 書き直す必要がある。**hashを足す以外のフィールドは一切変更しない**
 * (既存のclassification/isPrimary/sortOrder/thumbnailKey等はそのまま
 * 持ち回る)。
 *
 * 一覧の並び順を動かさないため`listUpdatedAt`は更新しない——
 * `lib/inventory/listingPartitionBackfill.ts`が同じ理由で
 * 「バックフィル自身が一覧を押し上げてはいけない」と警告しているのと
 * 同じ判断。ここで行うのは利用者が意図した内容変更ではなく、
 * 欠けていた内部メタデータの補完に過ぎない。
 */
async function persistOriginalHash(inventoryId: string, storageKey: string, hash: string): Promise<void> {
  const { data: current } = await serverDataClient.models.Inventory.get({ id: inventoryId }, inventoryAuthMode);
  if (!current) return;
  const images = (current.images ?? []) as ({ storageKey?: string | null; originalHash?: string | null } & Record<string, unknown>)[];
  let changed = false;
  const next = images.map((img) => {
    if (img?.storageKey !== storageKey || img?.originalHash) return img;
    changed = true;
    return { ...img, originalHash: hash };
  });
  if (!changed) return;
  const { errors } = await serverDataClient.models.Inventory.update({ id: inventoryId, images: next as never }, inventoryAuthMode);
  if (errors) {
    // 保存に失敗しても、算出済みのhashで今回の予約自体は続行できる
    // (次回また修復を試みるだけ)。予約を巻き添えで失敗させない。
    console.error(`[originalHashRepair] failed to persist hash for inventory=${inventoryId}:`, JSON.stringify(errors));
  }
}

/**
 * 加工予約の直前に呼ぶ。既にhashがあればそれを返し、無ければ
 * 元画像から計算して保存したうえで返す。
 *
 * @throws {OriginalImageMissingError} 元画像がS3から取得できない場合のみ。
 */
export async function ensureOriginalHash(input: {
  inventoryId: string;
  storageKey: string;
  originalHash: string | null | undefined;
}): Promise<string> {
  if (input.originalHash) return input.originalHash; // 計算済みは再計算しない
  const bytes = await fetchOwnObjectBytes(input.storageKey);
  if (!bytes || bytes.length === 0) throw new OriginalImageMissingError(input.storageKey);
  const hash = computeOriginalHash(bytes);
  await persistOriginalHash(input.inventoryId, input.storageKey, hash);
  return hash;
}
