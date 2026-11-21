import fs from 'node:fs';
import path from 'node:path';
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
/** Host-only CUA profile: model tools cannot read the bridge or other host paths. */
export function scopedMxcCodexArgs({workDir,reportDirectory,protectedRoots=[]}){
  const inside=(a,b)=>{const r=path.relative(a,b);return !r||!r.startsWith('..')&&!path.isAbsolute(r);};
  for(const granted of [workDir,reportDirectory])for(const denied of protectedRoots){const a=fs.realpathSync(granted),b=fs.realpathSync(denied);if(inside(a,b)||inside(b,a))throw Error('Scoped worker grant overlaps host CUA/evidence ownership');}
  const base=restrictedCodexArgs('read-only'),args=[];
  for(let i=0;i<base.length;i++){
    if(base[i]==='--sandbox'){i++;continue;}
    if(base[i]==='-c'&&base[i+1]?.startsWith('windows.sandbox=')){i++;continue;}
    args.push(base[i]);
  }
  const profile='bello-cua-worker',entries=[[":root","deny"],[":minimal","read"],...[...new Set([workDir,reportDirectory])].map(directory=>[directory,'write'])];
  args.push('-c','default_permissions='+JSON.stringify(profile),'-c','windows.sandbox="mxc"','-c','permissions.'+profile+'.filesystem={'+entries.map(([key,value])=>JSON.stringify(key)+'='+JSON.stringify(value)).join(',')+'}');
  args.push('-c','permissions.'+profile+'.network.enabled=false','-c','mcp_servers={}');for(const feature of ['apps','browser_use','browser_use_external','browser_use_full_cdp_access','browser_annotation_api','in_app_browser','multi_agent','multi_agent_v2','skill_search','skill_mcp_dependency_install'])args.push('-c','features.'+feature+'=false');args.push('-c','features.skip_host_skill_discovery=true');return args;
}
