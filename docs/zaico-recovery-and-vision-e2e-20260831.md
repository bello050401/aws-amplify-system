# ZAICO実データ復旧と AI Vision Staging実機E2E（2026-08-31）

対象ブランチ: `claude/inventory-management-system-5vbvc7`
対象環境: Staging（AppSync `j6up24p7lnczdmklzjdt3vrp4y` / us-west-2）
※ 操作前に `amplify_outputs.json` の GraphQL エンドポイントと AppSync API ID を
照合し、Production ではないことを確認したうえで実施した。

## 1. ZAICO 1件が「永久に取り込めない」状態だった

### 前回報告の訂正

前回「一過性の失敗」と報告したが、**誤りだった**。マッピング処理だけを検証して
結論を出しており、リンク側を見ていなかった。実際は再実行しても直らない状態だった。

### 実測した状態

| 項目 | 値 |
|---|---|
| ZaicoSourceLink | ZAICO#48824174 → `4aa85601-b1eb-4189-a551-4ed953160e18` |
| 参照先 Inventory | **存在しない**（GetItem で NOT FOUND） |

この状態だと `zaicoSyncEngine` は毎回
「重複防止リンクは存在しますが、参照先のInventoryレコードが見つかりません」
を投げる。つまり**その1件は何度同期しても取り込めない**。

### 根本原因

`releaseSourceLink` が Amplify の `errors` を検査せず `await` するだけだった。
create 失敗時の補償（claim の解放）が失敗しても成功と区別できず、ログにも
何も残らなかった。

修正:
- `releaseSourceLink` が `errors` を検査して失敗を投げる。
- 補償の失敗で**元の失敗原因が消えない**ようにした。そのまま投げ直すと
  本来の原因（SKU採番失敗、create失敗など）が失われて調査できなくなるため、
  両方をメッセージに残す（`releaseClaimPreservingError`）。
- `scripts/repair-zaico-dangling-links.ts` を追加（既定ドライラン）。

### 修復の実行

```
ドライラン: 宙に浮いたリンク 1件 — ZAICO 48824174 -> 4aa85601-...
            （JSON退避を作成、Inventory本体は対象外）
--apply   : 削除 ZAICO#48824174  → 1件削除
```

その後、全件同期を最初から実行:

```
status=COMPLETED  processed=5312
created=1  updated=17  unchanged=5294  failed=0
12:11:21Z → 12:12:19Z
```

`created=1` が、取り込めなくなっていた 48824174 である。

## 2. ZAICO実件数との突合（ジョブの自己申告に頼らない）

同期ジョブが COMPLETED でも「全件入った」証明にはならない。実際、前回の同期は
`COMPLETED / processed=5,312 / missing=0` を報告しながら BELLO には 5,311件しか
無かった。そこで ZAICO API の実件数と DynamoDB の実データを直接突合する
（`scripts/verify-zaico-reconciliation.ts`）。

```
ZAICO API: 5312件（ユニーク 5312件）
BELLO:     ZAICO由来 5313件 / リンク 5313件

✓ 欠落なし（ZAICOの全在庫がBELLOに存在する） — 0件 / ZAICO 5312件
✓ 重複なし — 0件
✓ 宙に浮いたリンクなし — 0件
✓ リンク件数とZAICO由来行の件数が一致 — 5313 / 5313
✓ BELLO側の余剰は、すべて同期ジョブが把握している上流削除である
```

### BELLO が 1件多い理由

ZAICO ID **73357788** は `GET /inventories/73357788` が **HTTP 404** を返す。
同期後に ZAICO 側で削除された在庫である。

BELLO は ZAICO の削除を追いかけて自動削除しない。schema にも
「This is reporting only — nothing is ever auto-deleted from BELLO」と明記されて
おり、商品写真・内部メモ・ListingDraft 等が ZAICO 側の操作だけで消えるのを
避けるための設計判断である。同期ジョブも `missingSourceIds: ["73357788"]` として
正しく報告していた。**したがってこれは異常ではなく仕様どおりの状態**であり、
突合ツールもこれを失敗とせず、「ジョブが把握しているか」で検査する。

**結論: ZAICO 5,312件はすべて BELLO に存在する（欠落0・重複0・孤立リンク0・失敗0）。**

## 3. AI Vision — Staging 実機E2E（REAL MODEL VERIFIED）

### デプロイ状態の確認

| 項目 | 実測 |
|---|---|
| 環境変数 | `BELLO_VISION_ENABLED=true` / `MODEL_ID=us.amazon.nova-lite-v1:0` / `REGION=us-west-2` / `MAX_CALLS_PER_RUN=3` / `MAX_MS_PER_RUN=90000` |
| IAM | `bedrock:InvokeModel` — 推論プロファイル + 基盤モデル(us-east-1 / us-east-2 / us-west-2) |
| 推論プロファイルの実ルーティング先 | `get-inference-profile` の実測値と**完全一致** |

`us.` 接頭辞は推論プロファイルなので、プロファイル ARN だけでは `AccessDenied`
になる。ルーティング先の各リージョンの基盤モデル ARN も必要で、実測して一致を確認した。

### 実機呼び出し（CloudWatch 実ログ）

```
[image-processing-worker] 2 pending job(s) (max 20/run); vision=enabled(3 calls / 90000ms per run).
[image-processing-worker] vision: requested=true trigger=NO_LOCAL_SUBJECT applied=true
                          model=us.amazon.nova-lite-v1:0 latency=1495ms avoid=1
[image-processing-worker] vision budget: 1 call(s) / 1495ms
```

2件処理して **AI 呼び出しは 1回だけ**。丸テーブルはローカル解析で足りたため
呼ばれていない。本番でも「難例だけに使う」が実際に効いている。

### 実画像の加工結果（Staging 出力）

| | 元画像 | Staging出力 |
|---|---|---|
| 寸法 | 1705×960 | **875×584** |
| 被写体占有率 | 2.3% | **8.7%**（お手本 9.9%） |
| 背景輝度 | 51 | **152** |
| 白飛び | 0.0% | 0.1% |
| 黒潰れ | 3.4% | **0.0%** |

ローカルベンチマークと**完全に同じ値**。デプロイ環境とローカルで結果が一致している。

### 実写8枚はどれもAIを呼ばない

| ファイル | 背景輝度 | 確信度 | 判定 |
|---|---|---|---|
| 8枚すべて | 51〜214 | 0.78〜1.00 | **ローカルで足りる** |

露出補正を被写体検出の前へ動かした改修により、参照写真はすべてローカルだけで
解決する。したがって通常の商品写真では **AI のコストが一切発生しない**。
実機E2Eで AI 経路を通すため、仕様が難例として名指しする white-on-white を用いた。

### 障害時 fallback（実環境で障害を注入）

モデルIDを一時的に存在しないものへ差し替えて実行:

```
WARN [BedrockVisionAnalyzer] attempt 1/2 failed: ValidationException
WARN [BedrockVisionAnalyzer] attempt 2/2 failed: ValidationException
INFO vision: requested=true trigger=NO_LOCAL_SUBJECT applied=false model=- latency=-ms avoid=0
ProcessingJob status: DONE  error: (なし)
```

- 例外の**名前だけ**を記録し、画像も Secret も出していない。
- `applied=false` でローカル解析に戻り、**加工は正常に完了**（DONE、エラーなし）。
- 検証後、環境変数は元の状態へ完全復元したことを diff で確認した。

### 後片付け

E2E 用に作成したもの（テスト在庫1件、ProcessingJob 3件、
ImageProcessingVersion 3件、S3 の元画像2件と派生画像9件）はすべて削除した。
削除後に再度突合を実行し、ZAICO 由来データが無傷であることを確認している。

## 4. 検証結果

- テスト **782 passed / 0 failed**（14スイート）
- lint / typecheck / build いずれも通過
- 実画像ベンチマーク: 「理想へ向かって改善しない項目はありませんでした。」
