/**
 * ブラウザから見たこのアプリのオリジン（例: https://xxx.amplifyapp.com）。
 *
 * 【なぜ request.url ではだめか — 実測】Amplify HostingのSSRでは
 * Route Handlerの `request.url` のホストが `localhost:3000` になる。
 * 本番URL `https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du
 * .amplifyapp.com/api/base/oauth/start` へのcurlに対し、
 * `Location: https://localhost:3000/admin/login` が返っていた ——
 * つまり `new URL(path, request.url)` で作ったリダイレクト先は
 * **ブラウザから到達できないURL**になる。
 *
 * ブラウザが実際に見ているホストはCloudFrontが `x-forwarded-host` へ
 * 入れてくれるので、そちらを優先する。
 */
export function resolveAppOrigin(request: Request): string {
  const headers = request.headers;
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host")?.trim();
  if (host) {
    const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}
