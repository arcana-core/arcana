import { startChromeMcpDaemon } from "./server.js";

function installFatalHandlers(){
  function printAndExit(label, err){
    try {
      const msg = label + ": " + (err && err.stack ? err.stack : String(err)) + "\n";
      process.stderr.write(msg);
    } catch {}
    try { process.exit(1); } catch { try { process.exitCode = 1; } catch {} }
  }

  process.on("uncaughtException", function(err){ printAndExit("uncaughtException", err); });
  process.on("unhandledRejection", function(reason){ printAndExit("unhandledRejection", reason); });
}

async function main(){
  installFatalHandlers();
  const workspaceRoot = String(process.env.ARCANA_CHROME_MCP_DAEMON_WORKSPACE_ROOT || process.cwd());
  const portEnv = Number(process.env.ARCANA_CHROME_MCP_DAEMON_PORT || 0);
  const port = (Number.isFinite(portEnv) && portEnv > 0) ? portEnv : undefined;
  await startChromeMcpDaemon({ workspaceRoot, port });
  process.on("SIGTERM", function(){ try { process.exit(0); } catch {} });
  process.on("SIGINT", function(){ try { process.exit(0); } catch {} });
}

main();
