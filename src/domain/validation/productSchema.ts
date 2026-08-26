import { z } from "zod";
import { MERCARI_LIMITS } from "@/integrations/mercari-shops/types/limits";

/**
 * 商品登録/編集フォームの検証スキーマ。クライアント・サーバ双方で共用し、
 * サーバ側では必ずこのスキーマで再検証すること（指示書56項、クライアント検証のみに依存しない）。
 */
export const productConditionCodes = [
  "NEW",
  "LIKE_NEW",
  "NO_NOTABLE_DAMAGE",
  "SLIGHT_DAMAGE",
  "DAMAGE",
  "BAD",
] as const;

export const shippingPayerCodes = ["SELLER", "BUYER"] as const;

export const productFormSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1, "SKUは必須です")
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/, "SKUは半角英数字とハイフンのみ使用できます"),
  name: z
    .string()
    .trim()
    .min(1, "商品名は必須です")
    .max(MERCARI_LIMITS.NAME_MAX, `商品名は${MERCARI_LIMITS.NAME_MAX}文字以内で入力してください`),
  description: z
    .string()
    .trim()
    .min(1, "商品説明は必須です")
    .max(
      MERCARI_LIMITS.DESCRIPTION_MAX,
      `商品説明は${MERCARI_LIMITS.DESCRIPTION_MAX}文字以内で入力してください`,
    ),
  price: z
    .number()
    .int("価格は整数で入力してください")
    .min(1, "価格は1円以上で入力してください")
    .max(9_999_999),
  condition: z.enum(productConditionCodes),
  categoryMappingId: z.string().min(1, "カテゴリーを選択してください").nullable(),
  brandMappingId: z.string().nullable().optional(),
  janCode: z.string().trim().max(32).nullable().optional(),
  catalogId: z.string().trim().max(64).nullable().optional(),
  shippingPayer: z.enum(shippingPayerCodes),
  shippingFromStateId: z.string().nullable().optional(),
  shippingDurationCode: z.string().nullable().optional(),
  shippingTemplateId: z.string().nullable().optional(),
  stockQuantity: z.number().int().min(0).max(9999).default(1),
});

export type ProductFormValues = z.infer<typeof productFormSchema>;
