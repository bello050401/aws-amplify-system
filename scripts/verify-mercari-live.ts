/**
 * Mercari Shops APIの**実接続**確認。他の verify:* と違い、実際に
 * Mercariのエンドポイントへリクエストを送る。
 *
 * Run with: npm run verify:mercari-live
 *
 * ## なぜ必要か
 *
 * `npm run verify:listing` はエラー分類やマッピングの純粋ロジックを固定する
 * だけで、Mercariへは繋がない。「実際に接続できるか」はそれでは分からない。
 * 報告されている HTTP 404 が「TOKENの問題」なのか「送信元IPが未登録」なのかを
 * 切り分けるには、**実際に送って結果を見る**しかない。
 *
 * ## 何を出すか
 *
 * - 設定の取得経路（Secrets Manager / 環境変数 / 未設定）— **値は一切出さない**
 * - 実際に使われるエンドポイントと環境（sandbox / production）
 * - 実リクエストの結果（HTTPステータスと、このコードベースの分類コード）
 * - **このマシンの送信元グローバルIP** — Mercariへ登録を依頼する際に必要
 *
 * 送信元IPを出しているのは、Mercari公式ドキュメントが「登録されていないIPからの
 * リクエストは404を返す」と記載しているため。ただし**Mercari側の登録状況は
 * 我々からは参照できない**ので、このスクリプトは「IPが未登録である」と断定しない。
 * 事実（送った / こう返った / 送信元はこのIP）だけを出す。
 *
 * ## 注意: ここで出るIPはStagingの送信元ではない
 *
 * これをローカル端末で実行すると、出るのは**その端末のIP**。BELLO本体は
 * Amplify HostingのSSRコンピュート上で動き、固定の送信元IPを持たない
 * （NAT Gateway + Elastic IP を導入していないため）。したがって
 * 「このIPを登録すれば直る」わけではない — docs/mercari-404-root-cause-20260830.md 参照。
 */
import { MercariShopsClient } from "@/lib/listing/mercari/client";
import { PRODUCT_CATEGORIES_QUERY, type ProductCategoriesResponse } from "@/lib/listing/mercari/queries";
import { getMercariAccessToken, getMercariTokenSource, getMercariClientNameConfig } from "@/lib/listing/mercari/tokenAccess";
import { getMercariEnvironment, getMercariEndpoint } from "@/lib/listing/mercari/endpoints";
import { MercariApiError, MERCARI_ERROR_LABEL } from "@/lib/listing/mercari/errors";

async function currentEgressIp(): Promise<string> {
  // 複数の提供元を順に試す。1つが落ちていても確認を止めない。
  for (const url of ["https://checkip.amazonaws.com", "https://api.ipify.org"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return (await res.text()).trim();
    } catch {
      // 次の提供元へ
    }
  }
  return "(取得できませんでした)";
}

async function main() {
  const [tokenSource, clientConfig, egressIp] = await Promise.all([
    getMercariTokenSource(),
    getMercariClientNameConfig(),
    currentEgressIp(),
  ]);
  const environment = getMercariEnvironment();

  console.log("── 設定 ──────────────────────────────────────────");
  console.log(`TOKENの取得経路      : ${tokenSource}`);
  console.log(`APIクライアント名     : ${clientConfig.clientName ? `設定あり（取得経路: ${clientConfig.source}）` : "未設定"}`);
  console.log(`環境                 : ${environment}`);
  console.log(`エンドポイント        : ${getMercariEndpoint(environment)}`);
  console.log(`このマシンの送信元IP  : ${egressIp}`);
  console.log("");

  if (tokenSource === "unconfigured") {
    console.error("✗ TOKENが未設定のため、実接続を試行できません。設定画面のEC出品タブから登録してください。");
    process.exit(1);
  }
  if (!clientConfig.clientName) {
    console.error("✗ APIクライアント名が未設定のため、実接続を試行できません（正しいUser-Agentを送れないため）。");
    process.exit(1);
  }

  console.log("── 実リクエスト ──────────────────────────────────");
  const client = new MercariShopsClient({ getAccessToken: getMercariAccessToken });
  const startedAt = Date.now();
  try {
    const data = await client.request<ProductCategoriesResponse>(PRODUCT_CATEGORIES_QUERY, {});
    const count = data.productCategories?.length ?? 0;
    console.log(`✓ 接続成功（${Date.now() - startedAt}ms）— カテゴリー ${count} 件を取得`);
    console.log("\n1 passed, 0 failed");
  } catch (err) {
    const ms = Date.now() - startedAt;
    if (err instanceof MercariApiError) {
      console.error(`✗ 接続失敗（${ms}ms）`);
      console.error(`    分類コード   : ${err.code}`);
      console.error(`    利用者向け文言: ${MERCARI_ERROR_LABEL[err.code]}`);
    } else {
      console.error(`✗ 接続失敗（${ms}ms）: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    console.log("\n0 passed, 1 failed");
    process.exit(1);
  }
}

main();
