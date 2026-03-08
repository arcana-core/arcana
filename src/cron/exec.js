import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

function tailLines(text, max=100){
  const lines = String(text||'').split('\n');
  return lines.slice(Math.max(0, lines.length - max)).join('\n');
}

export async function runExecTask({ command, logPath, cwd }){
  const startedAtMs = Date.now();
  return new Promise((resolve)=>{
    const shell = process.env.SHELL || 'bash';
    const isBashLike = /bash|zsh|fish|sh/.test(shell);
    const args = isBashLike ? ['-lc', command] : ['-c', command];
    const out = createWriteStream(logPath, { flags: 'w' });
    const child = spawn(shell, args, { cwd: cwd || process.cwd(), env: process.env, stdio: ['ignore','pipe','pipe'] });
    let buf = '';
    const onData = (b)=>{ try { out.write(b); } catch{} buf += b.toString('utf-8'); if (buf.length > 256*1024) buf = buf.slice(-256*1024); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err)=>{ try{out.end();}catch{} resolve({ ok:false, error: String(err?.message||err), startedAtMs, finishedAtMs: Date.now(), outputTail: tailLines(buf) }); });
    child.on('close', (code)=>{ try{out.end();}catch{} const ok = (code === 0); resolve({ ok, code, startedAtMs, finishedAtMs: Date.now(), outputTail: tailLines(buf) }); });
  });
}

export default { runExecTask };
