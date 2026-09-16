# GPT / Claude 実モデル小規模比較

2026-09-16、既存ChatGPT / Claude Max認証を用いて各3件を実行。新たなAPIキー・課金設定・モデル切替による利用枠回避はなし。原データは `C:/Users/win/Documents/Codex/bello-model-pilot-20260916`。

| 担当・課題 | 指定モデル | 独立検査成功 | 平均総token | 平均秒 |
| --- | --- | --- | --- | --- |
| GPT・抽出 | gpt-5.6-terra | 3/3 | 10,816 | 4.83 |
| GPT・抽出 | gpt-5.6-luna | 3/3 | 9,259 | 4.88 |
| Claude・定型修正 | sonnet | 2/3 | 5,623 | 4.59 |
| Claude・定型修正 | haiku | 3/3 | 4,744 | 5.42 |

Lunaの総tokenはTerra比約14.4%少ない。HaikuはSonnet比約15.6%少ない。ただし入力・キャッシュ・出力を合算した観測値であり、料金または定額契約の利用枠の削減率ではない。速度改善は今回観測できていない。Sonnetの1件は正答をJSON文字列内へ二重包装し独立検査失敗。再試行で結果を上書きしていない。3件の差から一般的な品質優劣は判定しない。

Claude CLIが報告した実モデルにはsonnet実行でclaude-sonnet-5と補助haiku、haiku実行でclaude-haiku-4-5-20251001が含まれる。Codex JSONイベントに解決済みモデル名がないため、指定モデル名と成功した起動を記録し、内部モデルIDを推測しない。

## 実装と確認

- 独立した文字列検査、キャッシュ二重計上防止、少数/重複試行の水増し防止を追加。
- 実GPTテキストworkerを追加し、既存routingから指定モデルへ接続、結果保存と再照会の一致を実動作確認。ブラウザ能力は付与せず、実画面QAは従来のデスクトップ経路を維持。
- 中断して結果不明の操作は再送しない。モデル/実行IDを保存して取り違えを防止。
- 全213テスト、PowerShell構文検査成功。
- このpilotは各3件で、30件以上という自動切替基準を満たさない。通常業務のモデル設定は変更せず、評価結果を保存。主運用eco DB migrationや有効化も未実施。

次の実仕事では既存の標準モデルで安全に進める。定型作業の評価記録を蓄積してから自動切替を判定し、少数試験だけで全仕事へ展開しない。

参考: [Codex非対話実行](https://learn.chatgpt.com/docs/non-interactive-mode)、[Claude非対話実行](https://code.claude.com/docs/en/headless)、[Claudeモデル設定](https://code.claude.com/docs/en/model-config)。
