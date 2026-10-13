import "server-only";

import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
import { observedCategoryLeafIds } from "./webHttpObservedCategory.ts";
import { CREATE_PRODUCT_QUERY, UPDATE_PRODUCT_QUERY,
  VALIDATE_PRODUCT_QUERY } from "./webHttpObservedProductQueries.ts";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f]/.test(value);
const text = (value: unknown): value is string => typeof value === "string";
const quantity = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const fieldId = (value: unknown): string | null =>
  object(value) && id(value.id) ? value.id : null;
const seedValid = (value: number) => Number.isFinite(value);

export type ObservedProductVariant = {
  name: string; quantity: number; skuCode: string; janCode: string;
  attributes: never[]; maxQuantityPerOrder: null;
};
export type ObservedProductFields = {
  name: string; description: string; price: number; assetIds: string[];
  categoryIds: string[]; brandIds: string[]; condition: string;
  shippingFromStateId: string; shippingDurationType: string;
  shippingMethodType: string; shippingPayerType: string;
  countryRestrictionTemplateId: string; isRefurbished: boolean;
  channelListingScope: string;
};
export type ObservedProductRead = {
  id: string; shopId: string; snapshotId: string;
  status: "STATUS_OPENED" | "STATUS_UNOPENED";
  inStock: boolean; fields: ObservedProductFields;
  variants: Array<ObservedProductVariant & {
    id: string; optionId: string; optionTypeId: string;
    stockSnapshotId: string; catalogSkuId: null;
  }>;
};

function responseData(body: unknown): RecordValue | null {
  return object(body) && !("errors" in body) && object(body.data) ? body.data : null;
}

function commonFields(product: RecordValue): ObservedProductFields | null {
  const categoryIds = observedCategoryLeafIds(product.categories);
  const assets = product.thumbnails;
  const brands = product.brands;
  const condition = fieldId(product.condition);
  const shippingFromStateId = fieldId(product.shippingFromState);
  const shippingDurationType = fieldId(product.shippingDurationType);
  const shippingMethodType = fieldId(product.shippingMethodType);
  const shippingPayerType = fieldId(product.shippingPayerType);
  if (!text(product.name) || !product.name.trim() || product.name.length > 130 ||
      !text(product.description) || product.description.length > 3000 ||
      !Number.isSafeInteger(product.price) || (product.price as number) < 300 ||
      (product.price as number) > 9_999_999 || !categoryIds ||
      !Array.isArray(assets) || assets.length === 0 ||
      !assets.every(asset => object(asset) && id(asset.id)) ||
      !Array.isArray(brands) || !brands.every(brand => object(brand) && id(brand.id)) ||
      !condition || !shippingFromStateId || !shippingDurationType ||
      !shippingMethodType || !shippingPayerType ||
      typeof product.isRefurbished !== "boolean" || !id(product.channelListingScope) ||
      product.countryRestrictionTemplateId !== null &&
        !text(product.countryRestrictionTemplateId)) return null;
  const assetIds = assets.map(asset => asset.id as string);
  if (new Set(assetIds).size !== assetIds.length) return null;
  return { name: product.name, description: product.description,
    price: product.price as number, assetIds, categoryIds,
    brandIds: brands.map(brand => brand.id as string), condition,
    shippingFromStateId, shippingDurationType, shippingMethodType,
    shippingPayerType,
    // The captured EditProductPage null is sent as an empty string by UpdateProductV2.
    countryRestrictionTemplateId: product.countryRestrictionTemplateId ?? "",
    isRefurbished: product.isRefurbished, channelListingScope: product.channelListingScope };
}

function baseVariant(value: unknown): ObservedProductVariant | null {
  if (!object(value) || !text(value.name) || !quantity(value.quantity) ||
      !text(value.skuCode) || !text(value.janCode) ||
      !Array.isArray(value.attributes) || value.attributes.length !== 0 ||
      !object(value.maxQuantityPerOrderConfig) ||
      value.maxQuantityPerOrderConfig.configuredValue !== null) return null;
  return { name: value.name, quantity: value.quantity,
    skuCode: value.skuCode, janCode: value.janCode,
    attributes: [], maxQuantityPerOrder: null };
}

/** Parse a fresh observed EditProductPage response. A failed read is unknown,
 * never deletion. Special sales/delivery forms are not silently flattened.
 */
export function parseObservedProductRead(body: unknown,
  expectedProductId: string): ObservedProductRead | null {
  const data = responseData(body);
  const product = data?.shopProduct;
  if (!id(expectedProductId) || !data || !object(product) ||
      !Array.isArray(data.ownShops) ||
      !data.ownShops.some(shop => object(shop) && shop.id === WEB_HTTP_SHOP_ID) ||
      product.id !== expectedProductId || fieldId(product.shop) !== WEB_HTTP_SHOP_ID ||
      !id(product.snapshotId) || typeof product.inStock !== "boolean" ||
      !object(product.status) ||
      !["STATUS_OPENED", "STATUS_UNOPENED"].includes(String(product.status.id)) ||
      product.preOrder !== null || product.auction !== null ||
      product.shippingConfiguration !== null || product.mercaribinForBusinessSetting !== null ||
      product.currentDualPrice !== null ||
      !Array.isArray(product.variants) || product.variants.length !== 1) return null;
  const fields = commonFields(product);
  const variants: ObservedProductRead["variants"] = [];
  if (!fields) return null;
  for (const variant of product.variants) {
    const base = baseVariant(variant);
    if (!base || !object(variant) || !id(variant.id) || !id(variant.stockSnapshotId) ||
        variant.catalogSkuId !== null || !Array.isArray(variant.optionTypes) ||
        variant.optionTypes.length !== 1 || !object(variant.optionTypes[0])) return null;
    const optionType = variant.optionTypes[0];
    if (!id(optionType.id) || !Array.isArray(optionType.options) ||
        optionType.options.length !== 1 || !object(optionType.options[0]) ||
        !id(optionType.options[0].id)) return null;
    variants.push({ ...base, id: variant.id, stockSnapshotId: variant.stockSnapshotId,
      optionTypeId: optionType.id, optionId: optionType.options[0].id,
      catalogSkuId: null });
  }
  return { id: expectedProductId, shopId: WEB_HTTP_SHOP_ID,
    snapshotId: product.snapshotId,
    status: product.status.id as ObservedProductRead["status"],
    inStock: product.inStock, fields, variants };
}

/** The request is constructed from a current read, not replayed HAR values.
 * This builder sends nothing. Caller must enforce the durable one-send claim,
 * the shop-wide interval and authenticated readback before recording success.
 */
export function buildObservedStopProductRequest(body: unknown,
  expectedProductId: string, idempotencyKeySeed: number) {
  const product = parseObservedProductRead(body, expectedProductId);
  if (!product || product.status !== "STATUS_OPENED" ||
      !seedValid(idempotencyKeySeed)) return null;
  return { operationName: "UpdateProductV2" as const,
    query: UPDATE_PRODUCT_QUERY, variables: { input: {
      ...product.fields, id: product.id, shopId: product.shopId,
      status: "STATUS_UNOPENED", productSnapshotId: product.snapshotId,
      variants: product.variants,
    }, idempotencyKeySeed } };
}

/** Publication contract observed after ValidateProductInfo returned true.
 * A current, complete draft and separate publication authorization are still
 * required by the caller. No new default values or HAR asset IDs are supplied.
 */
export function buildObservedCreateProductRequest(draftBody: unknown,
  expectedDraftId: string, idempotencyKeySeed: number) {
  const data = responseData(draftBody);
  const draft = data?.productDraft;
  if (!id(expectedDraftId) || !seedValid(idempotencyKeySeed) || !object(draft) ||
      draft.id !== expectedDraftId || !Array.isArray(draft.variants) ||
      draft.variants.length !== 1 || draft.preOrder !== null ||
      draft.shippingConfiguration !== null || draft.mercariBinForBusinessSetting !== null)
    return null;
  const fields = commonFields(draft);
  const variant = baseVariant(draft.variants[0]);
  if (!fields || !variant) return null;
  return { operationName: "CreateProduct" as const,
    query: CREATE_PRODUCT_QUERY, variables: { input: {
      ...fields, shopId: WEB_HTTP_SHOP_ID, status: "STATUS_OPENED",
      productDraftId: expectedDraftId, variants: [variant],
    }, idempotencyKeySeed } };
}

export function buildObservedProductValidationRequest(name: string, description: string) {
  if (!text(name) || !name.trim() || name.length > 130 ||
      !text(description) || description.length > 3000) return null;
  return { operationName: "ValidateProductInfo" as const, query: VALIDATE_PRODUCT_QUERY,
    variables: { input: { name, description } } };
}

export function observedProductValidationSucceeded(body: unknown): boolean {
  const data = responseData(body);
  return object(data?.validateProductInfo) && data.validateProductInfo.result === true;
}

export function parseObservedCreateProductAck(body: unknown): string | null {
  const data = responseData(body);
  return object(data?.createProduct) && id(data.createProduct.id) ? data.createProduct.id : null;
}

export function observedStopProductAcknowledged(body: unknown, expectedId: string): boolean {
  const data = responseData(body);
  const product = data?.updateProductV2;
  return id(expectedId) && object(product) && product.id === expectedId &&
    fieldId(product.status) === "STATUS_UNOPENED";
}
