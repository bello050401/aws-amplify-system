/**
 * Test-only ESM resolve hook so lib/*.ts files (written with tsconfig's
 * "moduleResolution": "bundler" extension-less relative imports, e.g.
 * `from "./intent"`, and the "@/*" path alias, e.g. `from "@/lib/inquiry/types"`)
 * can be executed directly by Node's native TypeScript type-stripping
 * (`--experimental-strip-types`) without node_modules / tsx / ts-node.
 * Node's own ESM resolver requires explicit extensions and knows nothing
 * about tsconfig "paths", so this hook:
 *   - rewrites "@/x/y" to the project-root-relative file "x/y" (same
 *     mapping as tsconfig.json's `"@/*": ["./*"]`), and
 *   - appends ".ts" to extension-less specifiers (relative or rewritten)
 * before falling back to the default resolution.
 *
 * This file is test infrastructure only (scripts/), analogous in spirit
 * to scripts/with-server-only-stub.cjs; it changes nothing about how
 * `next build`/`next dev` resolve modules.
 *
 * Usage: node --experimental-strip-types --experimental-loader ./scripts/_ts-extension-loader.mjs <script.ts>
 */
import { pathToFileURL } from "node:url";

const PROJECT_ROOT_URL = pathToFileURL(`${process.cwd()}/`);

export async function resolve(specifier, context, nextResolve) {
  let candidate = specifier;
  let base = context;

  if (candidate.startsWith("@/")) {
    const rewritten = new URL(candidate.slice(2), PROJECT_ROOT_URL).toString();
    if (!/\.[a-zA-Z0-9]+$/.test(rewritten)) {
      try {
        return await nextResolve(`${rewritten}.ts`, base);
      } catch {
        // fall through
      }
    }
    return nextResolve(rewritten, base);
  }

  if (candidate.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(candidate)) {
    try {
      return await nextResolve(`${candidate}.ts`, base);
    } catch {
      // Fall through to default resolution (e.g. it was a directory import).
    }
  }
  return nextResolve(specifier, context);
}
