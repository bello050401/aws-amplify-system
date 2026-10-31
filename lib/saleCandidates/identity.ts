import { createHash } from "node:crypto";

// Stable across mail/API imports, including suppression records after deletion.
export const candidateKey = (channel: string, order: string, line: string) =>
  createHash("sha256")
    .update(JSON.stringify([channel, order, line]))
    .digest("hex");
