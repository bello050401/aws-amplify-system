/**
 * 家財配送サービスの呼称(2026-09-04 追加指示)。
 *
 * ── なぜ1箇所に集めるのか ──────────────────────────────────────
 *
 * 同じサービスが画面によって別の名前で出ていた:
 *
 *   設定 → 配送料金タブ        「家財おまかせ便」
 *   EC出品 → 送料見積り        「家財おまかせ便」
 *   EC出品 → 商品説明の発送欄  「らくらく家財便」(顧客が読む文面)
 *   ShippingRate.service       「家財おまかせ便」(450行の実データ)
 *
 * 同じものを指しているのに、画面をまたぐと呼び名が2つ見える。名前を
 * 各所へ書き写す限り必ずまた分岐するので、**文字列の出所を1つにする**。
 *
 * ── なぜ server-only を付けないのか ────────────────────────────
 *
 * 設定画面の料金パネル(client component)からも使う。料金の実データを
 * 持つ lib/shipping/ratesSeed.ts は server-only で、450行の配列ごと
 * クライアントへ運ばれてしまうため、名前だけをこの小さなモジュールへ
 * 切り出してある。
 */

/**
 * 顧客・担当者の双方へ出す名称。
 *
 * 商品説明の「◎発送について」もこの名前で書く。運送事業者側の正式名称は
 * KAZAI_PROVIDER_NAME(アートセッティングデリバリー)で、こちらはBELLOが
 * 日常的に使っているサービス名。
 */
export const KAZAI_SERVICE_NAME = "らくらく家財便";

/** 運送事業者名。ShippingRate.provider に入る値。 */
export const KAZAI_PROVIDER_NAME = "アートセッティングデリバリー";

/**
 * 以前使っていた呼称。
 *
 * 2026-09-04 に「らくらく家財便」へ統一するまで、ShippingRate.service には
 * この値が入っていた(実測450行)。**データ移行後もここへ残す** ——
 * 移行が届かなかった行や、古いCSVを読み込んだ場合に、同じサービスだと
 * 判定できるようにするため。
 */
export const LEGACY_KAZAI_SERVICE_NAMES = ["家財おまかせ便"] as const;

/** 家財配送サービスを指す名前か(新旧どちらの呼称でも真)。 */
export function isKazaiServiceName(value: string | null | undefined): boolean {
  const v = value?.trim();
  if (!v) return false;
  return v === KAZAI_SERVICE_NAME || (LEGACY_KAZAI_SERVICE_NAMES as readonly string[]).includes(v);
}

/** 表示用に現在の呼称へ寄せる。未知の値はそのまま返す(勝手に書き換えない)。 */
export function displayShippingServiceName(value: string | null | undefined): string {
  const v = value?.trim();
  if (!v) return KAZAI_SERVICE_NAME;
  return isKazaiServiceName(v) ? KAZAI_SERVICE_NAME : v;
}
