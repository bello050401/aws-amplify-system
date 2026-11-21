import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from '../log/redact.mjs';
import {stopOwnedWindowsTree} from './processTree.mjs';

// Do not pass service, cloud, or webhook credentials to repository-controlled code.
export function localEnvironment(source = process.env) {
  const allowed = /^(path|systemroot|windir|temp|tmp|userprofile|home|homedrive|homepath|appdata|localappdata|programfiles(?:\(x86\))?|programdata|comspec|pathext|os|processor_architecture|number_of_processors|tz)$/i;
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)));
}

export function runProcess({ file, args = [], cwd, env = localEnvironment(), input = '', timeoutMs = 60000, shouldStop = () => false, onOutput = () => {}, maxBytes = 4 * 1024 * 1024, terminalComplete = null }) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', bytes = 0, reason = null, timer, stopTimer, terminalTimer,cleanupDeadline, settled = false,cleanup=null,cleanupDone=Promise.resolve(),rootExit=null;
    const child = spawn(file === 'node' ? process.execPath : file, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    const finish = async (exitCode, error = null,cleanupExpired=false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(stopTimer);clearTimeout(terminalTimer);clearTimeout(cleanupDeadline);if(!cleanupExpired)await cleanupDone;else cleanup={pid:child.pid,confirmed:false,deadlineExpired:true};
      if(cleanup)cleanup={...cleanup,rootExit,rootExited:!!rootExit,confirmed:cleanup.killExitCode===0&&cleanup.treeGone===true&&!!rootExit};
      resolve({ exitCode, stdout, stderr, reason, error, ok: exitCode === 0 && !reason && !error,...(terminalComplete?{pid:child.pid,terminalCleanup:cleanup}:{}) });
    };
    const stop = why => {
      if (reason || settled) return;
      reason = why;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        if(why==='terminal_turn_cleanup'){
          cleanupDone=stopOwnedWindowsTree(child.pid,{rootStillOwned:()=>child.exitCode===null&&child.signalCode===null}).then(proof=>{cleanup=proof;}).catch(()=>{cleanup={pid:child.pid,confirmed:false};});
          cleanupDeadline=setTimeout(()=>finish(null,'Terminal CLI process cleanup remains unconfirmed',true),9500);return;
        }
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        if(why==='terminal_turn_cleanup')cleanup={requestedAt:new Date().toISOString(),method:'non-Windows cleanup not approved for CUA/MXC',pid:child.pid,killExitCode:null,treeGone:false};
      }
    };
    // The CLI may publish its durable report after its final stdout event.
    // Recheck the caller's unchanged proof predicate while the owned process
    // stays alive, and again before cleanup in case a late failure invalidated it.
    const checkTerminal = () => {
      if (!terminalComplete || terminalTimer || reason || settled) return;
      try {
        if (terminalComplete(stdout)) terminalTimer = setTimeout(() => {
          terminalTimer = null;
          if (reason || settled) return;
          try { if (terminalComplete(stdout)) stop('terminal_turn_cleanup'); }
          catch { /* An invalidated/missing report cannot authorize cleanup. */ }
        }, 1500);
      } catch { /* Incomplete durable proof stays subject to the normal timeout. */ }
    };
    for (const [stream, isError] of [[child.stdout,false],[child.stderr,true]]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) { stop('output_limit'); return; }
        const value = chunk.toString('utf8');
        if (isError) stderr += value; else stdout += value;
        if (!isError) checkTerminal();
        onOutput();
      });
    }
    child.on('error', err => finish(null, err.message));
    child.on('exit',(code,signal)=>{rootExit={code,signal,at:new Date().toISOString()};});
    child.on('close', code => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    stopTimer = setInterval(() => { if (shouldStop()) stop('stopped'); else checkTerminal(); }, 250);
  });
}

export function writeEvidence(directory, name, result) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, redactText(JSON.stringify(result, null, 2)) + '\n');
  return file;
}
