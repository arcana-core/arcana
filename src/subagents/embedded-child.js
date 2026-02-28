import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { resolveWorkspaceRoot } from '../workspace-guard.js';
import createCodexSubagentTool from '../tools-codex-subagent.js';

const initRaw = process.env.SUBAGENT_INIT || '{}';
let init = {};
try { init = JSON.parse(initRaw); } catch {}
const codexTool = createCodexSubagentTool();

function writeEvent(ev){
  try { output.write(JSON.stringify(ev)+'\n'); } catch {}
}

writeEvent({ type:'child_start', runId: init.runId, childSessionKey: init.childSessionKey, task: init.task, label: init.label, cwd: resolveWorkspaceRoot() });

const rl = readline.createInterface({ input });
rl.on('line', async (line)=>{
  let msg = null;
  try { msg = JSON.parse(line); } catch {}
  if (!msg) return;
  if (msg.op === 'message'){
    const args = { task: init.task || 'continue', plan: msg.message || '', allowedPaths: init.allowedPaths || [], dryRun: false, sessionLabel: init.childSessionKey };
    try {
      const res = await codexTool.execute('child', args);
      writeEvent({ type:'tool_result', tool:'codex', ok:true, details: res.details });
    } catch (e){ writeEvent({ type:'tool_result', tool:'codex', ok:false, error: String(e && e.message || e) }); }
  }
});

process.on('SIGTERM', ()=>{ try{ rl.close(); }catch{} process.exit(0); });
