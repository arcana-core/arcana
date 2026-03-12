import crypto from "node:crypto";

export function normalizeProxySpec(spec){
  var raw = "";
  if (spec !== undefined && spec !== null){
    raw = String(spec);
  }
  raw = String(raw || "").trim();
  if (!raw) return { mode: "system", key: "system" };

  var lower = raw.toLowerCase();
  if (lower === "system" || lower === "default") return { mode: "system", key: "system" };
  if (lower === "none" || lower === "off" || lower === "direct" || lower === "no") return { mode: "none", key: "none" };

  var hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 10);
  return { mode: "custom", server: raw, key: "custom_" + hash };
}

export default { normalizeProxySpec };

