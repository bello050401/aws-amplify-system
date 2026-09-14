import type { MercariCsvFieldError, MercariCsvRowFields, MercariCsvRowValidation } from "./types";

/** Unicode文字単位(コードポイント単位)での文字数。サロゲートペア
 * (絵文字等)を2文字と誤カウントしないための境界対応。結合文字列や
 * 異体字セレクタは1コードポイントずつ数える(BELLO側で「書記素クラス
 * タ単位」まで揃える要件は指示書になく、Mercari側テンプレートの
 * 「はじめに」シートの文字数説明もコードポイント単位が前提と判断)。 */
export function unicodeLength(text: string): number {
  return Array.from(text).length;
}

const MANAGEMENT_CODE_RE = /^[A-Za-z0-9_-]{1,50}$/;
const JAN_CODE_RE = /^[A-Za-z0-9_-]{1,14}$/;
/** Excelで数式として実行されうる先頭文字。クオートだけでは防げないため
 * 検出して警告/明示修正の対象にする(商品文言を黙って変えない)。 */
const FORMULA_LEADING_CHAR_RE = /^[=+\-@\t\r]/;

export function detectFormulaInjectionRisk(text: string): boolean {
  return FORMULA_LEADING_CHAR_RE.test(text);
}

function err(field: MercariCsvFieldError["field"], message: string): MercariCsvFieldError {
  return { field, message };
}

/**
 * 1行分のフィールドを検証する。重大エラーがあれば`ok: false`——
 * 呼び出し側はこの行を「黙って除外して成功扱い」にしてはならず、
 * 生成全体を止めて理由を出す。
 */
export function validateMercariCsvRow(fields: MercariCsvRowFields): MercariCsvRowValidation {
  const errors: MercariCsvFieldError[] = [];

  if (unicodeLength(fields.productName) === 0) {
    errors.push(err("productName", "商品名が空です"));
  } else if (unicodeLength(fields.productName) > 130) {
    errors.push(err("productName", `商品名は130文字以内です(現在${unicodeLength(fields.productName)}文字)`));
  }
  if (detectFormulaInjectionRisk(fields.productName)) {
    errors.push(err("productName", "商品名が数式起点文字(=,+,-,@等)で始まっています。CSVクオートだけではExcel対策にならないため、内容を確認し明示的に修正してください"));
  }

  if (unicodeLength(fields.productDescription) > 3000) {
    errors.push(err("productDescription", `商品説明は3000文字以内です(現在${unicodeLength(fields.productDescription)}文字)`));
  }
  if (detectFormulaInjectionRisk(fields.productDescription)) {
    errors.push(err("productDescription", "商品説明が数式起点文字(=,+,-,@等)で始まっています。内容を確認し明示的に修正してください"));
  }

  if (!Number.isInteger(fields.quantity)) {
    errors.push(err("quantity", "在庫数は整数である必要があります"));
  } else if (fields.quantity < 0) {
    errors.push(err("quantity", "在庫数が負の値です"));
  } else if (fields.quantity === 0) {
    // 指示書§4: 「0可否を確認し保守的に対象判定」— 公式仕様が未確認の
    // ため、0は自動で許可せずブロックして人の判断を挟む。
    errors.push(err("quantity", "在庫数が0です。0件在庫をCSVへ出力してよいか公式仕様が未確認のため、対象外としています"));
  }

  if (!MANAGEMENT_CODE_RE.test(fields.managementCode)) {
    errors.push(
      err(
        "managementCode",
        `商品管理コードは半角英数字/-/_のみ、50文字以内である必要があります(値: "${fields.managementCode}")`,
      ),
    );
  }

  if (fields.janCode != null && fields.janCode !== "" && !JAN_CODE_RE.test(fields.janCode)) {
    errors.push(err("janCode", `JANコードは半角英数字/-/_のみ、14文字以内である必要があります(値: "${fields.janCode}")`));
  }

  if (!Number.isInteger(fields.salePrice)) {
    errors.push(err("salePrice", "販売価格は整数である必要があります"));
  } else if (fields.salePrice < 300 || fields.salePrice > 9999999) {
    errors.push(err("salePrice", `販売価格は300〜9999999の範囲です(現在${fields.salePrice})`));
  }

  if (!fields.categoryId) {
    errors.push(err("categoryId", "カテゴリIDが未確定です。同名の末端カテゴリが複数ある場合は文字列類似だけで決めず、フルパスから選び直してください"));
  }

  if (![1, 2, 3, 4, 5, 6].includes(fields.condition)) {
    errors.push(err("condition", "商品の状態が不正な値です"));
  }

  if (![1, 2, 3, 4, 5, 6].includes(fields.shippingMethod)) {
    errors.push(err("shippingMethod", "配送方法が不正な値です"));
  }

  if (fields.shippingMethod === 6) {
    if (![1, 2, 3].includes(fields.bizCoolCategory as number)) {
      errors.push(err("bizCoolCategory", "配送方法がBiz配送の場合、クール区分(1通常/2冷蔵/3冷凍)は必須です"));
    }
  } else if (fields.bizCoolCategory != null) {
    errors.push(err("bizCoolCategory", "Biz配送以外ではクール区分は空欄にしてください"));
  }

  if (!fields.shippingOriginArea) {
    errors.push(err("shippingOriginArea", "発送元の地域が未設定です"));
  }

  if (![1, 2, 3, 4, 5].includes(fields.shippingDays)) {
    errors.push(err("shippingDays", "発送までの日数が未選択です。確認済み設定がない場合は利用者が選択してください"));
  }

  if (![1, 2].includes(fields.productStatus)) {
    errors.push(err("productStatus", "商品ステータスが不正な値です"));
  }

  if (![1, 2].includes(fields.shippingPayer)) {
    errors.push(err("shippingPayer", "配送料の負担が未選択です"));
  } else if (fields.shippingPayer === 2 && !fields.shippingFeeId) {
    errors.push(err("shippingFeeId", "配送料の負担が「送料別」の場合、送料IDは必須です"));
  }

  if (fields.images.length === 0) {
    errors.push(err("images", "画像が1枚もありません。登録準備CSVでは画像欠損は補完必須です(下書き用CSVを別途明示した場合のみ許容)"));
  }
  if (fields.images.length > 20) {
    errors.push(err("images", `画像が20枚を超えています(${fields.images.length}枚)。どれを使うか選択してください(黙って削除はしません)`));
  }

  return { inventoryId: fields.inventoryId, displayId: fields.displayId, ok: errors.length === 0, errors };
}
