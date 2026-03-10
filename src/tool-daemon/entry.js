// Standalone entrypoint for the Tool Daemon (ESM).
// Reads env ARCANA_TOOL_DAEMON_WORKSPACE_ROOT and ARCANA_TOOL_DAEMON_PORT
// then starts the HTTP daemon. Keeps the process alive until terminated.

import { startToolDaemon } from "./server.js";

function installFatalHandlers(){
  function printAndExit(label, err){
    try {
      const msg = label + ": " + (err && err.stack ? err.stack : String(err)) + "\n";
      process.stderr.write(msg);
    } catch {}
    try { process.exit(1); } catch { try { process.exitCode = 1; } catch {} }
  }

  process.on("uncaughtException", function(err){
    printAndExit("uncaughtException", err);
  });

  process.on("unhandledRejection", function(reason){
    printAndExit("unhandledRejection", reason);
  });
}

async function main(){
  installFatalHandlers();
  const workspaceRoot = String(process.env.ARCANA_TOOL_DAEMON_WORKSPACE_ROOT || process.cwd());
  const portEnv = Number(process.env.ARCANA_TOOL_DAEMON_PORT || 0);
  const port = (Number.isFinite(portEnv) && portEnv > 0) ? portEnv : undefined;
  try {
    // Start the daemon. It writes state.json on its own.
    await startToolDaemon({ workspaceRoot, port });
  } catch (err) {
    // If the address is already in use, exit with a non-zero code so
    // the parent can treat it as already running.
    const code = err && typeof err === "object" ? err.code : undefined;
    if (code === "EADDRINUSE") { process.exitCode = 0; return; }
    process.exitCode = 1; throw err;
  }

  // Keep alive. Node will keep running due to the HTTP server, but install
  // signal handlers for a clean shutdown in managed environments.
  process.on("SIGTERM", function(){ try { process.exit(0); } catch {} });
  process.on("SIGINT", function(){ try { process.exit(0); } catch {} });
}

main();
