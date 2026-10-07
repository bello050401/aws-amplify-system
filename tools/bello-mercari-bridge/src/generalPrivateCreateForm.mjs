import { readExistingUploadedImages } from "./addExistingImageOnce.mjs";
import { exactGeneralPrivateCreatePack } from "./generalPrivateCreateJob.mjs";

const CONDITION_LABEL = {
  NEW: "新品、未使用", LIKE_NEW: "未使用に近い",
  NO_NOTABLE_DAMAGE: "目立った傷や汚れなし",
  SLIGHT_DAMAGE: "やや傷や汚れあり", DAMAGE: "傷や汚れあり",
  BAD: "全体的に状態が悪い",
};
const SHIPPING = {
  "shippingMethodType.id": "METHOD_TYPE_UNDECIDED",
  "shippingPayerType.id": "PAYER_TYPE_SELLER",
  "shippingFromState.id": "jp11",
  "shippingDurationType.id": "DURATION_TYPE_FOUR_TO_SEVEN_DAYS",
};
const normalize = value => typeof value === "string" ? value.replace(/\s+/g, "") : "";
const normalizeCategory = value => normalize(value).replace(/＞/g, ">").replace(/&gt;/g, ">");
const matchesPrice = (actual, expected) =>
  typeof actual === "string" && /^(?:[¥￥]\s*)?(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(actual) &&
  Number(actual.replace(/[¥￥,\s]/g, "")) === expected;

export class GeneralFormMismatch extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function diagnoseGeneralPrivateCreateForm(pack, view) {
  if (!exactGeneralPrivateCreatePack(pack)) return "PACK_UNVERIFIED";
  if (view?.name !== pack.title) return "NAME_MISMATCH";
  if (view.description !== pack.description) return "DESCRIPTION_MISMATCH";
  if (!matchesPrice(view.price, pack.priceYen)) return "PRICE_MISMATCH";
  if (view.quantity !== String(pack.quantity)) return "QUANTITY_MISMATCH";
  if (view.sku !== pack.managementCode) return "MANAGEMENT_CODE_MISMATCH";
  if (normalize(view.condition) !== normalize(CONDITION_LABEL[pack.condition]))
    return "CONDITION_MISMATCH";
  const path = pack.categoryPath.split(" > ").map(normalize);
  if (normalizeCategory(view.category) !== `カテゴリー${path.join(">")}`)
    return "CATEGORY_MISMATCH";
  for (const [name, value] of Object.entries(SHIPPING)) {
    if (view.shipping?.[name] !== value) return "SHIPPING_MISMATCH";
  }
  if (view.imageCount !== pack.imageRefs.length) return "IMAGE_COUNT_MISMATCH";
  return null;
}

async function unique(locator, code) {
  if (await locator.count() !== 1 || !await locator.isEnabled())
    throw new GeneralFormMismatch(code);
  const handle = await locator.elementHandle();
  if (!handle || !await handle.isEnabled())
    throw new GeneralFormMismatch(code);
  return handle;
}

const FORM_FIELDS = [
  ["name", "title", "NAME_MISMATCH"],
  ["description", "description", "DESCRIPTION_MISMATCH"],
  ["price", "priceYen", "PRICE_MISMATCH"],
  ["variants.0.quantity", "quantity", "QUANTITY_MISMATCH"],
  ["variants.0.skuCode", "managementCode", "MANAGEMENT_CODE_MISMATCH"],
];

/** Only observed normal UI controls are used. No guessed Shops HTTP request. */
export async function fillGeneralPrivateCreateFormOnce(page, input, imageFiles,
  { onStage = () => {}, beforeWrite, readImages = readExistingUploadedImages } = {}) {
  const pack = exactGeneralPrivateCreatePack(input);
  if (!pack) throw new GeneralFormMismatch("PACK_UNVERIFIED");
  if (typeof beforeWrite !== "function")
    throw new GeneralFormMismatch("TARGET_CHECK_UNAVAILABLE");
  if (pack.brandId !== null) throw new GeneralFormMismatch("BRAND_CONTROL_UNVERIFIED");
  if (!Array.isArray(imageFiles) || imageFiles.length !== pack.imageRefs.length ||
      imageFiles.some((file, index) => file?.storageKey !== pack.imageRefs[index].storageKey ||
        !Buffer.isBuffer(file.buffer) || file.buffer.length < 1 ||
        file.buffer.length > 20_000_000 ||
        typeof file.filename !== "string" || !/^[^/\\]+\.(?:jpe?g|png)$/i.test(file.filename) ||
        !["image/jpeg", "image/png"].includes(file.mimeType)))
    throw new GeneralFormMismatch("IMAGE_PROOF_UNVERIFIED");
  for (const [name, field, code] of FORM_FIELDS) {
    await onStage(code);
    const control = await unique(page.locator(`[name="${name}"]`), code);
    await beforeWrite();
    await control.fill(String(pack[field]), { timeout: 12000 });
    await beforeWrite();
    const actual = await control.inputValue();
    if (name === "price" ? !matchesPrice(actual, pack.priceYen) :
        actual !== String(pack[field])) throw new GeneralFormMismatch(code);
  }
  for (const [name, value] of Object.entries(SHIPPING)) {
    await onStage("SHIPPING_MISMATCH");
    const control = await unique(page.locator(`select[name="${name}"]`),
      "SHIPPING_MISMATCH");
    await beforeWrite();
    await control.selectOption(value, { timeout: 12000 });
    await beforeWrite();
    if (await control.inputValue() !== value)
      throw new GeneralFormMismatch("SHIPPING_MISMATCH");
  }
  await onStage("CONDITION_MISMATCH");
  const condition = await unique(page.getByTestId("condition-select-box"),
    "CONDITION_MISMATCH");
  if (normalize(await condition.innerText()) !== normalize(CONDITION_LABEL[pack.condition])) {
    await beforeWrite();
    await condition.click({ timeout: 12000 });
    const option = await unique(page.getByText(CONDITION_LABEL[pack.condition],
      { exact: true }), "CONDITION_MISMATCH");
    await beforeWrite();
    await option.click({ timeout: 12000 });
  }
  await beforeWrite();
  if (normalize(await page.getByTestId("condition-select-box").innerText()) !==
      normalize(CONDITION_LABEL[pack.condition]))
    throw new GeneralFormMismatch("CONDITION_MISMATCH");
  await onStage("CATEGORY_MISMATCH");
  const categories = await unique(page.getByTestId("categories"), "CATEGORY_MISMATCH");
  await beforeWrite();
  await categories.click({ timeout: 12000 });
  for (const label of pack.categoryPath.split(" > ")) {
    const dialog = page.getByRole("dialog");
    if (await dialog.count() !== 1) throw new GeneralFormMismatch("CATEGORY_MISMATCH");
    const option = await unique(dialog.getByText(label, { exact: true }),
      "CATEGORY_MISMATCH");
    await beforeWrite();
    await option.click({ timeout: 12000 });
  }
  await beforeWrite();
  if (normalize(await page.getByTestId("categories").innerText()) !==
      normalize(pack.categoryPath.split(" > ").at(-1)))
    throw new GeneralFormMismatch("CATEGORY_MISMATCH");
  await onStage("IMAGE_PROOF_UNVERIFIED");
  if (await page.locator('img[alt="uploaded-image"]').count() !== 0)
    throw new GeneralFormMismatch("IMAGE_PROOF_UNVERIFIED");
  const fileInput = await unique(page.locator('input[type="file"][multiple]'),
    "IMAGE_PROOF_UNVERIFIED");
  await beforeWrite();
  await fileInput.setInputFiles(imageFiles.map(file => ({
      name: file.filename, mimeType: file.mimeType, buffer: file.buffer,
    })), { timeout: 12000 });
  await beforeWrite();
  await page.locator('img[alt="uploaded-image"]').first().waitFor({
    state: "visible", timeout: 30000 });
  await beforeWrite();
  const view = await page.locator("body").evaluate(() => {
    const field = name => document.querySelector(`[name="${name}"]`)?.value ?? null;
    return { name: field("name"), description: field("description"),
      price: field("price"), quantity: field("variants.0.quantity"),
      sku: field("variants.0.skuCode"),
      condition: document.querySelector('[data-testid="condition-select-box"]')?.textContent ?? null,
      category: document.querySelector('label[for="category"]')?.closest('[role="group"]')?.textContent ?? null,
      shipping: Object.fromEntries(Object.keys({
        "shippingMethodType.id": 1, "shippingPayerType.id": 1,
        "shippingFromState.id": 1, "shippingDurationType.id": 1,
      }).map(name => [name, field(name)])),
      imageCount: document.querySelectorAll('img[alt="uploaded-image"]').length };
  });
  const issue = diagnoseGeneralPrivateCreateForm(pack, view);
  if (issue) throw new GeneralFormMismatch(issue);
  const assets = await readImages(page, page.url());
  if (!assets || assets.length !== pack.imageRefs.length)
    throw new GeneralFormMismatch("IMAGE_ASSET_UNVERIFIED");
  return assets;
}
