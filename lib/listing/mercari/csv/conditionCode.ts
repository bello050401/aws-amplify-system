import { LISTING_CONDITIONS } from "../../conditionOptions";
import type { ListingConditionCode } from "../../types";

/**
 * BELLO共通の商品状態コード(ListingConditionCode)→Mercari Shops CSVの
 * 「商品の状態」列(1〜6)への変換。
 *
 * `lib/listing/conditionOptions.ts`のLISTING_CONDITIONSは、指示書§4に
 * 書かれた1〜6の順序(新品/未使用に近い/目立った傷汚れなし/やや傷汚れ/
 * 傷汚れ/全体的状態悪)とラベルの意味がそのまま一致しているため、配列の
 * 並び順(0始まり)+1をコードとして使う。BELLO独自評価(conditionRating
 * 等)を直接数値化するのではなく、このテーブル経由でのみ変換する。
 */
const CONDITION_TO_CODE: Record<ListingConditionCode, 1 | 2 | 3 | 4 | 5 | 6> = LISTING_CONDITIONS.reduce(
  (acc, entry, index) => {
    acc[entry.code] = (index + 1) as 1 | 2 | 3 | 4 | 5 | 6;
    return acc;
  },
  {} as Record<ListingConditionCode, 1 | 2 | 3 | 4 | 5 | 6>,
);

export function conditionCodeToCsvValue(code: ListingConditionCode): 1 | 2 | 3 | 4 | 5 | 6 {
  return CONDITION_TO_CODE[code];
}
