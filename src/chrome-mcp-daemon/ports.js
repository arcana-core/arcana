import { createHash } from "node:crypto";

export function hashToPort(input){
  // Deterministic unprivileged port: sha256(input) mapped to [44100,44999].
  const h = createHash("sha256").update(String(input||""), "utf8").digest();
  const n = (h[2] << 8) | h[3];
  const base = 44100; const span = 900;
  return base + (n % span);
}

export default { hashToPort };
