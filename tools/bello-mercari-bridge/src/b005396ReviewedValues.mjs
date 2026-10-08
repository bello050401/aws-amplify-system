import { exactGeneralPrivateCreatePack } from "./generalPrivateCreateJob.mjs";

export const B005396_INVENTORY = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
export const B005396_SHOP = "evkhihBFFNn5hukMS9s36H";
export const B005396_CATEGORY =
  "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ";
export const B005396_SHIPPING = {
  method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS",
};

/** Exact value gate shared by the PC file inbox and the reviewed runner. */
export function exactB005396ReviewedPack(pack) {
  const exact = exactGeneralPrivateCreatePack(pack);
  return exact?.shopId === B005396_SHOP &&
    exact.inventoryId === B005396_INVENTORY &&
    exact.priceYen === 99_999 && exact.quantity === 1 &&
    exact.categoryPath === B005396_CATEGORY &&
    exact.condition === "NO_NOTABLE_DAMAGE" &&
    exact.brandId === null && exact.brandName === null &&
    exact.imageRefs.length === 1 &&
    JSON.stringify(exact.shipping) === JSON.stringify(B005396_SHIPPING) ?
    exact : null;
}
