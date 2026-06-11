import { join } from 'node:path';

import { arcanaHomePath } from '../../arcana-home.js';
import { runArcanaTask } from '../../cron/arcana-task.js';
import { ensureDir, nowMs, safeJsonParse } from '../util.js';

const WAKE_AGENT_PROMPT = `
You are a wake decision helper for Arcana agents.
Given the result of the latest turn and a compact summary,
you decide whether to schedule another wake or to stop.

Rules:
1) Output strict JSON only. No markdown, no commentary.
2) Return exactly: {"action":"wake_later"|"stop","delayMs":number,"reason":string}
3) Prefer stop for permanent errors, active cooldowns, or exhausted retry budgets.
4) Use short reasons. delayMs must be 0 for stop and positive for wake_later.
5) Never ask questions.
`;

const PERMANENT_ERROR_PATTERNS = [
  /invalid credentials?/i,
  /invalid api key/i,
  /api key/i,
  /\bno account\b/i,
  /authentication/i,
  /\bforbidden\b/i,
  /permission denied/i,
  /not configured/i,
  /unauthorized/i,
  /access denied/i,
];

const CONCURRENCY_LIMIT_ERROR_PATTERNS = [
  /concurrency limit exceeded/i,
  /too many concurrent/i,
  /concurrent requests?/i,
  /rate limit.*concurr/i,
  /\b429\b.*concurr/i,
];

const CONCURRENCY_RETRY_DELAY_MS = 30 * 1000;
const CONCURRENCY_MAX_RETRIES = 5;

function normalizeErrorMessage(value){
  try {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value.message === 'string' && value.message.trim()) return value.message.trim();
    if (value && typeof value.code === 'string' && value.code.trim()) return value.code.trim();
    if (value != null) {
      const s = String(value).trim();
      if (s) return s;
    }
  } catch {}
  return '';
}

function summarizeRunResult(runResult){
  try {
    return {
      ok: !!(runResult && runResult.ok),
      skipped: !!(runResult && runResult.skipped),
      ran: !(runResult && Object.prototype.hasOwnProperty.call(runResult, 'ran')) || !!runResult.ran,
      completed: !!(runResult && runResult.completed),
      kind: runResult && runResult.kind ? String(runResult.kind) : '',
      hasOutput: !!(runResult && runResult.hasOutput),
      retryCount: Number(runResult && runResult.retryCount || 0) || 0,
      maxRetries: Number(runResult && runResult.maxRetries || 0) || 0,
      attemptsInWindow: Number(runResult && runResult.attemptsInWindow || 0) || 0,
      maxAttemptsInWindow: Number(runResult && runResult.maxAttemptsInWindow || 0) || 0,
      cooldownUntilMs: Number(runResult && runResult.cooldownUntilMs || 0) || 0,
      nowMs: Number(runResult && runResult.nowMs || 0) || 0,
      runnerSuggestedDelayMs: Number(runResult && runResult.runnerSuggestedDelayMs || 0) || 0,
      baseNextDelayMs: Number(runResult && runResult.baseNextDelayMs || 0) || 0,
      errorMessage: normalizeErrorMessage(runResult && (runResult.errorMessage || runResult.error)),
      errorStack: typeof (runResult && runResult.errorStack) === 'string'
        ? String(runResult.errorStack).slice(0, 800)
        : '',
    };
  } catch {
    return {};
  }
}

function buildRunResultSummary(runResult) {
  try {
    const summaryInput = summarizeRunResult(runResult);
    const parts = [];
    const ok = !!summaryInput.ok;
    const skipped = !!summaryInput.skipped;

    parts.push(`Status: ${ok ? 'ok' : (skipped ? 'skipped' : 'error')}.`);
    if (Object.prototype.hasOwnProperty.call(summaryInput, 'completed')) parts.push(`Completed: ${summaryInput.completed ? 'yes' : 'no'}.`);
    if (summaryInput.kind) parts.push(`Kind: ${summaryInput.kind}.`);
    if (summaryInput.maxRetries > 0) parts.push(`Retry: ${summaryInput.retryCount}/${summaryInput.maxRetries}.`);
    if (summaryInput.maxAttemptsInWindow > 0) parts.push(`Attempts: ${summaryInput.attemptsInWindow}/${summaryInput.maxAttemptsInWindow}.`);
    if (summaryInput.cooldownUntilMs > summaryInput.nowMs && summaryInput.cooldownUntilMs > 0) {
      parts.push(`CooldownUntilMs: ${summaryInput.cooldownUntilMs}.`);
    }
    if (summaryInput.runnerSuggestedDelayMs > 0) parts.push(`RunnerSuggestedDelayMs: ${summaryInput.runnerSuggestedDelayMs}.`);
    if (summaryInput.baseNextDelayMs > 0) parts.push(`BaseNextDelayMs: ${summaryInput.baseNextDelayMs}.`);
    if (summaryInput.errorMessage) {
      const s = summaryInput.errorMessage.length > 160 ? (summaryInput.errorMessage.slice(0, 157) + '...') : summaryInput.errorMessage;
      parts.push(`Error: ${s}`);
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

function makeDecision(action, delayMs, reason, extra = {}){
  const normalizedAction = action === 'wake_later' ? 'wake_later' : 'stop';
  const normalizedDelayMs = normalizedAction === 'wake_later'
    ? Math.max(1, Math.floor(Number(delayMs) || 0))
    : 0;
  return {
    action: normalizedAction,
    delayMs: normalizedDelayMs,
    reason: reason || '',
    source: extra.source || 'rules',
    shouldCooldown: !!extra.shouldCooldown,
  };
}

function isPermanentError(message){
  const text = normalizeErrorMessage(message);
  if (!text) return false;
  return PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function isConcurrencyLimitError(message){
  const text = normalizeErrorMessage(message);
  if (!text) return false;
  return CONCURRENCY_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function decideConcurrencyRetry(runResult, summary){
  const ok = !!(runResult && runResult.ok);
  if (ok) return null;
  const kind = runResult && runResult.kind ? String(runResult.kind) : 'model_error';
  if (kind !== 'model_error') return null;
  const errorMessage = normalizeErrorMessage(runResult && runResult.errorMessage);
  if (!isConcurrencyLimitError(errorMessage)) return null;
  const retryCount = Number(runResult && runResult.retryCount || 0) || 0;
  if (retryCount > CONCURRENCY_MAX_RETRIES){
    return makeDecision(
      'stop',
      0,
      'concurrency_max_retries_reached' + (summary ? ': ' + summary : ''),
      { source: 'rules', shouldCooldown: true },
    );
  }
  return makeDecision(
    'wake_later',
    CONCURRENCY_RETRY_DELAY_MS,
    'concurrency_retry_' + String(retryCount) + '_of_' + String(CONCURRENCY_MAX_RETRIES) + (summary ? ': ' + summary : ''),
    { source: 'rules' },
  );
}

function computeRetryDelayMs(runResult){
  const retryCount = Number(runResult && runResult.retryCount || 0) || 0;
  const runnerSuggestedDelayMs = Number(runResult && runResult.runnerSuggestedDelayMs || 0) || 0;
  const baseNextDelayMs = Number(runResult && runResult.baseNextDelayMs || 0) || 0;
  const base = runnerSuggestedDelayMs > 0 ? runnerSuggestedDelayMs : (baseNextDelayMs > 0 ? baseNextDelayMs : 5000);
  const factor = Math.min(8, Math.max(1, Math.pow(2, Math.max(0, retryCount - 1))));
  return Math.max(base, Math.floor(base * factor));
}

function computeNoOutputDelayMs(runResult){
  const runnerSuggestedDelayMs = Number(runResult && runResult.runnerSuggestedDelayMs || 0) || 0;
  const baseNextDelayMs = Number(runResult && runResult.baseNextDelayMs || 0) || 0;
  if (runnerSuggestedDelayMs > 0) return Math.floor(runnerSuggestedDelayMs);
  return Math.max(baseNextDelayMs, 15000);
}

function ruleStopIfBlocked(runResult, summary){
  const now = Number(runResult && runResult.nowMs || 0) || nowMs();
  const cooldownUntilMs = Number(runResult && runResult.cooldownUntilMs || 0) || 0;
  const retryCount = Number(runResult && runResult.retryCount || 0) || 0;
  const maxRetries = Number(runResult && runResult.maxRetries || 0) || 0;
  const attemptsInWindow = Number(runResult && runResult.attemptsInWindow || 0) || 0;
  const maxAttemptsInWindow = Number(runResult && runResult.maxAttemptsInWindow || 0) || 0;
  const errorMessage = normalizeErrorMessage(runResult && runResult.errorMessage);

  if (cooldownUntilMs > now){
    return makeDecision('stop', 0, 'cooldown_active' + (summary ? ': ' + summary : ''), { source: 'rules' });
  }

  if (maxRetries > 0 && retryCount >= maxRetries){
    return makeDecision('stop', 0, 'max_retries_reached' + (summary ? ': ' + summary : ''), { source: 'rules', shouldCooldown: true });
  }

  if (maxAttemptsInWindow > 0 && attemptsInWindow >= maxAttemptsInWindow){
    return makeDecision('stop', 0, 'max_attempts_window_reached' + (summary ? ': ' + summary : ''), { source: 'rules', shouldCooldown: true });
  }

  if (isPermanentError(errorMessage)){
    return makeDecision('stop', 0, 'permanent_error' + (summary ? ': ' + summary : ''), { source: 'rules', shouldCooldown: true });
  }

  return null;
}

function decideWake(runResult) {
  const summary = buildRunResultSummary(runResult);
  const blockedDecision = ruleStopIfBlocked(runResult, summary);
  if (blockedDecision) return blockedDecision;
  const concurrencyDecision = decideConcurrencyRetry(runResult, summary);
  if (concurrencyDecision) return concurrencyDecision;

  if (!runResult) {
    return makeDecision('stop', 0, summary || 'no_summary', { source: 'rules' });
  }

  const ok = !!runResult.ok;
  const completed = !!runResult.completed;
  const hasOutput = !!runResult.hasOutput;
  const kind = runResult.kind || (ok ? (hasOutput ? 'normal' : 'no_output') : 'model_error');

  if (ok && hasOutput) {
    return makeDecision('stop', 0, 'turn_ok_with_output' + (summary ? ': ' + summary : ''), { source: 'rules' });
  }

  if (!completed) {
    return makeDecision('stop', 0, 'turn_incomplete_transport_retry_owned_elsewhere' + (summary ? ': ' + summary : ''), { source: 'rules' });
  }

  if (!ok && kind === 'model_error') {
    return makeDecision('stop', 0, 'completed_error_no_wake_recovery' + (summary ? ': ' + summary : ''), { source: 'rules' });
  }

  if (ok && !hasOutput && kind === 'no_output') {
    return makeDecision('wake_later', computeNoOutputDelayMs(runResult), 'no_output_follow_up' + (summary ? ': ' + summary : ''), { source: 'rules' });
  }

  return makeDecision('stop', 0, 'no_recovery_needed' + (summary ? ': ' + summary : ''), { source: 'rules' });
}

function buildWakeAgentPrompt(runResult, options = {}){
  const blockedDecision = options && options.blockedDecision ? options.blockedDecision : null;
  const payload = {
    summary: buildRunResultSummary(runResult),
    input: summarizeRunResult(runResult),
    constraints: blockedDecision ? {
      blocked: true,
      forcedAction: blockedDecision.action || 'stop',
      reason: blockedDecision.reason || '',
    } : { blocked: false },
  };
  return [
    WAKE_AGENT_PROMPT.trim(),
    '',
    'Input JSON:',
    JSON.stringify(payload),
    '',
    'Return strict JSON only.',
  ].join('\n');
}

function validateDecision(raw){
  const obj = raw && typeof raw === 'object' ? raw : null;
  if (!obj) return null;

  const action = typeof obj.action === 'string' ? obj.action.trim() : '';
  if (action !== 'stop' && action !== 'wake_later') return null;

  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  const delayNum = Number(obj.delayMs);
  const delayMs = action === 'wake_later'
    ? Math.max(1, Math.floor(Number.isFinite(delayNum) ? delayNum : 0))
    : 0;

  if (action === 'wake_later' && delayMs <= 0) return null;

  return {
    action,
    delayMs,
    reason: reason || '',
  };
}

async function decideWakeLLM(runResult, options = {}){
  const fallback = decideWake(runResult);
  if (runResult && runResult.ok && runResult.hasOutput){
    return fallback;
  }
  const blockedDecision = ruleStopIfBlocked(runResult, buildRunResultSummary(runResult));
  const concurrencyDecision = decideConcurrencyRetry(runResult, buildRunResultSummary(runResult));
  if (concurrencyDecision){
    return concurrencyDecision;
  }
  const agentId = options && options.agentId ? String(options.agentId) : 'default';
  const sessionKey = options && options.sessionKey ? String(options.sessionKey) : 'session';
  const timeoutMs = Number(options && options.timeoutMs || 0) || 0;

  try {
    const logDir = await ensureDir(arcanaHomePath('gateway-v2', 'logs', 'wake-agent'));
    const logPath = join(logDir, agentId + '__' + sessionKey.replace(/[^A-Za-z0-9_-]/g, '_') + '__' + String(nowMs()) + '.log');
    const prompt = buildWakeAgentPrompt(runResult, { blockedDecision });
    const result = await runArcanaTask({
      prompt,
      title: 'Wake Agent',
      sessionKey: 'wake-agent:' + agentId + ':' + sessionKey,
      logPath,
      agentId,
      timeoutMs,
      execPolicy: 'restricted',
    });

    if (!result || !result.ok){
      if (blockedDecision){
        return {
          ...blockedDecision,
          source: 'rules_guard',
        };
      }
      return {
        ...fallback,
        source: 'llm_fallback',
        reason: 'wake_agent_llm_failed' + (fallback.reason ? ': ' + fallback.reason : ''),
      };
    }

    const parsed = safeJsonParse(result.assistantText, null);
    const validated = validateDecision(parsed);
    if (!validated){
      if (blockedDecision){
        return {
          ...blockedDecision,
          source: 'rules_guard',
        };
      }
      return {
        ...fallback,
        source: 'llm_fallback',
        reason: 'wake_agent_invalid_json' + (fallback.reason ? ': ' + fallback.reason : ''),
      };
    }

    if (blockedDecision){
      return {
        ...blockedDecision,
        source: 'rules_guard',
      };
    }

    return {
      ...validated,
      source: 'llm',
      shouldCooldown: false,
    };
  } catch {
    if (blockedDecision){
      return {
        ...blockedDecision,
        source: 'rules_guard',
      };
    }
    return {
      ...fallback,
      source: 'llm_fallback',
    };
  }
}

export { decideWake, decideWakeLLM };

export default { decideWake, decideWakeLLM };
