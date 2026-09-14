import { isE2EFixtureModeActive } from "@/lib/inventory/e2eFixtures";
import { MERCARI_IMG_E2E_FAILURE_STATUS, mercariImgFixtureBytes } from "@/lib/listing/mercari/csv/e2eImageFixtureBytes";

/**
 * Mercari CSV画像受渡しE2E専用のローカル画像配信エンドポイント。
 *
 * lib/listing/mercari/csv/buildExportRows.tsのgetInventoryImageDownloadUrl
 * が、E2E fixtureモードかつ`e2e-mercari-img:`接頭辞のstorageKeyに対して
 * だけ、実Amplify Storageの代わりにこのURLを返す(同ファイルのコメント
 * 参照)。imageBundle.tsのbuildInventoryImageZipはこのURLへ実際に
 * `fetch()`する——「表示上そう見える」だけでなく、サーバープロセスが
 * 本当にHTTP経由でバイト列を取得する経路をE2Eで検証できる。
 *
 * 二重ゲート(isE2EFixtureModeActive — NODE_ENV!=='production' かつ
 * INVENTORY_E2E_FIXTURES==='1')の外では常に404——本番ビルド
 * (next start、NODE_ENV=production)ではこの分岐は構造的に到達しない。
 */
export async function GET(_req: Request, { params }: { params: { variant: string } }): Promise<Response> {
  if (!isE2EFixtureModeActive()) {
    return new Response("Not Found", { status: 404 });
  }

  const variant = params.variant;
  const failureStatus = MERCARI_IMG_E2E_FAILURE_STATUS[variant];
  if (failureStatus) {
    return new Response(`[e2e-fixture] simulated ${variant}`, { status: failureStatus });
  }

  const bytes = mercariImgFixtureBytes(variant);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      // 実運用の署名URLはCache-Control実質無し/短命——ここも本物のS3
      // レスポンスを模倣する必要は無い(E2E専用の合成データのため)。
      "cache-control": "no-store",
    },
  });
}
