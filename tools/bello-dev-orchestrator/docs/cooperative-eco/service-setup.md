# 常駐eco接続 (serviceBindings) セットアップ

対象: `src/eco/serviceBindings.mjs` / `src/eco/serviceRuntime.mjs` / `src/app.mjs`。
`buildApp()` は既定で `createServiceBindings({config, paths, repo, logger})` を呼び、実接続を組み立てる。テストが `ecoBindings` を注入した場合はそちらを優先する。

## 対応profileは static-smoke のみ

`paths.dataRoot/eco-runtime.json` に以下の形で1個だけ書く。他のprofile idは拒否される。

```json
{
  "schemaVersion": 1,
  "profiles": {
    "static-smoke": {
      "repoPath": "...running config.repoPath と完全一致する絶対パス...",
      "allowedPaths": ["index.html", "README.md"],
      "qaUrl": "https://<amplify-app>.amplifyapp.com/",
      "allowedDomains": ["<amplify-app>.amplifyapp.com"],
      "verification": { "...": "running config.verification と一致" },
      "staging": { "mode": "static-smoke", "...": "running config.staging と一致" },
      "models": { "claude": { "model": "..." }, "codex": { "model": "..." } },
      "playwright": { "modulePath": "/絶対パス/playwright-core.mjs", "headless": true },
      "qaSteps": { "sequence": [ /* navigate ... reload ... screenshot */ ], "maxTotalSeconds": 60 },
      "expectedInitialBuild": { "sha256": "..." }
    }
  }
}
```

`validateRuntimeConfig()` はこのファイルと実行時 `config` を突き合わせ、1 項目でも不一致なら
例外を投げる。`repoPath` は `profile.repoPath` の専用static repoであり、通常の業務 main repo を
指定しても動かない前提 (`assertIsolated` がこの一致を毎回検査する)。

## 明示opt-inの独立profile (`configurationScope: "isolated-profile"`)

`configurationScope` を省略、または `"strict-match"` にした場合は上記のとおり
`repoPath`/`verification`/`staging`/`models.claude.model` が実行中の main `config` と
完全一致していなければ拒否される (既存互換、挙動は変わらない)。

main `config`（稼働中のrepoPath・キュー・環境設定）を一切変えずに、専用static-onlyの
別repoへ検証だけを独立接続したい場合は、profileに明示で `configurationScope:
"isolated-profile"` を指定する。この場合だけ以下に緩和される:

- `repoPath`: main `config.repoPath` と**異なる**絶対パスの、実在するgit repository root
  (`.git` が存在すること) でなければならない。main repoを指すと拒否される。
- `verification`: main `config.verification` と一致する必要はないが、`required:true` と
  1件以上の `commands` を持つ、profile自身の独立検証設定を明示しなければならない
  (独立検証は常に必須のままで、無効化はできない)。
- `staging`: main `config.staging` を継承しない。profile自身が
  `mode:"static-smoke"`、`enabled:true`、`isolatedDataConfirmed:true`、専用の
  `accountId`/`appId`/`branch`/`appName`/`region`/`profile` を明示した、専用
  `AmplifyStaticDelivery` ターゲットでなければならない。
- `models.claude.model`: 省略すれば host本体の `config.claude.model` を使う。明示すれば
  そのprofileだけそのモデルへ上書きできる。実行ファイルのパス (`config.claude.executable` /
  `config.codex.executable`) はhost本体のまま変わらない。
- `allowedPaths`（source inventory の唯一の許可範囲）・`qaUrl`/`allowedDomains`・
  `models.codex.model`・`playwright`・`qaSteps`・`expectedInitialBuild` の検証は
  `strict-match` と同じ。

最小例（main configのrepoPath/queue/環境設定は一切変更しない）:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "static-smoke": {
      "configurationScope": "isolated-profile",
      "repoPath": "C:/Users/win/Documents/Codex/dedicated-static-smoke-repo",
      "allowedPaths": ["index.html"],
      "qaUrl": "https://<dedicated-amplify-app>.amplifyapp.com/",
      "allowedDomains": ["<dedicated-amplify-app>.amplifyapp.com"],
      "verification": {
        "required": true,
        "commands": [{ "name": "smoke", "file": "true", "args": [] }]
      },
      "staging": {
        "mode": "static-smoke",
        "enabled": true,
        "isolatedDataConfirmed": true,
        "accountId": "123456789012",
        "appId": "dabcdefghij",
        "branch": "preview-orchestrator",
        "appName": "bello-orchestrator-smoke",
        "region": "ap-northeast-1",
        "profile": "bello-smoke"
      },
      "models": { "codex": { "model": "..." } },
      "playwright": { "modulePath": "/絶対パス/playwright-core.mjs", "headless": true },
      "qaSteps": { "sequence": [ /* navigate ... reload ... screenshot */ ], "maxTotalSeconds": 60 }
    }
  }
}
```

`prepareTask()` の worktree/checkpoint 一致条件 (`profileHash`) はこの `configurationScope`
を含む profile 全体のhashに基づくため、既存の再利用・checkpoint 互換動作はそのまま維持される。

## installed / enabled / connected / paused の区別

- **installed**: `eco_*` DBスキーマが導入済みか (`EcoStore.installed`)。未導入なら書き込みAPIは
  `"not installed"` で拒否される。ここは今回のタスクで一切自動導入しない。
- **enabled / mode**: `/api/eco/settings` の `config.enabled` と `config.mode`。ホストが明示operatorToken
  付きで書き換えるまで既定は `enabled:false`。起動時にこれを勝手に true へは戻さない。
- **connected**: `bindings.capabilities()` が返す `{connected, reason}`。`eco-runtime.json` が無い/
  不一致なら常に `connected:false` で、理由付きで正直に返す。設定欠落時、常駐サービス本体
  (旧キュー・ダッシュボード・他の機能) は落ちずに動き続ける。
- **paused**: `repo.getPaused()` (グローバル一時停止) と、個々のタスクの `state==="paused"`
  (eco run がそのタスクを掴んでいる間の legacy キュー退避)。どちらも既存の意味のまま、
  今回の変更で勝手に解除しない。

## 実probe手順

`bindings.refreshProbes()` が Claude 実行ファイル・Codex ログイン・Playwrightブラウザ起動・
staging preflight を実際に1回ずつ試し、結果を `paths.stateDir/eco-probes.json` に記録する
(`{ok, reason, at}` × 4種)。`capabilities()` はこのファイルの直近6時間以内の成功だけを
「接続済み」として答える。probeを装って未実施のまま接続済みと詐称しない。

`buildApp()` は起動時に、`createServiceBindings()` が実際に有効な profile を組み立てられた
(= `bindings.refreshProbes` が存在する) ときに限り、1回だけ `refreshProbes()` を呼ぶ。
失敗しても例外は投げず、ログに記録して「未接続」のまま起動を続ける。

## API から run を開始するには profileId が必須

`POST /api/eco/runs` の `body.profileId` は `serviceBindings.prepareTask()` に届く。
明示された `profileId` が接続中の `static-smoke` と一致しない場合、worktree作成前に拒否される
(空/未指定なら許可される — 唯一の対応profileへの確認用フィールドであり、選択用ではない)。

同じタスクに対する2回目以降の `prepareTask()` は、最初に保存した `eco_profile` checkpoint と
「profile全体のhash・revision・acIds・タスクのsource」が完全一致したときだけ既存worktreeを
再利用する。`eco-runtime.json` を書き換えた、または同じタスクを別のrevision/acIds/sourceで
再度動かそうとした場合は、黙って古いworktreeを再利用せず例外になる。

## 復旧と未知の扱い

- プロセス再起動後も `eco_profile` checkpoint から同じworktreeを引き継ぐ (上記の一致条件を満たす限り)。
- `eco-runtime.json` が読めない・スキーマ不一致・`config` とのdriftがあれば、常に「未接続」。
  古い接続情報を仮定して動かすことはしない。
- 未知のprofile id・未知のprofileフィールドはすべて起動時 `validateRuntimeConfig()` で拒否する。
