import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from '../log/redact.mjs';

// Do not pass service, cloud, or webhook credentials to repository-controlled code.
export function localEnvironment(source = process.env) {
  const allowed = /^(path|systemroot|windir|temp|tmp|userprofile|home|homedrive|homepath|appdata|localappdata|programfiles(?:\(x86\))?|programdata|comspec|pathext|os|processor_architecture|number_of_processors|tz)$/i;
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)));
}

export function runProcess({ file, args = [], cwd, env = localEnvironment(), input = '', timeoutMs = 60000, shouldStop = () => false, onOutput = () => {}, maxBytes = 4 * 1024 * 1024 }) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', bytes = 0, reason = null, timer, stopTimer, settled = false;
    const child = spawn(file === 'node' ? process.execPath : file, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    const finish = (exitCode, error = null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(stopTimer);
      resolve({ exitCode, stdout, stderr, reason, error, ok: exitCode === 0 && !reason && !error });
    };
    const stop = why => {
      if (reason || settled) return;
      reason = why;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    for (const [stream, isError] of [[child.stdout,false],[child.stderr,true]]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) { stop('output_limit'); return; }
        const value = chunk.toString('utf8');
        if (isError) stderr += value; else stdout += value;
        onOutput();
      });
    }
    child.on('error', err => finish(null, err.message));
    child.on('close', code => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    stopTimer = setInterval(() => { if (shouldStop()) stop('stopped'); }, 250);
  });
}

export function writeEvidence(directory, name, result) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, redactText(JSON.stringify(result, null, 2)) + '\n');
  return file;
}
