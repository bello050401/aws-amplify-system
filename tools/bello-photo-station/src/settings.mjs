import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * 初回起動時の初期編集設定(仕様の「初期編集設定」節と1:1対応)。
 * トーン系(brightness/contrast/colorTemperatureShift/saturation/sharpness)は
 * 初期値では無補正 — 仕様は「元画像の縦横比を維持・自動トリミングなし・
 * 画像方向正常化・sRGB・JPEG・長辺3000px・品質90・サムネイル480px/品質80・
 * GPS及び個人情報の削除」だけを初期設定として列挙しており、トーン補正は
 * 含めていない。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  keepAspectRatio: true,
  autoCrop: false,
  cropMethod: "none",
  autoRotate: true,
  colorSpace: "srgb",
  outputFormat: "jpeg",
  longEdgePx: 3000,
  jpegQuality: 90,
  thumbnailLongEdgePx: 480,
  thumbnailJpegQuality: 80,
  stripMetadata: true,
  brightness: 0,
  contrast: 0,
  colorTemperatureShift: 0,
  saturation: 0,
  sharpness: 0,
  lightroomPresetName: null,
});

export function settingsHash(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const normalized = JSON.stringify(merged, Object.keys(merged).sort());
  return createHash("sha256").update(normalized).digest("hex");
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, file);
}

/** 端末ごとのローカル編集設定(現在使用中の設定＋名前付きプリセット)。 */
export class SettingsStore {
  constructor(file) {
    this.file = file;
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      return {
        active: { ...DEFAULT_SETTINGS, ...(raw.active ?? {}) },
        presets: raw.presets ?? {},
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { active: { ...DEFAULT_SETTINGS }, presets: {} };
      throw error;
    }
  }

  async setActive(settings) {
    const state = await this.load();
    state.active = { ...DEFAULT_SETTINGS, ...settings };
    await atomicWriteJson(this.file, state);
    return state.active;
  }

  async resetToDefault() {
    const state = await this.load();
    state.active = { ...DEFAULT_SETTINGS };
    await atomicWriteJson(this.file, state);
    return state.active;
  }

  async savePreset(name, settings) {
    if (typeof name !== "string" || name.trim().length === 0) throw new Error("Preset name is required");
    const state = await this.load();
    state.presets[name] = { ...DEFAULT_SETTINGS, ...settings };
    await atomicWriteJson(this.file, state);
    return state.presets[name];
  }

  async applyPreset(name) {
    const state = await this.load();
    const preset = state.presets[name];
    if (!preset) throw new Error(`Preset not found: ${name}`);
    state.active = { ...preset };
    await atomicWriteJson(this.file, state);
    return state.active;
  }

  async listPresetNames() {
    const state = await this.load();
    return Object.keys(state.presets);
  }
}
