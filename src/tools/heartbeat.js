import { Type } from '@sinclair/typebox';
import { getContext } from '../event-bus.js';
import { runHeartbeatOnce } from '../heartbeat/run-once.js';
import { loadHeartbeatConfigForAgent, patchHeartbeatConfigForAgent } from '../heartbeat/config.js';
import { requestHeartbeatNow } from '../heartbeat/wake.js';
import { peekSystemEvents } from '../system-events/store.js';

export function createHeartbeatTool() {
  const Params = Type.Object({
    action: Type.String({ description: 'status|enable|disable|request_now|run_once' }),
    sessionId: Type.Optional(Type.String({ description: 'Override session key (defaults to current context session id)' })),
    reason: Type.Optional(Type.String({ description: 'Reason for request_now or run_once' })),
  });

  function resolveHeartbeatContext(args) {
    try {
      const ctx = getContext?.();
      const agentId = ctx && ctx.agentId ? String(ctx.agentId) : 'default';
      const sessionIdFromArgs = args && args.sessionId ? String(args.sessionId) : '';
      const sessionIdCtx = ctx && ctx.sessionId ? String(ctx.sessionId) : '';
      const sessionId = sessionIdFromArgs || sessionIdCtx || '';
      const workspaceRoot = ctx && ctx.workspaceRoot ? String(ctx.workspaceRoot) : undefined;
      return { agentId, sessionId, workspaceRoot };
    } catch {
      return { agentId: 'default', sessionId: '', workspaceRoot: undefined };
    }
  }

  return {
    label: 'Heartbeat',
    name: 'heartbeat',
    description: 'Manage heartbeat config, wake requests, and ad-hoc runs.',
    parameters: Params,
    async execute(_id, args) {
      const action = String(args.action || '').trim().toLowerCase();
      const ctx = resolveHeartbeatContext(args);
      const agentId = ctx.agentId;
      const sessionId = ctx.sessionId;
      const workspaceRoot = ctx.workspaceRoot;

      if (action === 'status') {
        let config = null;
        try {
          config = await loadHeartbeatConfigForAgent(agentId);
        } catch {
          config = null;
        }

        const enabled = !!(config && config.enabled !== false);
        const everyRaw = config && Object.prototype.hasOwnProperty.call(config, 'every') ? config.every : undefined;
        const every = everyRaw != null ? String(everyRaw) : '';
        const activeHours = typeof (config && config.activeHours) === 'string' ? config.activeHours : '';
        const targetSessionId = typeof (config && config.targetSessionId) === 'string' ? config.targetSessionId : '';

        let pendingEvents = 0;
        if (sessionId) {
          try {
            const events = await peekSystemEvents({ agentId, sessionKey: sessionId, limit: 20 });
            if (Array.isArray(events)) pendingEvents = events.length;
          } catch {
            pendingEvents = 0;
          }
        }

        const parts = [];
        parts.push('agent=' + agentId);
        parts.push('enabled=' + (enabled ? 'true' : 'false'));
        if (every) parts.push('every=' + every);
        if (activeHours) parts.push('activeHours=' + activeHours);
        if (targetSessionId) parts.push('targetSessionId=' + targetSessionId);
        if (sessionId) parts.push('session=' + sessionId);
        if (sessionId) parts.push('pendingEvents=' + pendingEvents);

        const text = 'heartbeat status: ' + parts.join(' ');

        return {
          content: [{ type: 'text', text }],
          details: {
            ok: true,
            agentId,
            sessionId: sessionId || null,
            enabled,
            every: every || null,
            activeHours: activeHours || null,
            targetSessionId: targetSessionId || null,
            pendingEvents,
            config: config || null,
          },
        };
      }

      if (action === 'enable' || action === 'disable') {
        const enabled = action === 'enable';
        const patch = { enabled };
        if (sessionId) {
          patch.targetSessionId = sessionId;
        }

        try {
          const config = await patchHeartbeatConfigForAgent(agentId, patch);
          const text = 'heartbeat ' + (enabled ? 'enabled' : 'disabled') + ' agent=' + agentId + (sessionId ? ' session=' + sessionId : '');
          return {
            content: [{ type: 'text', text }],
            details: {
              ok: true,
              agentId,
              sessionId: sessionId || null,
              config: config || null,
            },
          };
        } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          return {
            content: [{ type: 'text', text: (enabled ? 'enable' : 'disable') + ' failed: ' + msg }],
            details: { ok: false, error: msg },
          };
        }
      }

      if (action === 'request_now') {
        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason : undefined;
        try {
          requestHeartbeatNow({ reason, agentId, sessionKey: sessionId || undefined });
          const text = 'heartbeat wake requested: agent=' + agentId + (sessionId ? ' sessionKey=' + sessionId : '');
          return {
            content: [{ type: 'text', text }],
            details: {
              ok: true,
              agentId,
              sessionId: sessionId || null,
              reason: reason || null,
            },
          };
        } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          return {
            content: [{ type: 'text', text: 'request_now failed: ' + msg }],
            details: { ok: false, error: msg },
          };
        }
      }

      if (action === 'run_once') {
        if (!sessionId) {
          return {
            content: [{ type: 'text', text: 'run_once requires sessionId (args.sessionId or current session)' }],
            details: { ok: false, error: 'missing_session' },
          };
        }
        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason : 'tool_run_once';
        try {
          const res = await runHeartbeatOnce({ agentId, sessionId, reason, workspaceRoot });
          const status = res && res.status ? String(res.status) : 'unknown';
          const delivered = !!(res && res.delivered);
          const deliveredText = delivered ? ' delivered=true' : ' delivered=false';
          const reasonText = res && res.reason ? ' reason=' + res.reason : '';
          const text = 'heartbeat run_once: status=' + status + deliveredText + reasonText;
          return { content: [{ type: 'text', text }], details: { ok: status === 'ok', result: res } };
        } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          return { content: [{ type: 'text', text: 'run_once failed: ' + msg }], details: { ok: false, error: msg } };
        }
      }

      const valid = 'status|enable|disable|request_now|run_once';
      return {
        content: [{ type: 'text', text: 'unknown action: ' + action + ' (valid: ' + valid + ')' }],
        details: { ok: false, error: 'unknown_action', action },
      };
    },
  };
}
