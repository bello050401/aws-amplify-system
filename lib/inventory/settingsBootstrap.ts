import "server-only";
import { dedupeMasterEntries } from "@/lib/inventory/masterDedupe";
import { seedInventoryMasters } from "@/lib/inventory/masterSeed";
import { seedCustomFieldDefinitions } from "@/lib/inventory/customFieldSeed";
import { seedShippingRates } from "@/lib/shipping/service";

/**
 * 設定画面の初回ブートストラップ(マスタのdedupe + 各種seed)を、
 * **リクエストごとではなく、サーバープロセスごとに最大1回**だけ走らせる。
 *
 * ## なぜ必要になったか
 *
 * 設定ページはADMINが開くたびに
 *   dedupeMasterEntries("Category"), dedupeMasterEntries("Location"),
 *   seedInventoryMasters(), seedCustomFieldDefinitions(), seedShippingRates()
 * を実行していた。マスタが数十件のうちは「毎回ほぼ何もしない」で済んで
 * いたが、家財おまかせ便の料金マスターが2件から450件になった時点で、
 * seedShippingRatesが1回のページ描画中に400件以上の書き込みを試みる
 * ようになり、設定ページが高い確率で500になった(実測: 8回中7回失敗、
 * ShippingRateは450件中134件だけ入った中途半端な状態で止まっていた)。
 *
 * ブートストラップは本来「一度整えば済む」作業であって、画面を開くたびに
 * 走らせるものではない。ここでプロセス単位に畳み込む。
 *
 * ## 失敗はキャッシュしない
 *
 * 成功したときだけ「完了」を記録する。失敗した場合は次のリクエストで
 * もう一度試す——一度失敗しただけでそのコンテナが二度とseedしなく
 * なる状態を作らないため。
 *
 * ## 1回あたりの書き込み量を絞る
 *
 * 料金マスターの投入は`maxWrites`で上限を設ける。1リクエストで全件を
 * 入れ切ろうとして描画時間を食い潰すより、数回のアクセスに分けて確実に
 * 完了させる方が安全(seedShippingRatesは冪等なので、残りは次回続きから
 * 入る)。
 */

/** 1回のブートストラップで投入する料金マスターの最大件数。 */
const SHIPPING_SEED_MAX_WRITES_PER_RUN = 60;

let completed = false;
let inFlight: Promise<void> | null = null;

async function runBootstrap(): Promise<void> {
  // Unitはdedupe未対応(masterDedupe.tsのガード参照 — 新規追加のため
  // 過去の重複が存在しない)。
  await Promise.all([dedupeMasterEntries("Category"), dedupeMasterEntries("Location")]);
  // seedCustomFieldDefinitionsはCategory/Location/Unitと無関係なので
  // 上のdedupeを待つ必要はない。
  const [, , shipping] = await Promise.all([
    seedInventoryMasters(),
    seedCustomFieldDefinitions(),
    seedShippingRates({ maxWrites: SHIPPING_SEED_MAX_WRITES_PER_RUN }),
  ]);
  // 料金マスターが残っている間は「完了」にしない — 次のアクセスで続きを
  // 投入する。残り0になって初めてこのプロセスでのブートストラップを終える。
  if (shipping.remaining === 0) completed = true;
}

/**
 * 設定画面の描画前に呼ぶ。既に完了していれば即座に返る。
 * 同時に複数リクエストが来ても、実際の処理は1つに畳まれる。
 */
export async function ensureSettingsBootstrap(): Promise<void> {
  if (completed) return;
  if (inFlight) return inFlight;
  inFlight = runBootstrap()
    .catch((err) => {
      // 失敗しても completed は立てない(次回再試行する)。設定画面自体は
      // 描画できるべきなので、ここで例外を投げてページを落とさない。
      console.error("[ensureSettingsBootstrap] 失敗:", err instanceof Error ? err.message : err);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
