# AI問い合わせ返信の費用制御 — 調査と設計案（2026-09-10）

指示書§4「AI gateway費用制御は調査設計のみをまず報告する」への対応。
**このドキュメントは調査と設計案のみ。新規の有料API契約・モデル変更・
実際の上限実装は行っていない。**

## 1. 現状調査（実コードで確認した事実）

### 1.1 既定Providerは Nova（Bedrock）で、コストが記録されていない

`lib/ai/gateway/gateway.ts` の `resolveProviderId()` は、`AI_GATEWAY_PROVIDER`
未指定かつ `ANTHROPIC_API_KEY` 未設定のとき **`"nova"`** を返す
（AnthropicモデルはこのAWSアカウントで利用申請未提出のため404になる、と
コード中に理由が明記されている）。

`lib/ai/gateway/novaProvider.ts` の `estimateCost()` は常に `null` を返す:

```ts
estimateCost(): number | null {
  // Novaの単価表をこのコードへ埋め込まない。実測していない値を
  // 「正しいコスト」として記録するとログが嘘になる(§157 fake success禁止)。
  return null;
}
```

つまり **現在の既定構成では、問い合わせ返信1件ごとの `AIUsageLog.estimatedCostUsd`
は常に空**。トークン数(`inputTokens`/`outputTokens`)とレイテンシは記録されて
いるが、金額は分からない。Anthropic直APIまたはBedrock経由Anthropicへ切り替えた
場合のみ、`modelRegistry.ts` / `BEDROCK_MODEL_REGISTRY` の単価表から金額が
算出される（2026-08-30時点の第三者料金比較サイト確認値）。

### 1.2 1件の問い合わせ返信が呼びうるモデル回数

`lib/inquiry/pipeline.ts` の生成ループ:

- `REPLY_MAX_GENERATION_ATTEMPTS = 3`（`validate.ts`）: 検査不合格なら
  最大3回まで作り直す。
- 各回は `tier: "STANDARD"` で `generateText` を呼ぶが、`router.ts` の
  `routeGenerateText` が品質ゲート不合格時に **PREMIUM(Opus)へ1回だけ
  escalation** する。

組み合わせると、**1件の返信案生成で最悪 STANDARD 3回 + PREMIUM(escalation分)
最大3回 = 最大6回**のモデル呼び出しが起こりうる。Anthropic/Bedrock Anthropic
利用時、PREMIUM(Opus 5)は $5/$25 per 100万トークンで、STANDARD(Sonnet 5)の
$2/$10 より高い。再試行のたびにPREMIUMへ落ちる問い合わせが続くと、件数の
わりに費用が跳ねる経路になっている。

### 1.3 Web検索（AgentCore）は既に発動条件で絞られている

`docs/ai-inquiry-reply-20260901.md` の記載どおり、$7/1,000クエリ
(+ Gateway呼び出し $0.005/1,000、ツール索引 $0.02/100ツール/月)。
`identifyResearchableFields` が空を返せば外部へ1リクエストも出ない。
今回の実装（本コミット）で、BASE商品説明から既に分かっている項目
(素材・重量・型番・色)は重ねて調べないよう追加で絞った
(`lib/inquiry/pipeline.ts` の `knownFieldsFromContext`)。

### 1.4 月次の上限判定・自動停止は存在しない

`lib/ai/gateway/usageLog.ts` の `listAIUsageLogs(sinceIso)` は task別の
集計を返す関数はあるが、**呼び出し側でこれを月初からの合計と比較して
生成を止める処理はコードベースのどこにも無い**(grep で確認)。
`lib/inquiry/settings.ts` の `autoDraftEnabled` は人が手動で切り替える
ON/OFFのみで、費用に連動した自動停止ではない。

## 2. 「月300円以下」を単価だけで保証できない理由

- 既定のNova経由では単価そのものが未記録(1.1)。単価が無い以上、
  コード内の「$を積算して止める」方式はNova使用時には機能しない。
- Anthropic/Bedrock Anthropicへ切り替えた場合でも、実際の請求は
  AWS側の課金(Bedrock経由は「AWSが販売するパートナー提供」であり、
  Anthropic直の公開単価と一致する保証が無いと `modelRegistry.ts` に
  明記されている)。コード内の見積りは概算にとどまる。
- 再試行(1.2)により、同じ「1件の返信」でも実際の呼び出し回数・
  モデル階層は問い合わせの内容によって変動する。単価×件数の単純計算
  では実際の変動を捉えられない。

したがって、月300円以下を**保証**するには、アプリ内の見積りだけでなく
実請求ベースの安全弁を併用する必要がある。

## 3. 上限到達時の停止＋無料テンプレートfallback（設計案。未実装）

### 3.1 二段構え

| 段 | 何を見るか | 何をするか | Provider依存 |
|---|---|---|---|
| 一次(アプリ内) | `AIUsageLog` の当月合計(呼び出し回数 / トークン量 / `estimatedCostUsd`のうち取れるもの) | 上限到達で生成をスキップし、無料テンプレートへfallback | 回数・トークン量は非依存。$は取れる場合のみ |
| 二次(AWS側) | AWS Budgets のBedrock/AgentCore実請求 | しきい値超過でSNS通知(自動停止はしない。運用者が`autoDraftEnabled`をOFFにする) | 課金操作にあたるため実装・設定は本タスクの範囲外(userActionsで報告) |

一次だけでは「実際に$300円を超えない」保証にならない(2章)。二次だけでは
通知が来るまでの間は生成され続ける。両方を組み合わせて初めて「大きくは
超えない」設計になる。

### 3.2 一次(アプリ内)判定の具体案

```
generateInquiryReplyDraft() 呼び出し直前に:
  1. listAIUsageLogs(今月1日 0:00 JST の ISO文字列) を取得
  2. task === "CUSTOMER_REPLY_DRAFT" の行を合計する
     - estimatedCostUsd が取れる行はその合計
     - Nova等でnullの行は「呼び出し回数」を別カウントし、
       回数ベースの上限(例: 実測した平均トークン数から逆算した
       目安件数)と比較する
  3. 上限に達していたら:
     - settings.autoDraftEnabled を無視して生成をスキップ
     - status: "READY"にはせず、既存の UNRESOLVED / TRUSTED_FACTS から
       機械的に組み立てた定型文(AI呼び出しゼロ、追加費用ゼロ)を
       draftText として返す。「送信は常に人が確認する」既存挙動は
       変えない — 定型文もこれまでの返信案と同じ確認画面を通る
     - evidence に「費用上限のため今月はAI生成を停止しています」を
       残し、UIに出す(§19 成功したふりをしない、と同じ扱い)
```

**並列予約について**: 複数の担当者が同時に「AI返信案を作成」を押した
場合、上の判定は「読み取った時点の合計」に基づくため、同時押しの分だけ
わずかに上限を超えうる(ハードな予約ロック/排他制御ではない)。月300円
という上限は「大きく超えないための目安」であり、数件の同時実行による
数円単位の超過は許容する前提を置く(ロックを掛けるほどの費用感ではない
と判断)。

**月境界**: JSTの月初(`toLocaleString` 等ではなくISO日付で比較)を基準にする。
`listAIUsageLogs` は既に `sinceIso` を受け取れる作りなので、呼び出し側で
「今月1日 00:00 JST」のISO文字列を渡すだけで済む。

**最大入力・出力・再試行費**: `REPLY_MAX_GENERATION_ATTEMPTS`(3)と
routerのescalation(最大+1)の掛け算(2.2)が費用のばらつきの主因。
上限に近づいた月だけ `REPLY_MAX_GENERATION_ATTEMPTS` を一時的に
引き下げる、または escalationを止める、という調整余地をコード上に
残しておくと安全弁になる(具体的な閾値・実装は本タスクでは行わない)。

### 3.3 無料テンプレートfallbackの中身

- AIを一切呼ばない。`trustedProductFacts` / `shipping` / `unresolved` /
  `negotiationResult.customerSafeFacts` を機械的に箇条書きへ変換する
  だけの純粋関数として書ける(新規の依存もコストも無い)。
- 「まだ分かっていること」しか書けないため、既存のAI生成より文章の
  自然さは落ちる。これは費用ゼロの代償として明示し、上限に達した月だけ
  発生する一時的な劣化であることをUIに出す。

## 4. 無料優先の限界（QA確認事項への回答）

QAはGoogle公式の料金・課金ページで無料/有料のデータ取扱差を確認済み、
との前提を踏まえ:

- 現在Web検索に使っている **Amazon Bedrock AgentCore Web Search は無料
  ではない**($7/1,000クエリ)。`docs/ai-inquiry-reply-20260901.md` に
  記載の比較表のとおり、無料で使える代替(Google Custom Search無料枠・
  Bing・DuckDuckGo等)はいずれも新規受付終了/廃止済み/実質使えないことを
  確認済みで、これは覆っていない。
- 文章生成側の既定(Nova/Bedrock)は「申請不要で今動く」経路であって
  「無料と確認された」経路ではない(1.1)。単価を実測してコード化する
  作業は本タスクの範囲外だが、次のステップとして残す。
- 個人情報を外部(Web検索・外部AI)へ送らない設計は既存のまま変更していない
  (指示書§5の範囲外の変更はしていない)。無料かどうかに関わらず、
  問い合わせの原文・識別情報は本タスクの調査・実装のどこにも使っていない。

## 5. 次のステップ（本タスクでは未実施）

1. Nova(Bedrock)の実単価をAWS請求から確認し、`estimateCost()` を
   実測値で埋める(現状の `null` を「未検証だから空」のままにしない)。
2. 上の3.2を純粋関数として実装し、`scripts/verify-*.ts` 相当の
   fixtureテストを書く(依存ゼロで検証できる設計にする)。
3. AWS Budgets のしきい値設定(課金・IAMに関わる操作のため、
   実施はuserActionsとして運用者に依頼する)。
