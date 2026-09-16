import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class CheckpointStore {
  constructor(file) { this.file = file; }
  async read() {
    try { return JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
  }
  async record(checkpoint) {
    const state = await this.read();
    state[checkpoint.sessionId] = { ...(state[checkpoint.sessionId] ?? {}), ...checkpoint, updatedAt: new Date().toISOString() };
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, this.file);
  }
}
