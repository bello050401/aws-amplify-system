import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Node resolves the entry module through junctions, while argv keeps the path
// used by the desktop launcher. Compare the actual files, not their aliases.
export function isMainModule(moduleUrl, entryPath = process.argv[1]) {
  if (!entryPath) return false;
  try {
    const canonical = value => {
      const resolved = realpathSync.native(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return canonical(fileURLToPath(moduleUrl)) === canonical(path.resolve(entryPath));
  } catch {
    return false;
  }
}
