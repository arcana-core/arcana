import { nowMs } from '../util.js';

export function createPolicyEngine({ trace, denyByDefaultDangerous = false } = {}){
  function isDangerousOutput(output){
    try {
      if (!output || typeof output !== 'object') return false;
      const kind = String(output.kind || '').toLowerCase();
      if (kind === 'system_command' || kind === 'shell_command' || kind === 'tool_invocation') return true;
    } catch {}
    return false;
  }

  async function evaluateDelivery({ agentId, sessionKey, output, runnerId, reason } = {}){
    const aId = agentId || 'default';
    const sKey = sessionKey || 'session';
    const dangerous = isDangerousOutput(output);

    let allow = true;
    let decisionReason = 'allow_default';

    if (dangerous && denyByDefaultDangerous){
      allow = false;
      decisionReason = 'deny_dangerous_default';
    }

    const tsMs = nowMs();
    const decision = {
      allow,
      dangerous,
      reason: decisionReason,
      tsMs,
    };

    if (trace && typeof trace.emitSpan === 'function'){
      try {
        await trace.emitSpan({
          name: 'policy.decision',
          attributes: {
            agentId: aId,
            sessionKey: sKey,
            runnerId: runnerId || null,
            outputKind: output && output.kind,
            allow,
            reason: decisionReason,
            dangerous,
          },
        });
      } catch {}
    }

    return decision;
  }

  return { evaluateDelivery };
}

export default { createPolicyEngine };

