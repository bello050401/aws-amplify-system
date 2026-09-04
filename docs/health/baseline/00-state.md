# PHASE 0 ベースライン (2026-09-04T07:35:48Z)

## Git
```
branch: claude/inventory-management-system-5vbvc7
HEAD:   ca7a368d3373689f7a18dd2205cad013ea283bd3
origin: ca7a368d3373689f7a18dd2205cad013ea283bd3
--- status ---
?? docs/health/
--- untracked (tools除く) ---
?? docs/health/baseline/00-state.md
```

## 実行環境
```
node: v24.20.0
npm:  11.19.0
os:   MINGW64_NT-10.0-19045 3.6.10-710e5275.x86_64
```

## Amplify / Staging 対象
```
d1uy61lbnqm8ae	aws-amplify-system	https://github.com/bello050401/aws-amplify-system
d4hkkg7dty2du	bello-inventory-staging	https://github.com/bello050401/aws-amplify-system
--- branch job ---
ca7a368d3373689f7a18dd2205cad013ea283bd3	226	SUCCEED
```

## Secrets（存在有無のみ。値は出力しない）
```
存在: bello/zaico-api-token
存在: bello/mercari-access-token
存在: bello/line-channel-secret
存在: bello/mercari-relay
存在: bello/base-app-credentials
存在: bello/line-notify-bot
存在: bello/gmail-oauth
```

## Amplify 環境変数（キー名のみ。値は出力しない）
```
設定済み: AGENTCORE_GATEWAY_URL
設定済み: CONVERSATION_TABLE_NAME
設定済み: MERCARI_RELAY_URL
設定済み: MESSAGE_TABLE_NAME
設定済み: MESSAGING_ATTACHMENT_BUCKET
```
