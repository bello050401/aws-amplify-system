/**
 * QA検証専用の一時的なNode ESMローダーhook。
 *
 * with-server-only-stub.cjs は共有 node_modules/server-only/index.js を
 * 書き換えてから復元する方式だが、このworktreeのnode_modulesは本体
 * リポジトリへのjunction(共有)であり、この検証セッションではその方式は
 * 許可されない(「共有node_modulesは変更しない」)。
 *
 * 代わりに、node_modulesを一切触らずに "server-only" の解決だけを
 * Node標準の module customization hooks (node:module の register()) で
 * 差し替える。対象は specifier が厳密に "server-only" のときだけで、
 * それ以外は必ず nextResolve() へ委譲する——他の解決には一切影響しない。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      url: "data:text/javascript,export default {};",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
