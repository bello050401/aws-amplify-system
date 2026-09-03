/**
 * メルカリShops問い合わせ通知メールの定期取り込み。
 *
 * 2026-09-03 指示書 §13-2「今回の初期実装は、数分以内に問い合わせを
 * 取り込めればよいため、必要以上にリアルタイム性を追求しなくてもよい。
 * ただし将来Push方式へ変更可能な構造とする」。
 *
 * ── 画面の「今すぐ取り込む」と同じ処理を呼ぶ ────────────────────
 *
 * 取り込みの本体は lib/messaging/mercari/mailIngest.ts の1つだけ。
 * スケジュール実行用に別実装を作ると、片方だけ直す事故が起きる。
 *
 * ── 実行 ────────────────────────────────────────────────────────
 *
 *   AWS_PROFILE=Bello npm run ingest:mercari-mail
 *
 * 定期実行する場合は、この1行をタスクスケジューラ / cron / EventBridge
 * から5〜10分間隔で叩く。**重複は取り込み側が弾く**(Message-IDによる
 * 冪等性、§10)ので、間隔を詰めても二重通知にはならない。
 *
 * Push方式(Gmail Watch + Pub/Sub)へ移す場合も、通知を受けたエンドポイントが
 * ingestMercariNotificationMails を呼ぶだけでよい。
 */
import { ingestMercariNotificationMails } from "@/lib/messaging/mercari/mailIngest";

async function main() {
  const startedAt = Date.now();
  console.log(`[ingest-mercari-mail] 開始 ${new Date().toISOString()}`);

  try {
    // --reprocess: 取り込み済みのメールも解析・通知をやり直す(§10)。
    // パーサや商品照合を直した後に、既存ログを正しい内容へ更新するために使う。
    const reprocess = process.argv.includes("--reprocess");
    if (reprocess) console.log("  (やり直しモード: 取り込み済みのメールも再処理します)");
    const result = await ingestMercariNotificationMails({ who: "scheduled-ingest", reprocess });
    console.log(
      [
        `  取得            : ${result.fetched}件`,
        `  新規取り込み    : ${result.ingested}件`,
        `  取り込み済み    : ${result.duplicated}件`,
        `  再処理          : ${result.reprocessed}件`,
        `  対象外          : ${result.skipped}件`,
        `  解析失敗(保存済): ${result.parseFailed}件`,
        `  エラー          : ${result.failed}件`,
      ].join("\n"),
    );
    for (const m of result.messages) console.log(`  - ${m}`);
    console.log(`[ingest-mercari-mail] 完了 (${Math.round((Date.now() - startedAt) / 1000)}秒)`);

    // 個々のメールの失敗は非ゼロ終了にしない。スケジューラが「失敗」と
    // 判定して警報を上げ続けると、本当に止まっているときに気づけなくなる。
    // 取り込めなかったメールは次回の実行で再度対象になる。
    process.exit(0);
  } catch (err) {
    // Gmailへ到達できない = 設定かネットワークの問題。これは人が直す
    // 必要があるので、はっきり失敗として終わる。
    console.error(`[ingest-mercari-mail] 失敗: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
