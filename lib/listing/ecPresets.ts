import { EC_CHANNELS, type EcChannel } from "./ecManagement";

export type EcPresetValues = {
  priceAddition: number;
  shippingMethod: "KAZAI" | "SAGAWA";
  shopsDelivery: "UNDECIDED" | "MERCARI_SHIPPING_YAMATO";
  categoryId: string;
  categoryName: string;
  endDays: number;
  endHour: number;
  descriptionSuffix: string;
};
export type EcPreset = {
  id: string;
  name: string;
  channel: EcChannel;
  revision: number;
  values: EcPresetValues;
  deleted: boolean;
};
export const EMPTY_EC_PRESET: EcPresetValues = {
  priceAddition: 0,
  shippingMethod: "KAZAI",
  shopsDelivery: "UNDECIDED",
  categoryId: "",
  categoryName: "",
  endDays: 6,
  endHour: 22,
  descriptionSuffix: "",
};
export const DEFAULT_EC_PRESETS: EcPreset[] = [
  {
    id: "default-mercari-named",
    name: "名前配送",
    channel: "MERCARI_SHOPS",
    revision: 0,
    values: { ...EMPTY_EC_PRESET },
    deleted: false,
  },
  {
    id: "default-mercari-anonymous",
    name: "匿名配送",
    channel: "MERCARI_SHOPS",
    revision: 0,
    values: { ...EMPTY_EC_PRESET, shopsDelivery: "MERCARI_SHIPPING_YAMATO" },
    deleted: false,
  },
  {
    id: "default-yahoo-kazai",
    name: "定額・家財便",
    channel: "YAHOO",
    revision: 0,
    values: { ...EMPTY_EC_PRESET },
    deleted: false,
  },
  {
    id: "default-yahoo-sagawa",
    name: "定額・佐川急便",
    channel: "YAHOO",
    revision: 0,
    values: { ...EMPTY_EC_PRESET, shippingMethod: "SAGAWA" },
    deleted: false,
  },
  {
    id: "default-base",
    name: "標準",
    channel: "BASE",
    revision: 0,
    values: { ...EMPTY_EC_PRESET },
    deleted: false,
  },
];
export function parseEcPreset(value: unknown): EcPreset | null {
  if (!value || typeof value !== "object") return null;
  const p = value as EcPreset,
    v = p.values;
  if (
    typeof p.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(p.id) ||
    !EC_CHANNELS.includes(p.channel) ||
    typeof p.name !== "string" ||
    !p.name.trim() ||
    [...p.name].length > 30 ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 0 ||
    typeof p.deleted !== "boolean" ||
    !v ||
    !Number.isSafeInteger(v.priceAddition) ||
    Math.abs(v.priceAddition) > 9999999 ||
    !["KAZAI", "SAGAWA"].includes(v.shippingMethod) ||
    !["UNDECIDED", "MERCARI_SHIPPING_YAMATO"].includes(v.shopsDelivery) ||
    typeof v.categoryId !== "string" ||
    !/^[a-zA-Z0-9]{0,64}$/.test(v.categoryId) ||
    (p.channel === "YAHOO" &&
      v.categoryId !== "" &&
      !/^[1-9][0-9]{0,11}$/.test(v.categoryId)) ||
    typeof v.categoryName !== "string" ||
    v.categoryName.length > 300 ||
    !Number.isInteger(v.endDays) ||
    v.endDays < 1 ||
    v.endDays > 7 ||
    !Number.isInteger(v.endHour) ||
    v.endHour < 0 ||
    v.endHour > 23 ||
    typeof v.descriptionSuffix !== "string" ||
    v.descriptionSuffix.length > 3000
  )
    return null;
  return {
    id: p.id,
    name: p.name.trim(),
    channel: p.channel,
    revision: p.revision,
    deleted: p.deleted,
    values: {
      priceAddition: v.priceAddition,
      shippingMethod: v.shippingMethod,
      shopsDelivery: v.shopsDelivery,
      categoryId: v.categoryId,
      categoryName: v.categoryName,
      endDays: v.endDays,
      endHour: v.endHour,
      descriptionSuffix: v.descriptionSuffix,
    },
  };
}
export function presetEndAt(values: EcPresetValues, now = Date.now()) {
  const day = new Date(now + 9 * 3600000 + values.endDays * 86400000)
    .toISOString()
    .slice(0, 10);
  return `${day}T${String(values.endHour).padStart(2, "0")}:00`;
}
export function presetDescription(description: string, suffix: string) {
  return !suffix.trim() || description.endsWith(suffix.trim())
    ? description
    : `${description.trimEnd()}\n\n${suffix.trim()}`;
}
