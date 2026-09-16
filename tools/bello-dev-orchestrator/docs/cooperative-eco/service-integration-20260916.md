# 常駐接続の実装記録（2026-09-16）

## 完了した局所工程

- 常駐runtime、ホスト所有の専用接続設定、実ブラウザ撮影、Codexの構造化仕様/画面判定、Claude実装接続を追加。
- 旧taskとの同一task二重実行を防止。無効化・モード変更・停止を進行中workerへ伝える。
- 設定画面に個別run登録・工程/成果物/未知使用量の表示を追加。実ブラウザで設定保存HTTP200と再読込保持、token消去、停止保持を確認。
- 独立検証キャッシュと短い文脈パケットを追加。両方とも再利用の条件を検証。実サービスへのキャッシュ注入、物理Read制御、全指標集計は未完であり、節約率を断定しない。
- 最終309テスト成功（`bello-eco-service-integration-20260916/final-after-e2e-tests.log`）。旧queue全体ガード、成果物自動修正、実ブラウザ証拠拡張を含む。

## 実接続で確認できたこと

- 既存契約のClaude/Codex、Chromium、専用Amplify環境のprobe成功。
- 専用環境の表示・再読込・前後撮影成功。既存業務staging/productionには接続していない。
- 実タスク `task_e898ba0c619d237fcc` / run `eco_48390d2c8af64bc79ca20d3e8db0d820` は、受付 → 実画面QA → 仕様 → Claude実装 → 独立テスト → 専用staging job 3 → HTTP照合 → 再読込を含む最終実画面QAを通り `COMPLETED_STAGING`。AC1/AC2ともPASS、commit `1b3a8966843f17ae7aaee87e8f08e425fa8e29c9`。
- 仕様scopeの書式不正はhostが拒否し、schemaをexact path enumへ限定。確定した読取専用成果物の書式不正だけ新しいoperation keyで有限再生成するよう修正した。未知の副作用は従来どおり再送しない。
- 最終QAでは画面だけで外部通信・フォーム等の不在を証明できなかったため、host実ブラウザがbounded network履歴とDOM要素件数を秘密値なしで証拠へ加えるよう修正。失敗工程だけを復旧し、最終ACを実証した。
- 全receipt・復旧記録・最終outcomeは `bello-eco-service-integration-20260916/managed/` に保持。

## 保全と未完

主DBは追加schema導入時に14既存テーブル/既存metaの同一性を確認。既存queueは停止中。主リポジトリの `docs/health/final-tests.md` のSHA256は `A9DD1EA3A5C3878F9AD6B0A3E7302398229CD57E3FDE554F7DDDCD88261A3CF0` のまま。

主ブランチへcommit `7dcda0f` として統合し、常駐サービスを再起動した。eco schema version 1、enabled=true、mode=cooperative_eco、browser/Claude/staging接続はいずれもtrue。旧queueは協調mode中にclaimしないガードを持ち、再開後の状態はidle。

この記録は全20節の将来拡張まで完成した証明ではない。残りは `requirements-traceability.md` を正本索引として管理する。今回完成した常駐接続経路の全体通し確認を毎回繰り返す運用にはせず、以後は実際の開発で変更した部分と受渡し境界を中心に検証する。
