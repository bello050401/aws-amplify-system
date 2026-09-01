#!/usr/bin/env node
/**
 * AgentCore Web Search Gateway の構築（冪等・再実行可能）。
 *
 * Run with:
 *   node scripts/aws-setup/13-create-web-search-gateway.mjs            # 現状確認のみ
 *   node scripts/aws-setup/13-create-web-search-gateway.mjs --apply    # 作成/更新
 *   node scripts/aws-setup/13-create-web-search-gateway.mjs --destroy  # 削除
 *
 * 【なぜPowerShellではなくNodeか】12-* はPowerShellだが、あちらで
 * 実際に踏んだ問題（AWS CLIが `file://` をcp932で読む / `Set-Content
 * -Encoding utf8` のBOMがParamValidationを起こす / `Get-Content -Raw`
 * が装飾付き文字列を返す）は、すべてJSONペイロードを渡す場面で起きた。
 * このスクリプトはIAMポリシーとターゲット設定という**JSONだらけ**の
 * 構成なので、同じ地雷を踏み直さないためにNodeで書く。
 *
 * 【作るもの（これ以外は作らない）】
 *   1. IAMロール BelloAgentCoreWebSearchGatewayRole（Gatewayのサービスロール）
 *   2. AgentCore Gateway  bello-web-search（MCP / AWS_IAM 認可）
 *   3. Gateway Target     web-search-tool（connector: web-search 1.2.0）
 *   4. 呼び出し側（Amplify SSR実行ロール）へのインラインポリシー
 *
 * 【最小権限】
 *   - サービスロール: InvokeGateway は**作成後に実Gateway ARNへ絞り直す**
 *     （作成前はARNが決まらないため、初回だけ gateway/* で作る）。
 *     InvokeWebSearch はサービス所有ARN 1つだけ。
 *   - 呼び出し側: InvokeGateway を実Gateway ARNだけに許可。
 *
 * 【費用】Web Search $7/1,000クエリ。Gateway呼び出し $0.005/1,000。
 * ツール索引 $0.02/100ツール/月（1ツールなので月0.03円程度）。固定費なし。
 */
import { execFileSync } from "node:child_process";

const REGION = "ap-northeast-1"; // Web Search Toolの提供リージョンかつ日本語の一次情報に近い
const PROFILE = process.env.AWS_PROFILE_NAME ?? "Bello";
const GATEWAY_NAME = "bello-web-search";
const TARGET_NAME = "web-search-tool";
const ROLE_NAME = "BelloAgentCoreWebSearchGatewayRole";
const CALLER_ROLE_NAME = "BelloAmplifyStagingComputeRole";
const CALLER_POLICY_NAME = "BelloAgentCoreWebSearchInvoke";
const CONNECTOR_VERSION = "1.2.0"; // リクエスト単位のドメイン絞り込みは1.2.0以降

const APPLY = process.argv.includes("--apply");
const DESTROY = process.argv.includes("--destroy");

function aws(service, action, args = [], { region = REGION, ignoreError = false } = {}) {
  try {
    const out = execFileSync(
      "aws",
      [service, action, ...args, "--profile", PROFILE, "--region", region, "--output", "json"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } },
    );
    return out.trim() ? JSON.parse(out) : {};
  } catch (err) {
    if (ignoreError) return null;
    const stderr = err.stderr?.toString() ?? String(err);
    throw new Error(`aws ${service} ${action} が失敗しました:\n${stderr}`);
  }
}

/** IAMはグローバルだが、CLIには--regionを渡しても害はない。us-east-1固定で呼ぶ。 */
function iam(action, args = [], opts = {}) {
  return aws("iam", action, args, { ...opts, region: "us-east-1" });
}

const ACCOUNT_ID = aws("sts", "get-caller-identity", [], { region: "us-east-1" }).Account;

const trustPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AllowAgentCoreToAssumeRole",
      Effect: "Allow",
      Principal: { Service: "bedrock-agentcore.amazonaws.com" },
      Action: "sts:AssumeRole",
      Condition: {
        StringEquals: { "aws:SourceAccount": ACCOUNT_ID },
        ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:gateway/*` },
      },
    },
  ],
};

/** gatewayArnが分かっていればそこへ絞る。初回作成時のみ gateway/* になる。 */
function servicePolicy(gatewayArn) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "InvokeGateway",
        Effect: "Allow",
        Action: "bedrock-agentcore:InvokeGateway",
        Resource: gatewayArn ?? `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:gateway/*`,
      },
      {
        Sid: "InvokeWebSearch",
        Effect: "Allow",
        Action: "bedrock-agentcore:InvokeWebSearch",
        // サービス所有の固定ARN。ここは絞りようがない（公式ドキュメント記載のとおり）。
        Resource: `arn:aws:bedrock-agentcore:${REGION}:aws:tool/web-search.v1`,
      },
    ],
  };
}

function callerPolicy(gatewayArn) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "InvokeBelloWebSearchGateway",
        Effect: "Allow",
        Action: "bedrock-agentcore:InvokeGateway",
        Resource: gatewayArn,
      },
    ],
  };
}

function findGateway() {
  const list = aws("bedrock-agentcore-control", "list-gateways");
  return (list.items ?? []).find((g) => g.name === GATEWAY_NAME) ?? null;
}

function findTarget(gatewayId) {
  const list = aws("bedrock-agentcore-control", "list-gateway-targets", ["--gateway-identifier", gatewayId], { ignoreError: true });
  return (list?.items ?? []).find((t) => t.name === TARGET_NAME) ?? null;
}

function ensureRole() {
  const existing = iam("get-role", ["--role-name", ROLE_NAME], { ignoreError: true });
  if (existing) {
    console.log(`  [=] IAMロール ${ROLE_NAME} は既にある`);
    iam("update-assume-role-policy", ["--role-name", ROLE_NAME, "--policy-document", JSON.stringify(trustPolicy)]);
    return existing.Role.Arn;
  }
  const created = iam("create-role", [
    "--role-name",
    ROLE_NAME,
    "--assume-role-policy-document",
    JSON.stringify(trustPolicy),
    "--description",
    // IAMのdescriptionはASCII(Latin-1)しか受け付けない(ValidationErrorで実測)。
    "BELLO inquiry reply web search - role assumed by AgentCore Gateway to call the Web Search Tool.",
  ]);
  console.log(`  [+] IAMロール ${ROLE_NAME} を作成`);
  return created.Role.Arn;
}

function putServicePolicy(gatewayArn) {
  iam("put-role-policy", [
    "--role-name",
    ROLE_NAME,
    "--policy-name",
    "BelloAgentCoreWebSearchAccess",
    "--policy-document",
    JSON.stringify(servicePolicy(gatewayArn)),
  ]);
  console.log(`  [+] サービスロールのポリシーを更新（InvokeGateway → ${gatewayArn ?? "gateway/*（初回）"}）`);
}

function putCallerPolicy(gatewayArn) {
  iam("put-role-policy", [
    "--role-name",
    CALLER_ROLE_NAME,
    "--policy-name",
    CALLER_POLICY_NAME,
    "--policy-document",
    JSON.stringify(callerPolicy(gatewayArn)),
  ]);
  console.log(`  [+] 呼び出し側 ${CALLER_ROLE_NAME} に InvokeGateway を付与（対象: このGatewayのみ）`);
}

function ensureGateway(roleArn) {
  const existing = findGateway();
  if (existing) {
    console.log(`  [=] Gateway ${GATEWAY_NAME} は既にある (${existing.status})`);
    return aws("bedrock-agentcore-control", "get-gateway", ["--gateway-identifier", existing.gatewayId]);
  }
  const created = aws("bedrock-agentcore-control", "create-gateway", [
    "--name",
    GATEWAY_NAME,
    "--role-arn",
    roleArn,
    "--protocol-type",
    "MCP",
    "--authorizer-type",
    "AWS_IAM",
    "--description",
    "BELLO inquiry reply external research - exposes the Web Search Tool only.",
  ]);
  console.log(`  [+] Gateway ${GATEWAY_NAME} を作成`);
  return created;
}

function ensureTarget(gatewayId) {
  const existing = findTarget(gatewayId);
  const targetConfiguration = {
    mcp: {
      connector: {
        source: { connectorId: "web-search", version: CONNECTOR_VERSION },
        // 目的外の絞り込みはしない。公式サイト優先はリクエスト単位の
        // domainFilterで行う（target側で固定すると、公式が見つからない
        // ときに範囲を広げられなくなる）。
        configurations: [{ name: "WebSearch", parameterValues: {} }],
      },
    },
  };
  const credentialProviderConfigurations = [{ credentialProviderType: "GATEWAY_IAM_ROLE" }];

  if (existing) {
    console.log(`  [=] Target ${TARGET_NAME} は既にある (${existing.status})`);
    return existing;
  }
  const created = aws("bedrock-agentcore-control", "create-gateway-target", [
    "--gateway-identifier",
    gatewayId,
    "--name",
    TARGET_NAME,
    "--target-configuration",
    JSON.stringify(targetConfiguration),
    "--credential-provider-configurations",
    JSON.stringify(credentialProviderConfigurations),
  ]);
  console.log(`  [+] Target ${TARGET_NAME} を作成`);
  return created;
}

function destroy() {
  const gateway = findGateway();
  if (!gateway) {
    console.log("  [=] Gatewayが無いので削除するものはありません");
  } else {
    const target = findTarget(gateway.gatewayId);
    if (target) {
      aws("bedrock-agentcore-control", "delete-gateway-target", ["--gateway-identifier", gateway.gatewayId, "--target-id", target.targetId]);
      console.log(`  [-] Target ${TARGET_NAME} を削除`);
    }
    aws("bedrock-agentcore-control", "delete-gateway", ["--gateway-identifier", gateway.gatewayId]);
    console.log(`  [-] Gateway ${GATEWAY_NAME} を削除`);
  }
  iam("delete-role-policy", ["--role-name", CALLER_ROLE_NAME, "--policy-name", CALLER_POLICY_NAME], { ignoreError: true });
  iam("delete-role-policy", ["--role-name", ROLE_NAME, "--policy-name", "BelloAgentCoreWebSearchAccess"], { ignoreError: true });
  iam("delete-role", ["--role-name", ROLE_NAME], { ignoreError: true });
  console.log("  [-] IAMロール・ポリシーを削除");
}

function main() {
  console.log(`アカウント ${ACCOUNT_ID} / リージョン ${REGION}`);

  if (DESTROY) {
    if (!APPLY) {
      console.log("--destroy は --apply と併せて実行してください。");
      process.exit(1);
    }
    destroy();
    return;
  }

  if (!APPLY) {
    const gateway = findGateway();
    console.log("== 現状 ==");
    console.log(`  Gateway: ${gateway ? `${gateway.gatewayId} (${gateway.status})` : "未作成"}`);
    if (gateway) {
      const target = findTarget(gateway.gatewayId);
      console.log(`  Target : ${target ? `${target.targetId} (${target.status})` : "未作成"}`);
      const full = aws("bedrock-agentcore-control", "get-gateway", ["--gateway-identifier", gateway.gatewayId]);
      console.log(`  URL    : ${full.gatewayUrl}`);
    }
    console.log(`  IAMロール: ${iam("get-role", ["--role-name", ROLE_NAME], { ignoreError: true }) ? "あり" : "未作成"}`);
    console.log("\n(--apply を付けると作成/更新します)");
    return;
  }

  console.log("== 作成/更新 ==");
  const roleArn = ensureRole();
  // 既にGatewayがあるなら、実ARNが分かっているので広い権限を経由しない。
  // 毎回 gateway/* を書いてから絞り直すと、再実行のたびに一瞬だけ
  // 権限が広がる（冪等ではあっても最小権限ではない）。
  const known = findGateway();
  if (!known) putServicePolicy(null); // 初回だけ、ARN未確定のため gateway/*
  // IAMロールの反映には数秒かかることがある。作成が
  // AccessDenied で落ちたときに一度だけ待って再試行する。
  let gateway;
  try {
    gateway = ensureGateway(roleArn);
  } catch (err) {
    if (!/AccessDenied|not authorized|cannot be assumed/i.test(String(err))) throw err;
    console.log("  ... IAMの反映待ち（10秒）");
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},10000)"]);
    gateway = ensureGateway(roleArn);
  }

  const gatewayArn = gateway.gatewayArn;
  const gatewayId = gateway.gatewayId;
  ensureTarget(gatewayId);

  // ここで初めて実ARNが分かるので、最小権限へ絞り直す。
  putServicePolicy(gatewayArn);
  putCallerPolicy(gatewayArn);

  const full = aws("bedrock-agentcore-control", "get-gateway", ["--gateway-identifier", gatewayId]);
  console.log("\n== 結果 ==");
  console.log(`  Gateway ARN : ${gatewayArn}`);
  console.log(`  Gateway URL : ${full.gatewayUrl}`);
  console.log(`  状態        : ${full.status}`);
  console.log("\nこのURLを Amplify の環境変数 AGENTCORE_GATEWAY_URL に設定してください（秘密値ではありません）。");
}

main();
