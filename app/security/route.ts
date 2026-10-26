import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceSecurityEnabled } from "@/lib/security/serverRuntime";
import { SECURITY_HEADERS } from "@/lib/security/http";
export const dynamic = "force-dynamic";
export async function GET() {
  if (!deviceSecurityEnabled()) return new Response("Not enabled", { status: 404 });
  const staging = process.env.SECURITY_DEPLOYMENT === 'bello-security-hosted-20261026';
  const template = await readFile(join(process.cwd(), "tools/bello-security-pilot/index.html"), "utf8");
  const html = template.replace("<body>", '<body data-business="1">')
    .replace("安全なログインの検証", "ログイン")
    .replace('href="/app.css"', 'href="/security-assets/app.css"').replace('src="/app.js"', 'src="/security-assets/app.js"')
    .replace("<small>検証環境</small>", staging ? "<small>検証環境</small>" : "")
    .replace('<div class="notice">本番の在庫・画像・ECには接続しない検証環境です。</div>', staging ? '<div class="notice">本番とは別のセキュリティ検証環境です。検証用アカウントで操作してください。本番の在庫・EC・メール送信には接続しません。</div>' : "")
    .replace("承認済みアクセスを確認", "業務画面を開く");
  return new Response(html, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
}
