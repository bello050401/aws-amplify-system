import { z } from "zod";
import { isValidDateOnly } from "@/lib/utils/date";

/**
 * 在庫フォームのバリデーションスキーマ。
 * 新規登録画面・編集画面は共通フォームコンポーネント(InventoryForm)と
 * この1つのスキーマを共有する(指示書 §16: 重複したフォームを別実装しない)。
 */
const dateOnly = z
  .string()
  .optional()
  .nullable()
  .refine((v) => !v || isValidDateOnly(v), { message: "日付の形式が正しくありません" });

export const itemFormSchema = z.object({
  name: z.string().min(1, "物品名を入力してください").max(200),
  quantity: z.number({ invalid_type_error: "数量は数値で入力してください" }).min(0, "0以上で入力してください"),
  unit: z.string().min(1, "単位を選択してください"),
  categoryId: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  barcode: z.string().max(100).optional().nullable(),

  plannedPrice: z.number().min(0).optional().nullable(),
  discountPrice30: z.number().min(0).optional().nullable(),
  discountPrice60: z.number().min(0).optional().nullable(),
  discountPrice90: z.number().min(0).optional().nullable(),
  condition: z.number().int().min(1).max(5).optional().nullable(),
  damageNotes: z.string().max(2000).optional().nullable(),
  widthCm: z.number().min(0).optional().nullable(),
  depthCm: z.number().min(0).optional().nullable(),
  heightCm: z.number().min(0).optional().nullable(),
  lengthCm: z.number().min(0).optional().nullable(),
  householdCategory: z.string().optional().nullable(),
  itemType: z.string().optional().nullable(),
  transactionDate: dateOnly,
  antiqueFeature: z.string().optional().nullable(),
  stocktakeDate: dateOnly,

  freeQuantity: z.number().min(0).optional().nullable(),
  reorderPoint: z.number().min(0).optional().nullable(),
});

export type ItemFormValues = z.infer<typeof itemFormSchema>;

export const DEFAULT_ITEM_FORM_VALUES: ItemFormValues = {
  name: "",
  quantity: 0,
  unit: "個",
  categoryId: null,
  locationId: null,
  status: null,
  notes: null,
  barcode: null,
  plannedPrice: null,
  discountPrice30: null,
  discountPrice60: null,
  discountPrice90: null,
  condition: null,
  damageNotes: null,
  widthCm: null,
  depthCm: null,
  heightCm: null,
  lengthCm: null,
  householdCategory: null,
  itemType: null,
  transactionDate: null,
  antiqueFeature: null,
  stocktakeDate: null,
  freeQuantity: 0,
  reorderPoint: null,
};
