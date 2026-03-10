import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteStream } from "node:fs";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

function truncateTail(content){
  const maxLines = DEFAULT_MAX_LINES;
  const maxBytes = DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes){
    return { content, truncated:false, truncatedBy:null, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes, lastLinePartial:false };
  }
  const out = []; let bytes = 0; let truncatedBy = "lines"; let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--){
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes){
      truncatedBy = "bytes";
      if (out.length === 0){
        const buf = Buffer.from(line, "utf-8");
        let start = Math.max(0, buf.length - maxBytes);
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
        const slice = buf.slice(start);
        out.unshift(slice.toString("utf-8"));
        bytes = slice.length; lastLinePartial = true;
      }
      break;
    }
    out.unshift(line); bytes += lineBytes;
  }
  return { content: out.join("\n"), truncated:true, truncatedBy, totalLines, totalBytes, outputLines: out.length, outputBytes: bytes, lastLinePartial };
}

export async function runBash({ command, timeoutSec }){
  const shell = process.env.SHELL || "bash";
  const isBashLike = /bash|zsh|fish|sh/.test(String(shell||""));
  const args = isBashLike ? ["-lc", command] : ["-c", command];

  const tempPath = join(tmpdir(), "arcana-bash-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".log");
  const temp = createWriteStream(tempPath);
  let timedOut = false;

  const child = spawn(shell, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore","pipe","pipe"],
    detached: true,
  });

  let chunksBytes = 0; const chunks = []; const maxChunksBytes = DEFAULT_MAX_BYTES * 2;
  const onData = function(buf){ try { temp.write(buf); } catch {} chunks.push(buf); chunksBytes += buf.length; while (chunksBytes > maxChunksBytes && chunks.length > 1){ const x = chunks.shift(); chunksBytes -= x.length; } };
  child.stdout?.on("data", onData); child.stderr?.on("data", onData);

  let timeoutHandle = null;
  const t = Number(timeoutSec || 0);
  if (t > 0){ timeoutHandle = setTimeout(function(){ timedOut = true; try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }, t * 1000); }

  const result = await new Promise(function(resolve){
    child.on("error", function(err){ try { if (timeoutHandle) clearTimeout(timeoutHandle); } catch {} try { temp.end(); } catch {} resolve({ ok:false, error: String(err && err.message ? err.message : err) }); });
    child.on("close", function(code){ try { if (timeoutHandle) clearTimeout(timeoutHandle); } catch {} try { temp.end(); } catch {}
      const text = Buffer.concat(chunks).toString("utf-8");
      const trunc = truncateTail(text);
      let outText = trunc.content || "(no output)";
      if (trunc.truncated){
        const startLine = trunc.totalLines - trunc.outputLines + 1;
        const endLine = trunc.totalLines;
        if (trunc.lastLinePartial){ outText += "\n\n[Showing last " + trunc.outputBytes + " of line " + endLine + ". Full output: " + tempPath + "]"; }
        else if (trunc.truncatedBy === "lines"){ outText += "\n\n[Showing lines " + startLine + "-" + endLine + " of " + trunc.totalLines + ". Full output: " + tempPath + "]"; }
        else { outText += "\n\n[Showing lines " + startLine + "-" + endLine + " of " + trunc.totalLines + " (50KB limit). Full output: " + tempPath + "]"; }
      }
      if (timedOut){ outText += "\n\nCommand timed out after " + t + "s"; resolve({ ok:false, timeout:true, text: outText, path: tempPath }); return; }
      if (code !== 0 && code !== null){ outText += "\n\nCommand exited with code " + code; resolve({ ok:false, code, text: outText, path: tempPath }); return; }
      resolve({ ok:true, text: outText, path: tempPath });
    });
  });

  return result;
}

export default { runBash };

