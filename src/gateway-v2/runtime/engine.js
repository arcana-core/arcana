import { nowMs } from '../util.js';
import { decideWake, decideWakeLLM } from './wake-agent.js';

function getEnvInt(name, fallback){
  try {
    const raw = Number(process.env[name]);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  } catch {}
  return fallback;
}

function getWakeMode(){
  return 'llm';
}

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
  return 'error';
}

function normalizeErrorStack(errorStack, errorMessage){
  try {
    if (typeof errorStack === 'string' && errorStack.trim()) return errorStack;
  } catch {}
  try {
    const msg = normalizeErrorMessage(errorMessage);
    return msg ? (new Error(msg)).stack || msg : '';
  } catch {
    return normalizeErrorMessage(errorMessage);
  }
}

function buildShortError(errorMessage){
  const msg = normalizeErrorMessage(errorMessage);
  return msg.length > 200 ? (msg.slice(0, 197) + '...') : msg;
}

function ensureFailedResultShape(result, fallbackMessage){
  const base = result && typeof result === 'object' ? { ...result } : {};
  const errorValue = typeof base.error !== 'undefined' ? base.error : fallbackMessage;
  const errorMessage = normalizeErrorMessage(base.errorMessage || errorValue || fallbackMessage || 'error');
  const errorStack = normalizeErrorStack(base.errorStack, errorMessage);
  return {
    ...base,
    ok: false,
    error: errorValue,
    errorMessage,
    errorStack,
  };
}

function buildThrownRunnerResult(error){
  const errorMessage = normalizeErrorMessage(error);
  return {
    ok: false,
    ran: true,
    outputs: [],
    kind: 'model_error',
    error,
    errorMessage,
    errorStack: normalizeErrorStack(error && error.stack, errorMessage),
  };
}

function buildWakeInfoOutput({ wakeMode, decision, kind, retryCount, maxRetries, attemptsInWindow, maxAttemptsInWindow, cooldownUntilMs, reason, shortError }){
  const action = decision && typeof decision.action === 'string' ? decision.action : 'stop';
  const delayMs = decision && typeof decision.delayMs === 'number' && Number.isFinite(decision.delayMs) ? Math.max(0, Math.floor(decision.delayMs)) : 0;
  const source = decision && typeof decision.source === 'string' ? decision.source : wakeMode;
  const textParts = [
    'wake-agent',
    'source=' + source,
    'action=' + action,
    'kind=' + String(kind || 'unknown'),
  ];
  if (delayMs > 0) textParts.push('delayMs=' + String(delayMs));
  textParts.push('retry=' + String(retryCount) + '/' + String(maxRetries));
  textParts.push('attempts=' + String(attemptsInWindow) + '/' + String(maxAttemptsInWindow));
  if (cooldownUntilMs > 0) textParts.push('cooldownUntilMs=' + String(cooldownUntilMs));
  if (shortError) textParts.push('error=' + shortError);
  if (reason) textParts.push('reason=' + reason);

  return {
    kind: 'wake_info',
    text: textParts.join(' '),
    source,
    mode: wakeMode,
    action,
    delayMs,
    kindDetail: kind || 'unknown',
    retryCount,
    maxRetries,
    attemptsInWindow,
    maxAttemptsInWindow,
    cooldownUntilMs: cooldownUntilMs > 0 ? cooldownUntilMs : null,
    reason: reason || '',
    error: shortError || '',
  };
}

function buildTransportRetryOutput({ kind, delayMs, reason, error }){
  const textParts = [
    'transport-retry',
    'kind=' + String(kind || 'stream_incomplete'),
  ];
  if (delayMs > 0) textParts.push('delayMs=' + String(delayMs));
  if (error) textParts.push('error=' + String(error));
  if (reason) textParts.push('reason=' + String(reason));
  return {
    kind: 'wake_info',
    text: textParts.join(' '),
  };
}

async function emitTurnError({ wsHub, agentId, sessionKey, runnerId, reason, errorMessage, errorStack, logLabel }){
  try {
    const cap = 8000;
    const bounded = typeof errorStack === 'string' && errorStack.length > cap ? errorStack.slice(0, cap) : (errorStack || '');
    try {
      console.error(logLabel || '[arcana:gateway-v2] turn error', '\nagentId=', agentId, 'sessionKey=', sessionKey, 'runnerId=', runnerId, 'reason=', reason || 'wake', '\n', bounded || errorMessage);
    } catch {}
    if (wsHub && typeof wsHub.broadcast === 'function'){
      try {
        wsHub.broadcast({
          type: 'turn.error',
          agentId,
          sessionKey,
          runnerId,
          reason: reason || 'wake',
          error: errorMessage,
          errorStack: bounded,
          tsMs: nowMs(),
        });
      } catch {}
    }
  } catch {}
}

export function createEngine({ lane, scheduler, inbox, outbox, stateStore, runnerRegistry, trace, wsHub } = {}){
  const runInLane = typeof lane === 'function'
    ? lane
    : (lane && typeof lane.runInLane === 'function' ? lane.runInLane : null);

  if (typeof runInLane !== 'function'){
    throw new Error('lane_function_required');
  }

  const getState = stateStore && typeof stateStore.getState === 'function'
    ? stateStore.getState
    : null;
  const patchState = stateStore && typeof stateStore.patchState === 'function'
    ? stateStore.patchState
    : null;

  if (!getState || !patchState){
    throw new Error('state_store_missing');
  }

  const runners = runnerRegistry instanceof Map ? runnerRegistry : new Map();
  const inFlightByKey = new Map(); // key: agentId::sessionKey -> count

  async function resolveRunnerConfig(agentId, sessionKey){
    const aId = agentId || 'default';
    const sKey = sessionKey || 'session';

    let runnerState;
    try {
      runnerState = await getState({ agentId: aId, sessionKey: sKey, scope: 'runner' });
    } catch {
      runnerState = { value: null, version: 0, updatedAtMs: 0 };
    }

    const value = runnerState && runnerState.value ? runnerState.value : null;
    let enabled;
    if (value && Object.prototype.hasOwnProperty.call(value, 'enabled')){
      enabled = !!value.enabled;
    } else {
      enabled = undefined;
    }

    let runnerId = value && typeof value.runnerId === 'string' ? value.runnerId.trim() : '';
    let gatewayRunnerId = '';
    try {
      const gatewayState = await getState({ agentId: aId, sessionKey: sKey, scope: 'gateway' });
      const gv = gatewayState && gatewayState.value;
      const desired = gv && typeof gv.runnerId === 'string' ? gv.runnerId.trim() : '';
      if (desired) gatewayRunnerId = desired;
    } catch {}

    if (!runnerId) runnerId = gatewayRunnerId || 'reactor';
    const effectiveEnabled = (enabled === undefined) ? true : enabled;

    return { aId, sKey, runnerState, runnerValue: value || {}, runnerId, enabled: effectiveEnabled };
  }

  async function startRunner({ agentId, sessionKey, runnerId } = {}){
    const aId = agentId || 'default';
    const sKey = sessionKey || 'session';
    let rid = runnerId && String(runnerId).trim();

    if (!rid){
      try {
        const gatewayState = await getState({ agentId: aId, sessionKey: sKey, scope: 'gateway' });
        const gv = gatewayState && gatewayState.value;
        const desired = gv && typeof gv.runnerId === 'string' ? gv.runnerId.trim() : '';
        if (desired) rid = desired;
      } catch {}
    }

    if (!rid) rid = 'reactor';
    if (!runners.has(rid) && runners.has('reactor')){
      rid = 'reactor';
    }

    const result = await patchState({
      agentId: aId,
      sessionKey: sKey,
      scope: 'runner',
      expectedVersion: null,
      mutator: (prev) => ({ ...(prev || {}), enabled: true, runnerId: rid }),
    });

    try {
      if (scheduler && typeof scheduler.requestWake === 'function'){
        scheduler.requestWake({ agentId: aId, sessionKey: sKey, priority: 10, reason: 'runner.start', delayMs: 0 });
      }
    } catch {}

    return {
      ok: true,
      state: {
        value: result.value,
        version: result.version,
        updatedAtMs: result.updatedAtMs,
      },
    };
  }

  async function stopRunner({ agentId, sessionKey } = {}){
    const aId = agentId || 'default';
    const sKey = sessionKey || 'session';

    const result = await patchState({
      agentId: aId,
      sessionKey: sKey,
      scope: 'runner',
      expectedVersion: null,
      mutator: (prev) => ({ ...(prev || {}), enabled: false }),
    });

    return {
      ok: true,
      state: {
        value: result.value,
        version: result.version,
        updatedAtMs: result.updatedAtMs,
      },
    };
  }

  async function getRunnerStatus({ agentId, sessionKey } = {}){
    const aId = agentId || 'default';
    const sKey = sessionKey || 'session';

    let runnerState;
    try {
      runnerState = await getState({ agentId: aId, sessionKey: sKey, scope: 'runner' });
    } catch {
      runnerState = { value: null, version: 0, updatedAtMs: 0 };
    }

    const value = runnerState && runnerState.value ? runnerState.value : null;
    let enabled;
    if (value && Object.prototype.hasOwnProperty.call(value, 'enabled')){
      enabled = !!value.enabled;
    } else {
      enabled = undefined;
    }

    let runnerId = value && typeof value.runnerId === 'string' ? value.runnerId.trim() : '';
    let gatewayRunnerId = '';
    try {
      const gatewayState = await getState({ agentId: aId, sessionKey: sKey, scope: 'gateway' });
      const gv = gatewayState && gatewayState.value;
      const desired = gv && typeof gv.runnerId === 'string' ? gv.runnerId.trim() : '';
      if (desired) gatewayRunnerId = desired;
    } catch {}

    const effectiveRunnerId = runnerId || gatewayRunnerId || 'reactor';
    const effectiveEnabled = (enabled === undefined) ? true : enabled;

    return {
      ok: true,
      runner: {
        agentId: aId,
        sessionKey: sKey,
        configuredRunnerId: runnerId || null,
        effectiveRunnerId,
        enabled: effectiveEnabled,
        version: runnerState.version,
        updatedAtMs: runnerState.updatedAtMs,
      },
    };
  }

  async function tick({ agentId, sessionKey, reason, skipIfRunning } = {}){
    const aId = agentId || 'default';
    const sKey = sessionKey || 'session';
    const laneKey = ['engine', aId, sKey];
    const turnKey = aId + '::' + sKey;

    const existing = inFlightByKey.get(turnKey) || 0;
    if (skipIfRunning && existing > 0){
      return { ok: true, skipped: true, reason: 'requests-in-flight', runnerId: null };
    }

    const run = async () => {
      const cfg = await resolveRunnerConfig(aId, sKey);
      const runnerId = cfg.runnerId;
      const enabled = cfg.enabled;
      const runner = runners.get(runnerId) || runners.get('reactor');

      if (!runner || !enabled){
        return { ok: true, skipped: true, reason: enabled ? 'no_runner' : 'disabled', runnerId };
      }

      const startTsMs = nowMs();
      let wakeState = null;
      try {
        wakeState = await getState({ agentId: aId, sessionKey: sKey, scope: 'wake' });
      } catch {
        wakeState = { value: null, version: 0, updatedAtMs: 0 };
      }
      const prevWakeValue = wakeState && wakeState.value ? wakeState.value : {};

      let spanCtx = null;
      try {
        if (trace && typeof trace.emitSpan === 'function'){
          try {
            spanCtx = await trace.emitSpan({
              name: 'turn.started',
              attributes: {
                agentId: aId,
                sessionKey: sKey,
                runnerId,
                reason: reason || 'wake',
              },
            });
          } catch {}
        }
        if (wsHub && typeof wsHub.broadcast === 'function'){
          try {
            wsHub.broadcast({
              type: 'turn.started',
              agentId: aId,
              sessionKey: sKey,
              runnerId,
              reason: reason || 'wake',
              tsMs: startTsMs,
            });
          } catch {}
        }
      } catch {}

      let ok = false;
      let result;

      const prevCount = inFlightByKey.get(turnKey) || 0;
      inFlightByKey.set(turnKey, prevCount + 1);

      try {
        const ctx = {
          agentId: aId,
          sessionKey: sKey,
          wsHub,
          trace,
          inbox,
          outbox,
          scheduler,
          stateStore,
          lane: runInLane,
          reason,
          runnerState: cfg.runnerValue,
        };

        try {
          result = await runner.run(ctx);
        } catch (error) {
          result = buildThrownRunnerResult(error);
        }

        const wasAborted = !!(result && result.aborted);
        ok = !!(result && Object.prototype.hasOwnProperty.call(result, 'ok') ? result.ok : true);
        if (wasAborted) ok = true;
        if (!ok){
          result = ensureFailedResultShape(result, 'runner_failed');
          if (!wasAborted){
            await emitTurnError({
              wsHub,
              agentId: aId,
              sessionKey: sKey,
              runnerId,
              reason,
              errorMessage: result.errorMessage,
              errorStack: result.errorStack,
              logLabel: '[arcana:gateway-v2] turn error',
            });
          }
        }

        if (result && Array.isArray(result.outputs) && result.outputs.length && outbox && typeof outbox.deliverOutputs === 'function'){
          try {
            await outbox.deliverOutputs({
              agentId: aId,
              sessionKey: sKey,
              outputs: result.outputs,
              runnerId,
              reason,
            });
          } catch {}
        }

        const nextDelayRaw = result && result.nextWakeDelayMs;
        const runnerSuggestedDelayMs = (typeof nextDelayRaw === 'number' && Number.isFinite(nextDelayRaw) && nextDelayRaw > 0)
          ? Math.floor(nextDelayRaw)
          : null;
        const wakeMode = getWakeMode();

        if (wakeMode === 'off'){
          if (runnerSuggestedDelayMs && scheduler && typeof scheduler.requestWake === 'function' && cfg.enabled){
            try {
              scheduler.requestWake({
                agentId: aId,
                sessionKey: sKey,
                priority: 1,
                reason: 'runner.nextWake',
                delayMs: runnerSuggestedDelayMs,
              });
            } catch {}
          }
          return { ok, result, runnerId };
        }

        const outputs = result && Array.isArray(result.outputs) ? result.outputs : [];
        const completed = !!(result && result.completed);
        const hasOutput = (result && typeof result.hasOutput === 'boolean')
          ? !!result.hasOutput
          : outputs.some((output) => output && output.kind === 'assistant_message' && (output.text != null ? String(output.text).trim() : ''));
        const kind = result && typeof result.kind === 'string' && result.kind
          ? result.kind
          : (wasAborted ? 'aborted' : (!ok ? 'model_error' : ((result && Object.prototype.hasOwnProperty.call(result, 'ran') && result.ran === false) ? 'idle' : (hasOutput ? 'normal' : 'no_output'))));

        const processedThroughTs = Number(result && result.processedThroughTs || 0) || 0;
        if (!completed){
          if (wasAborted){
            if (processedThroughTs > 0){
              try {
                await patchState({
                  agentId: aId,
                  sessionKey: sKey,
                  scope: 'reactor',
                  expectedVersion: null,
                  mutator: (prev) => {
                    const cur = prev && typeof prev === 'object' ? prev : {};
                    const prevLastSeenTs = Number(cur.lastSeenTs || 0) || 0;
                    if (processedThroughTs <= prevLastSeenTs) return cur;
                    return {
                      ...cur,
                      lastSeenTs: processedThroughTs,
                      lastTerminalKind: 'aborted',
                      lastTerminalAtMs: nowMs(),
                    };
                  },
                });
              } catch {}
            }
            return { ok: true, result, runnerId };
          }

          const transportRetryDelayMs = runnerSuggestedDelayMs && runnerSuggestedDelayMs > 0
            ? runnerSuggestedDelayMs
            : getEnvInt('ARCANA_GATEWAY_V2_STREAM_RETRY_DELAY_MS', 3000);
          if (outbox && typeof outbox.deliverOutputs === 'function'){
            try {
              await outbox.deliverOutputs({
                agentId: aId,
                sessionKey: sKey,
                outputs: [
                  buildTransportRetryOutput({
                    kind: kind || 'stream_incomplete',
                    delayMs: transportRetryDelayMs,
                    reason: reason || 'transport_retry',
                    error: buildShortError(result && result.errorMessage),
                  }),
                ],
                runnerId,
                reason,
              });
            } catch {}
          }
          if (cfg.enabled && scheduler && typeof scheduler.requestWake === 'function'){
            try {
              scheduler.requestWake({
                agentId: aId,
                sessionKey: sKey,
                priority: 2,
                reason: 'transport-retry',
                delayMs: transportRetryDelayMs,
              });
            } catch {}
          }
          return { ok, result, runnerId };
        }

        const maxRetries = getEnvInt('ARCANA_GATEWAY_V2_WAKE_MAX_RETRIES', 6);
        const maxAttemptsInWindow = getEnvInt('ARCANA_GATEWAY_V2_WAKE_MAX_ATTEMPTS_WINDOW', 20);
        const windowMs = getEnvInt('ARCANA_GATEWAY_V2_WAKE_WINDOW_MS', 30 * 60 * 1000);
        const cooldownMs = getEnvInt('ARCANA_GATEWAY_V2_WAKE_COOLDOWN_MS', 30 * 60 * 1000);
        const baseNextDelayMs = getEnvInt('ARCANA_GATEWAY_V2_WAKE_BASE_DELAY_MS', 5000);
        const wakeAgentTimeoutMs = getEnvInt('ARCANA_GATEWAY_V2_WAKE_AGENT_TIMEOUT_MS', 8000);
        const now = nowMs();

        const prevRetryCount = Number(prevWakeValue.retryCount || 0) || 0;
        const prevAttemptsInWindow = Number(prevWakeValue.attemptsInWindow || 0) || 0;
        const prevWindowStartedAtMs = Number(prevWakeValue.windowStartedAtMs || 0) || 0;
        const prevCooldownUntilMs = Number(prevWakeValue.cooldownUntilMs || 0) || 0;

        const isRecoveryTurn = !ok || kind === 'no_output';
        const resetRecoveryState = ok && hasOutput;
        const windowExpired = !prevWindowStartedAtMs || (windowMs > 0 && (now - prevWindowStartedAtMs) >= windowMs);
        const windowStartedAtMs = resetRecoveryState ? 0 : (windowExpired ? now : prevWindowStartedAtMs);
        const attemptsBase = resetRecoveryState ? 0 : (windowExpired ? 0 : prevAttemptsInWindow);
        const attemptsInWindow = isRecoveryTurn ? (attemptsBase + 1) : attemptsBase;
        const retryCount = resetRecoveryState ? 0 : (isRecoveryTurn ? (prevRetryCount + 1) : prevRetryCount);

        const wakeInput = {
          ...result,
          ok,
          hasOutput,
          kind,
          retryCount,
          maxRetries,
          attemptsInWindow,
          maxAttemptsInWindow,
          cooldownUntilMs: prevCooldownUntilMs,
          cooldownMs,
          nowMs: now,
          runnerSuggestedDelayMs,
          baseNextDelayMs,
        };

        let decision;
        if (wakeMode === 'llm'){
          decision = await decideWakeLLM(wakeInput, {
            agentId: aId,
            sessionKey: sKey,
            timeoutMs: wakeAgentTimeoutMs,
          });
        } else {
          decision = decideWake(wakeInput);
        }

        const shouldStartCooldown = !!(decision && decision.shouldCooldown);
        const nextCooldownUntilMs = shouldStartCooldown
          ? Math.max(prevCooldownUntilMs, now + cooldownMs)
          : ((prevCooldownUntilMs > now) ? prevCooldownUntilMs : 0);
        const shortError = ok ? '' : buildShortError(result && result.errorMessage);
        const wakeReason = decision && typeof decision.reason === 'string' ? decision.reason : '';
        const wakeInfoOutput = buildWakeInfoOutput({
          wakeMode,
          decision,
          kind,
          retryCount,
          maxRetries,
          attemptsInWindow,
          maxAttemptsInWindow,
          cooldownUntilMs: nextCooldownUntilMs,
          reason: wakeReason,
          shortError,
        });
        const shouldEmitWakeInfo = !(reason === 'runner.start' && result && result.ran === false);

        if (shouldEmitWakeInfo && outbox && typeof outbox.deliverOutputs === 'function'){
          try {
            await outbox.deliverOutputs({
              agentId: aId,
              sessionKey: sKey,
              outputs: [wakeInfoOutput],
              runnerId,
              reason,
            });
          } catch {}
        }

        try {
          await patchState({
            agentId: aId,
            sessionKey: sKey,
            scope: 'wake',
            expectedVersion: wakeState ? wakeState.version : null,
            mutator: (prev) => ({
              ...(prev || {}),
              retryCount,
              attemptsInWindow,
              windowStartedAtMs,
              cooldownUntilMs: nextCooldownUntilMs || null,
              lastErrorMessage: ok ? null : (result && result.errorMessage ? result.errorMessage : null),
              lastErrorStack: ok ? null : (result && result.errorStack ? result.errorStack : null),
              lastKind: kind,
              lastOk: ok,
              lastDecisionAction: decision && decision.action ? decision.action : null,
              lastDecisionSource: decision && decision.source ? decision.source : wakeMode,
              lastDecisionDelayMs: decision && typeof decision.delayMs === 'number' ? decision.delayMs : null,
              lastDecisionReason: wakeReason || null,
              lastDecisionAtMs: now,
            }),
          });
        } catch {}

        if (decision && decision.action === 'stop' && processedThroughTs > 0){
          try {
            await patchState({
              agentId: aId,
              sessionKey: sKey,
              scope: 'reactor',
              expectedVersion: null,
              mutator: (prev) => {
                const cur = prev && typeof prev === 'object' ? prev : {};
                const prevLastSeenTs = Number(cur.lastSeenTs || 0) || 0;
                if (processedThroughTs <= prevLastSeenTs) return cur;
                return {
                  ...cur,
                  lastSeenTs: processedThroughTs,
                  lastTerminalKind: kind,
                  lastTerminalAtMs: now,
                };
              },
            });
          } catch {}
        }

        const allowWakeSchedule = cfg.enabled
          && scheduler
          && typeof scheduler.requestWake === 'function'
          && !(result && Object.prototype.hasOwnProperty.call(result, 'ran') && result.ran === false);

        if (allowWakeSchedule && decision && decision.action === 'wake_later' && decision.delayMs > 0){
          try {
            scheduler.requestWake({
              agentId: aId,
              sessionKey: sKey,
              priority: 2,
              reason: 'wake-agent',
              delayMs: decision.delayMs,
            });
          } catch {}
        }
      } finally {
        try {
          const cur = inFlightByKey.get(turnKey) || 0;
          if (cur <= 1) inFlightByKey.delete(turnKey);
          else inFlightByKey.set(turnKey, cur - 1);
        } catch {}

        const endTsMs = nowMs();
        if (trace && typeof trace.emitSpan === 'function'){
          try {
            await trace.emitSpan({
              name: 'turn.ended',
              traceId: spanCtx && spanCtx.traceId ? spanCtx.traceId : undefined,
              parentSpanId: spanCtx && spanCtx.spanId ? spanCtx.spanId : undefined,
              attributes: {
                agentId: aId,
                sessionKey: sKey,
                runnerId,
                ok,
                reason: reason || 'wake',
              },
            });
          } catch {}
        }
        if (wsHub && typeof wsHub.broadcast === 'function'){
          try {
            wsHub.broadcast({
              type: 'turn.ended',
              agentId: aId,
              sessionKey: sKey,
              runnerId,
              ok,
              tsMs: endTsMs,
            });
          } catch {}
        }
      }

      return { ok, result, runnerId };
    };

    return runInLane(laneKey, run);
  }

  return { startRunner, stopRunner, getRunnerStatus, tick };
}

export default { createEngine };
