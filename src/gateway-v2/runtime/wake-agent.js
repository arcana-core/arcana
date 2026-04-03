const WAKE_AGENT_PROMPT = `
You are a wake decision helper for Arcana agents.
Given the result of the latest turn and a compact summary,
you decide whether to schedule another wake or to stop.

Patterns:
1) Model error: if this turn failed due to a model error,
   you should retry a few times with backoff. If retries
   have been exhausted or the error clearly indicates a
   permanent configuration problem (for example, no account
   available or invalid credentials), you should stop.
2) No output: if the turn completed successfully but produced
   no user-visible output, treat this as a possible mistaken
   early stop. In that case, schedule a follow-up wake after
   a short delay so the agent can double-check the state.
3) Normal completion: if interaction looks normal and the last
   turn produced a clear answer or conclusion for the current
   question, do not schedule any additional wake.
`;

function buildRunResultSummary(runResult) {
  try {
    const parts = [];
    const ok = !!runResult.ok;
    const skipped = !!runResult.skipped;
    const reason = runResult.skipReason || runResult.reason || '';
    const kind = runResult.kind || '';

    parts.push(`Status: ${ok ? 'ok' : (skipped ? 'skipped' : 'error')}.`);
    if (reason) parts.push(`Reason: ${reason}.`);
    if (kind) parts.push(`Kind: ${kind}.`);

    const retryCount = Number(runResult.retryCount || 0) || 0;
    const maxRetries = Number(runResult.maxRetries || 0) || 0;
    if (maxRetries > 0) {
      parts.push(`Retry: ${retryCount}/${maxRetries}.`);
    }

    const lastActivityAgoMs = Number(runResult.lastActivityAgoMs || 0) || 0;
    if (lastActivityAgoMs > 0) {
      parts.push(`LastActivityAgoMs: ${lastActivityAgoMs}.`);
    }

    try {
      let em = runResult.errorMessage;
      if (!em && runResult.error) {
        const err = runResult.error;
        if (typeof err === "string") em = err;
        else if (err && typeof err.message === "string") em = err.message;
        else if (err && typeof err.code === "string") em = err.code;
        else em = String(err || "");
      }
      if (em && typeof em === "string"){
        const s = em.length > 160 ? (em.slice(0, 157) + "...") : em;
        if (s) parts.push(`Error: ${s}`);
      }
    } catch {}
    return parts.join(' ');
  } catch {
    return '';
  }
}

// decideWake implements high-level patterns:
// - Model errors: retry a few times with backoff.
// - Normal turn with no output: schedule a follow-up wake using baseNextDelayMs or a small default.
// - Normal turn with output: do not schedule any wake.
function decideWake(runResult) {
  const summary = buildRunResultSummary(runResult);
  const baseDecision = {
    action: 'stop',
    delayMs: 0,
    reason: summary || 'no_summary',
  };

  if (!runResult) {
    return baseDecision;
  }

  const ok = !!runResult.ok;
  const hasOutput = !!runResult.hasOutput;
  const kind = runResult.kind || (ok ? (hasOutput ? 'normal' : 'no_output') : 'model_error');
  const retryCount = Number(runResult.retryCount || 0) || 0;
  const maxRetries = Number(runResult.maxRetries || 0) || 0;
  const baseNextDelayMs = Number(runResult.baseNextDelayMs || 0) || 0;

  // Pattern C: normal turn with visible output -> do not wake again.
  if (ok && hasOutput) {
    return {
      action: 'stop',
      delayMs: 0,
      reason: summary || 'turn_ok_with_output',
    };
  }

  // Pattern B: normal turn but no output -> only follow-up when runner explicitly requested a next wake.
  if (ok && !hasOutput && kind === 'no_output') {
    if (baseNextDelayMs > 0) {
      return {
        action: 'wake_later',
        delayMs: baseNextDelayMs,
        reason: summary || 'no_output_follow_up',
      };
    }
    return { action: 'stop', delayMs: 0, reason: summary || 'no_output_idle' };
  }

  // Pattern A: model error -> retry a few times with backoff, then stop.
  if (!ok && kind === 'model_error') {
    if (maxRetries > 0 && retryCount >= maxRetries) {
      return {
        action: 'stop',
        delayMs: 0,
        reason: summary || 'max_retries_reached',
      };
    }

    const base = baseNextDelayMs > 0 ? baseNextDelayMs : 5_000;
    const factor = Math.min(5, Math.max(1, retryCount + 1));
    const delayMs = base * factor;
    return {
      action: 'wake_later',
      delayMs,
      reason: summary || 'model_error_retry',
    };
  }

  // Fallback: for other kinds of errors, do not schedule automatic wake.
  return baseDecision;
}

export { decideWake };

export default { decideWake };
