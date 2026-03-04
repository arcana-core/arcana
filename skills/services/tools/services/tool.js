// Services tool — manage core background services under ./services
// This tool calls the core services manager (src/services/manager.js).

import { wrapArcanaTool } from "../../../../src/tools/wrap-arcana-tool.js";
import { fileURLToPath } from "node:url";
import { getServicesStatus, reloadServices, startService, stopService, restartService } from "../../../../src/services/manager.js";

function createServicesTool(){
  const parameters = {
    type: "object",
    properties: {
      action: { type: "string", description: "status|reload|start|stop|restart" },
      id: { type: "string", nullable: true, description: "service id (filename without extension)" },
    },
    required: ["action"],
  };

  function formatStatus(st){
    const items = Array.isArray(st?.services) ? st.services : [];
    const parts = [];
    parts.push("[services] started=" + Boolean(st?.started) + " count=" + items.length);
    for (const s of items){
      const line = `- ${s.id}: ${s.status}` + (s.error ? (" (error: " + String(s.error).split("\n")[0] + ")") : "");
      parts.push(line);
    }
    return parts.join("\n");
  }

  return {
    name: "services",
    label: "Services",
    description: "Manage Arcana background services in ./services: status/reload/start/stop/restart.",
    parameters,
    async execute(_id, args){
      const action = String(args.action || "").toLowerCase().trim();
      const id = args.id ? String(args.id).trim() : "";

      try {
        if (!action || action === "status"){
          const st = getServicesStatus();
          return { content:[{ type:"text", text: formatStatus(st) }], details: { ok:true, ...st } };
        }

        if (action === "reload"){
          const st = await reloadServices();
          return { content:[{ type:"text", text: "[services] reloaded\n" + formatStatus(st) }], details: { ok:true, ...st } };
        }

        if (action === "start"){
          if (!id) return { content:[{ type:"text", text: "id required" }], details:{ ok:false, error:"id_required" } };
          const st = await startService({ id });
          return { content:[{ type:"text", text: "[services] started id=" + id + "\n" + formatStatus(st) }], details:{ ok:true, ...st } };
        }

        if (action === "stop"){
          if (!id) return { content:[{ type:"text", text: "id required" }], details:{ ok:false, error:"id_required" } };
          const st = await stopService({ id, reason: "tool" });
          return { content:[{ type:"text", text: "[services] stop requested id=" + id + "\n" + formatStatus(st) }], details:{ ok:true, ...st } };
        }

        if (action === "restart"){
          if (!id) return { content:[{ type:"text", text: "id required" }], details:{ ok:false, error:"id_required" } };
          const st = await restartService({ id });
          return { content:[{ type:"text", text: "[services] restarted id=" + id + "\n" + formatStatus(st) }], details:{ ok:true, ...st } };
        }

        return { content:[{ type:"text", text: "unknown action" }], details:{ ok:false, error:"unknown_action" } };
      } catch (e){
        const msg = e?.message || String(e);
        return { content:[{ type:"text", text: "[services] failed: " + msg }], details:{ ok:false, error: msg } };
      }
    }
  };
}

export default function(){
  const skillDir = fileURLToPath(new URL("../..", import.meta.url));
  return wrapArcanaTool(createServicesTool, {
    skillDir,
    defaultSafety: { allowNetwork: false, allowWrite: false }
  });
}
