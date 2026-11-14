export const DEFAULT_CODEX_MODEL = "gpt-6.1-sol";
export const DEFAULT_CODEX_EFFORT = "medium";

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function validReasoningEffort(value, model) {
  if (!REASONING_EFFORTS.includes(value)) return false;
  if (/^gpt-6(?:\.1)?-(?:sol|terra|astra|luna)$/.test(model || "") && ["none", "minimal"].includes(value)) return false;
  return value !== "ultra" || !/^gpt-6(?:\.1)?-luna$/.test(model || "");
}

export function reasoningEffortArg(reasoningEffort = DEFAULT_CODEX_EFFORT, model) {
  if (!validReasoningEffort(reasoningEffort, model)) throw Error("Invalid Codex reasoning effort for " + (model || "model"));
  return `model_reasoning_effort="${reasoningEffort}"`;
}

export function restrictedCodexArgs(sandbox) {
  const args = [
    "--ignore-user-config",
    "--sandbox", sandbox,
    "-c", 'approval_policy="never"',
    "-c", 'model_provider="openai"',
    "-c", 'forced_login_method="chatgpt"',
    "-c", 'web_search="disabled"',
    "--ephemeral", "--json", "--color", "never",
  ];
  if (sandbox === "workspace-write") args.push("-c", "sandbox_workspace_write.network_access=false");
  if (process.platform === "win32") args.push("-c", 'windows.sandbox="elevated"');
  return args;
}
