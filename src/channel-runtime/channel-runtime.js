// Channel ingress runtime (OpenClaw-style): dedupe + pending buffer + queueing + prompt envelope.
//
// Design goals:
// - Centralize message handling policy so each channel adapter only normalizes events.
// - Keep this module dependency-free and portable (usable from skills/* scripts).
// - Avoid reading env vars here; adapters may map env/config into options.

import { setTimeout as delay } from "node:timers/promises";

function clampInt(n, lo, hi, dflt) {
  const v = Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}

function cleanText(s) {
  return String(s || "").replace(/\r\n/g, "\n").trim();
}

function safeLower(s) {
  try { return String(s || "").toLowerCase(); } catch { return ""; }
}

export function stripLeadingDirectiveLines(text, directiveNames = []) {
  const set = new Set((directiveNames || []).map((s) => safeLower(s)).filter(Boolean));
  if (!set.size) return cleanText(text);

  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = String(lines[i] || "").trim();
    if (i === 0 && trimmed.startsWith("/")) {
      const m = trimmed.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)\b/);
      const name = m ? safeLower(m[1]) : "";
      if (name && set.has(name)) continue;
    }
    out.push(lines[i]);
  }
  return cleanText(out.join("\n"));
}

export function parseSlashCommand(text) {
  const t = cleanText(text);
  if (!t.startsWith("/")) return null;
  const first = t.split(/\n/, 1)[0];
  const m = first.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/);
  if (!m) return null;
  const cmd = safeLower(m[1] || "");
  const rest = String(m[2] || "").trim();
  const args = rest ? rest.split(/\s+/) : [];
  return { cmd, args, raw: first };
}

export function defaultLooksUrgentForSteer(text) {
  const raw = String(text || "");
  const t = raw.toLowerCase();
  if (!t) return false;
  if (/\b(stop|cancel|ignore|wait|hold on)\b/.test(t)) return true;
  if (/纠正|更正|不对|错了|停一下|先别|取消/.test(raw)) return true;
  return false;
}

function formatSenderLabelDefault(msg) {
  const name = msg?.senderName ? String(msg.senderName) : "";
  const id = msg?.senderId ? String(msg.senderId) : "";
  if (name && id) return name + "(" + id + ")";
  return name || id || "sender";
}

export function buildDefaultPromptEnvelope({ channel, msg, bufferedLines, batch, formatSenderLabel }) {
  const lines = [];
  lines.push("[Channel Context]");
  if (channel) lines.push("channel=" + String(channel));
  lines.push("conversation=" + (msg?.isGroup ? "group" : "dm"));
  if (msg?.chatId) lines.push("chat_id=" + String(msg.chatId));
  if (msg?.threadId) lines.push("thread_id=" + String(msg.threadId));
  if (msg?.messageId) lines.push("msg_id=" + String(msg.messageId));
  const sl = formatSenderLabel ? formatSenderLabel(msg) : formatSenderLabelDefault(msg);
  if (sl) lines.push("sender=" + sl);
  if (typeof msg?.mentionMe === "boolean") lines.push("mention_me=" + String(msg.mentionMe));
  if (msg?.ts) lines.push("ts=" + String(msg.ts));
  lines.push("");

  if (bufferedLines && bufferedLines.length) {
    lines.push("[Buffered Messages - for context]");
    for (const l of bufferedLines) lines.push(String(l));
    lines.push("");
  }

  if (batch && batch.length > 1) {
    lines.push("[Queued Messages While You Were Busy - for context]");
    for (const e of batch) {
      const body = cleanText(e?.text);
      if (!body) continue;
      const lab = formatSenderLabel ? formatSenderLabel(e) : formatSenderLabelDefault(e);
      lines.push(lab + ": " + body);
    }
    lines.push("");
  }

  lines.push("[Current Question]");
  lines.push(cleanText(msg?.text));
  return lines.join("\n");
}

export class ChannelRuntime {
  constructor(opts = {}) {
    this.channel = String(opts.channel || "");

    this.directiveNames = Array.isArray(opts.directiveNames) && opts.directiveNames.length
      ? opts.directiveNames.map(String)
      : ["think", "verbose", "reasoning", "model", "queue", "elevated"];

    this.queueMode = String(opts.queueMode || "collect_followup").trim().toLowerCase();
    if (!["collect_followup", "off", "steer"].includes(this.queueMode)) this.queueMode = "collect_followup";

    this.debounceMs = clampInt(opts.debounceMs, 0, 30000, 1500);
    this.maxBatch = clampInt(opts.maxBatch, 1, 50, 20);
    this.maxDepth = clampInt(opts.maxDepth, 1, 200, 50);
    this.bufferLimit = clampInt(opts.bufferLimit, 0, 200, 20);

    this.requireMention = typeof opts.requireMention === "boolean" ? opts.requireMention : false;

    // Dedupe
    this.dedupeTtlMs = clampInt(opts.dedupeTtlMs, 0, 60 * 60 * 1000, 10 * 60 * 1000);
    this.dedupeMax = clampInt(opts.dedupeMax, 0, 50000, 5000);
    this._dedupe = new Map();

    // Hook points
    this.onLocalReply = typeof opts.onLocalReply === "function" ? opts.onLocalReply : async () => {};
    this.onExecuteTurn = typeof opts.onExecuteTurn === "function" ? opts.onExecuteTurn : null;
    this.onExecuteSteer = typeof opts.onExecuteSteer === "function" ? opts.onExecuteSteer : async () => {};
    this.onExecuteAbort = typeof opts.onExecuteAbort === "function" ? opts.onExecuteAbort : async () => {};
    this.log = typeof opts.log === "function" ? opts.log : () => {};

    if (!this.onExecuteTurn) throw new Error("ChannelRuntime requires opts.onExecuteTurn(msg, prompt, batch)");

    this.formatSenderLabel = typeof opts.formatSenderLabel === "function" ? opts.formatSenderLabel : formatSenderLabelDefault;

    this.looksUrgentForSteer = typeof opts.looksUrgentForSteer === "function" ? opts.looksUrgentForSteer : defaultLooksUrgentForSteer;

    this.buildPromptEnvelope = typeof opts.buildPromptEnvelope === "function"
      ? opts.buildPromptEnvelope
      : ({ msg, bufferedLines, batch }) => {
          return buildDefaultPromptEnvelope({ channel: this.channel, msg, bufferedLines, batch, formatSenderLabel: this.formatSenderLabel });
        };

    this.commands = new Map();
    const cmds = opts.commands && typeof opts.commands === "object" ? opts.commands : null;
    if (cmds) {
      for (const [k, v] of Object.entries(cmds)) {
        if (!k || typeof v !== "function") continue;
        this.commands.set(safeLower(k), v);
      }
    }

    this._sessions = new Map(); // sessionId -> state
  }

  _purgeDedupe() {
    const now = Date.now();
    for (const [k, exp] of this._dedupe) {
      if (typeof exp !== "number" || exp <= now) this._dedupe.delete(k);
    }
    if (this.dedupeMax > 0 && this._dedupe.size > this.dedupeMax) {
      const over = this._dedupe.size - this.dedupeMax;
      let i = 0;
      for (const k of this._dedupe.keys()) {
        this._dedupe.delete(k);
        i += 1;
        if (i >= over) break;
      }
    }
  }

  isDuplicateAndRemember(dedupeKey) {
    if (!this.dedupeTtlMs || this.dedupeTtlMs <= 0) return false;
    const key = String(dedupeKey || "");
    if (!key) return false;
    const now = Date.now();
    const exp = this._dedupe.get(key);
    if (typeof exp === "number" && exp > now) return true;
    this._purgeDedupe();
    this._dedupe.set(key, now + this.dedupeTtlMs);
    return false;
  }

  _state(sessionId) {
    const sid = String(sessionId || "");
    if (!sid) throw new Error("missing sessionId");
    let st = this._sessions.get(sid);
    if (!st) {
      st = { chain: Promise.resolve(), draining: false, queue: [], buffer: [], steerTarget: null };
      this._sessions.set(sid, st);
    }
    return st;
  }

  buffer(msg) {
    const m = { ...msg, text: cleanText(msg?.text) };
    const st = this._state(m.sessionId);
    if (!this.bufferLimit || this.bufferLimit <= 0) return;
    const body = cleanText(m.text);
    if (!body) return;
    st.buffer.push(this.formatSenderLabel(m) + ": " + body);
    while (st.buffer.length > this.bufferLimit) st.buffer.shift();
  }

  consumeReplyTarget(sessionId, defaultMsg) {
    const st = this._state(sessionId);
    const picked = st.steerTarget || null;
    st.steerTarget = null;
    return picked || defaultMsg;
  }

  _startDrain(sessionId) {
    const st = this._state(sessionId);
    if (st.draining) return;
    st.draining = true;
    st.chain = st.chain
      .then(() => this._drain(sessionId))
      .catch((err) => this.log("drain_failed", { sessionId, err: err?.message || String(err) }))
      .finally(() => {
        const st2 = this._state(sessionId);
        st2.draining = false;
        if (st2.queue.length > 0) this._startDrain(sessionId);
      });
  }

  async handleIncoming(msg) {
    const m0 = { ...msg };
    m0.sessionId = String(m0.sessionId || "");
    m0.text = cleanText(m0.text);
    if (!m0.sessionId) throw new Error("msg.sessionId is required");

    // Dedupe
    if (m0.dedupeKey && this.isDuplicateAndRemember(m0.dedupeKey)) {
      this.log("dedupe_skip", { channel: this.channel, dedupeKey: m0.dedupeKey });
      return { action: "dedupe" };
    }

    const st = this._state(m0.sessionId);

    // Slash commands (builtin /hey + custom)
    const cmd = parseSlashCommand(m0.text);
    let skipSteerForThisMessage = false;
    if (cmd && cmd.cmd === "hey") {
      // Force-abort current in-flight run (if any), then process this message as a normal turn
      if (st.draining) {
        try { await this.onExecuteAbort(m0, cmd); } catch (err) {
          this.log("abort_failed", { sessionId: m0.sessionId, err: err?.message || String(err) });
        }
      }

      // Strip only the '/hey' token from the first line; preserve the rest of that line + subsequent lines
      const lines = String(m0.text || "").split(/\r?\n/);
      if (lines.length > 0) {
        lines[0] = String(lines[0] || "").replace(/^\/(?:hey)\b\s*/i, "");
      }
      m0.text = cleanText(lines.join("\n"));

      // If the remaining message is empty after stripping, do nothing further
      if (!m0.text) return { action: "empty" };

      // Continue as a normal queued/off turn (NOT steer). If in-flight, drop any queued followups and keep only this.
      if (st.draining) {
        st.queue = [];
        st.steerTarget = null; // clear any prior steer target so reply goes to this message
      }
      skipSteerForThisMessage = true;

      // Fall through to directive stripping + normal handling below.
    } else if (cmd) {
      const handler = this.commands.get(cmd.cmd);
      if (handler) {
        await handler(m0, cmd);
        return { action: "command" };
      }
    }

    // Strip directives
    m0.text = stripLeadingDirectiveLines(m0.text, this.directiveNames);
    if (!m0.text) return { action: "empty" };

    // state already resolved above

    // Mention gating: buffer non-triggering group messages.
    if (m0.isGroup && this.requireMention && !m0.mentionMe) {
      this.buffer(m0);
      return { action: "buffered" };
    }

    // Steer: in steer mode, any message during in-flight is treated as steer (except /hey handled above)
    if (this.queueMode === "steer" && st.draining && !skipSteerForThisMessage) {
      st.steerTarget = m0;
      try { await this.onExecuteSteer(m0); } catch (err) {
        this.log("steer_failed", { sessionId: m0.sessionId, err: err?.message || String(err) });
      }
      return { action: "steer" };
    }

    if (this.queueMode === "off") {
      const buffered = st.buffer.slice(0);
      st.buffer = [];
      const prompt = this.buildPromptEnvelope({ msg: m0, bufferedLines: buffered, batch: [m0] });
      await this.onExecuteTurn(m0, prompt, [m0]);
      return { action: "ran" };
    }

    // collect_followup
    st.queue.push(m0);
    while (st.queue.length > this.maxDepth) st.queue.shift();
    this._startDrain(m0.sessionId);
    return { action: "queued" };
  }

  async _drain(sessionId) {
    const st = this._state(sessionId);
    for (;;) {
      if (st.queue.length === 0) return;
      if (this.debounceMs > 0) await delay(this.debounceMs);

      const batch = st.queue.splice(0, this.maxBatch);
      if (!batch.length) continue;
      const last = batch[batch.length - 1];

      const buffered = st.buffer.slice(0);
      st.buffer = [];

      const prompt = this.buildPromptEnvelope({ msg: last, bufferedLines: buffered, batch });
      await this.onExecuteTurn(last, prompt, batch);
    }
  }
}

export default ChannelRuntime;
