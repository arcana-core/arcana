import { nowMs } from '../util.js';
import { decideWake } from './wake-agent.js';

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
      // Wake-agent retry state (persisted)
      let wakeState = null;
      try {
        wakeState = await getState({ agentId: aId, sessionKey: sKey, scope: 'wake' });
      } catch {
        wakeState = { value: null, version: 0, updatedAtMs: 0 };
      }
      const prevWakeRetryCount = Number(wakeState && wakeState.value && wakeState.value.retryCount || 0) || 0;

      let spanCtx = null;
      let __wakeScheduled = false;
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
          ok = !!(result && Object.prototype.hasOwnProperty.call(result, 'ok') ? result.ok : true);
          // If runner succeeded but returned ok:false, broadcast error without throwing
          if (!ok && result) {
            const msg = (typeof result.error === 'string' && result.error) ? result.error : 'error';
            const rawStack = (typeof result.errorStack === 'string' && result.errorStack) ? result.errorStack : (msg ? (new Error(String(msg))).stack : '');
            const cap = 8000;
            const bounded = rawStack && rawStack.length > cap ? rawStack.slice(0, cap) : rawStack;
            try { console.error('[arcana:gateway-v2] turn error (runner result)', '\nagentId=', aId, 'sessionKey=', sKey, 'runnerId=', runnerId, 'reason=', reason || 'wake', '\n', bounded || msg); } catch {}
            if (wsHub && typeof wsHub.broadcast === 'function'){
              try {
                wsHub.broadcast({
                  type: 'turn.error',
                  agentId: aId,
                  sessionKey: sKey,
                  runnerId,
                  reason: reason || 'wake',
                  error: msg,
                  errorStack: bounded || '',
                  tsMs: nowMs(),
                });
              } catch {}
            }
          }
        } catch (e) {
          ok = false;
          try {
            const full = e && e.stack ? String(e.stack) : (e && e.message ? String(e.message) : String(e||''));
            const cap = 8000;
            const bounded = full.length > cap ? full.slice(0, cap) : full;
            console.error('[arcana:gateway-v2] turn error', '\nagentId=', aId, 'sessionKey=', sKey, 'runnerId=', runnerId, 'reason=', reason || 'wake', '\n', full);
            if (wsHub && typeof wsHub.broadcast === 'function'){
              try {
                wsHub.broadcast({
                  type: 'turn.error',
                  agentId: aId,
                  sessionKey: sKey,
                  runnerId,
                  reason: reason || 'wake',
                  error: e && e.message ? String(e.message) : 'error',
                  errorStack: bounded,
                  tsMs: nowMs(),
                });
              } catch {}
            }
            const retryMsRaw = Number(process.env.ARCANA_GATEWAY_V2_ERROR_RETRY_MS);
            const retryDelayMs = (Number.isFinite(retryMsRaw) && retryMsRaw >= 0) ? retryMsRaw : 5000;
            if (scheduler && typeof scheduler.requestWake === 'function'){
              try {
                scheduler.requestWake({ agentId: aId, sessionKey: sKey, priority: 5, reason: 'runner.recover', delayMs: retryDelayMs });
              } catch {}
            }
          } catch {}
          throw e;
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
        const nextDelay = (typeof nextDelayRaw === 'number' && Number.isFinite(nextDelayRaw) && nextDelayRaw > 0)
          ? nextDelayRaw
          : null;
        if (nextDelay && scheduler && typeof scheduler.requestWake === 'function' && cfg.enabled){
          try {
            scheduler.requestWake({
              agentId: aId,
              sessionKey: sKey,
              priority: 1,
              reason: 'runner.nextWake',
              delayMs: nextDelay,
            });
          } catch {}
        }

        // Wake-agent fallback: when runner did not explicitly schedule a next wake,
        // decide whether to retry (model_error) or follow up (no_output).
        try {
          if (!nextDelay && scheduler && typeof scheduler.requestWake === 'function' && cfg.enabled){
            // If runner explicitly reported it did not run / had no work, don't auto-wake.
            if (result && Object.prototype.hasOwnProperty.call(result, 'ran') && result.ran === false) {
              // Still persist wake retry state below (it will be reset on ok), but skip scheduling.
            }
            const outputs = result && Array.isArray(result.outputs) ? result.outputs : [];
            const hasOutput = (result && typeof result.hasOutput === 'boolean')
              ? !!result.hasOutput
              : outputs.some((o)=> o && (o.kind === 'assistant_message' || o.kind === 'wake_info') && (o.text != null ? String(o.text).trim() : ''));
            const kind = result && typeof result.kind === 'string' ? result.kind : (!ok ? 'model_error' : (hasOutput ? 'normal' : 'no_output'));

            const maxRetriesRaw = Number(process.env.ARCANA_GATEWAY_V2_WAKE_MAX_RETRIES);
            const maxRetries = (Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0) ? Math.floor(maxRetriesRaw) : 3;
            const baseDelayRaw = Number(process.env.ARCANA_GATEWAY_V2_WAKE_BASE_DELAY_MS);
            const baseNextDelayMs = (Number.isFinite(baseDelayRaw) && baseDelayRaw >= 0) ? Math.floor(baseDelayRaw) : 5000;

            const retryCount = ok ? 0 : (prevWakeRetryCount + 1);
            const decision = decideWake({
              ok,
              hasOutput,
              kind,
              retryCount,
              maxRetries,
              baseNextDelayMs,
            });

            // Persist wake retry count even when we decide to stop (useful for debugging).
            try {
              await patchState({
                agentId: aId,
                sessionKey: sKey,
                scope: 'wake',
                expectedVersion: wakeState ? wakeState.version : null,
                mutator: (prev) => ({
                  ...(prev || {}),
                  retryCount,
                  lastKind: kind,
                  lastOk: ok,
                  lastDecision: decision && decision.action ? decision.action : null,
                  lastDecisionDelayMs: decision && typeof decision.delayMs === 'number' ? decision.delayMs : null,
                  lastDecisionAtMs: nowMs(),
                }),
              });
            } catch {}

            if (decision && decision.action === 'wake_later' && decision.delayMs > 0 && !(result && Object.prototype.hasOwnProperty.call(result, 'ran') && result.ran === false)) {
              scheduler.requestWake({
                agentId: aId,
                sessionKey: sKey,
                priority: 2,
                reason: 'wake-agent',
                delayMs: decision.delayMs,
              });
            }
          }
        } catch {}
      } catch (e) {
        ok = false;
        throw e;
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
