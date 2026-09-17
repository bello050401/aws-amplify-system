import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * セッションごとの処理/送信履歴。原本ハッシュ＋設定ハッシュをキーにして
 * 「同じ設定・同じ原本の再処理」を避ける。CheckpointStoreと同じ
 * temp書き込み→rename方式で、書き込み途中の破損を防ぐ。
 */
export class ProcessingHistoryStore {
  constructor(file) {
    this.file = file;
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  }

  async findEntry(sessionId, clientAssetId) {
    const state = await this.read();
    return state[sessionId]?.assets?.[clientAssetId] ?? null;
  }

  /** 同一 sourceHash + settingsHash なら既に処理済みとみなして再処理をスキップできる。 */
  async isAlreadyProcessed(sessionId, clientAssetId, sourceHash, settingsHash) {
    const entry = await this.findEntry(sessionId, clientAssetId);
    return Boolean(entry && entry.sourceHash === sourceHash && entry.settingsHash === settingsHash && entry.processedAt);
  }

  async recordProcessed(sessionId, clientAssetId, { sourceHash, settingsHash, processed, thumbnail }) {
    await this._update(sessionId, clientAssetId, {
      sourceHash,
      settingsHash,
      processed,
      thumbnail,
      processedAt: new Date().toISOString(),
      uploadStatus: "PENDING",
    });
  }

  async recordUploadResult(sessionId, clientAssetId, status, detail = {}) {
    await this._update(sessionId, clientAssetId, {
      uploadStatus: status,
      uploadedAt: status === "UPLOADED" ? new Date().toISOString() : undefined,
      ...detail,
    });
  }

  async listSession(sessionId) {
    const state = await this.read();
    return state[sessionId]?.assets ?? {};
  }

  async _update(sessionId, clientAssetId, patch) {
    const state = await this.read();
    const session = state[sessionId] ?? { assets: {} };
    const existing = session.assets[clientAssetId] ?? {};
    const merged = { ...existing };
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) merged[key] = value;
    session.assets[clientAssetId] = merged;
    state[sessionId] = session;
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, this.file);
  }
}
