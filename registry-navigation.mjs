/**
 * Official 0.2 navigation + Claw session create (remote.session).
 * Uses uiWorkspace for open/start/archive and remote.session for Claw create.
 */

export function unwrapRemote(result) {
  if (result && result.ok === true) return result.value
  const err = new Error(
    (result && result.error && (result.error.message || result.error.code))
      || 'remote call failed',
  )
  err.name = 'RemoteResultError'
  err.code = result && result.error && result.error.code
  err.details = result && result.error && result.error.details
  err.remote = result
  throw err
}

export function partialCreateError({ sessionId, stage, cause }) {
  const err = new Error(
    cause && cause.message
      ? `Claw session partial create (${stage}): ${cause.message}`
      : `Claw session partial create (${stage})`,
  )
  err.name = 'ClawPartialCreateError'
  err.code = 'ClawPartialCreateError'
  err.sessionId = sessionId
  err.stage = stage
  err.cause = cause
  err.actions = ['retry', 'open-session']
  return err
}

export function createNavigation(ctx) {
  const ui = ctx && ctx.uiWorkspace
  const sessions = ctx && ctx.sessions
  return {
    startSession(workspaceId) {
      if (!ui || typeof ui.startSession !== 'function') {
        throw new Error('uiWorkspace.startSession unavailable')
      }
      ui.startSession(workspaceId)
    },
    openSession(sessionId) {
      if (!ui || typeof ui.openSession !== 'function') {
        throw new Error('uiWorkspace.openSession unavailable')
      }
      ui.openSession(sessionId)
    },
    async forkSession(sessionId) {
      if (!sessions || typeof sessions.fork !== 'function') {
        throw new Error('sessions.fork unavailable')
      }
      const childId = await sessions.fork({ sessionId, increaseTitle: true })
      if (childId && ui && typeof ui.openSession === 'function') {
        ui.openSession(childId)
      }
      return childId
    },
    archiveSession(sessionId, options) {
      if (!ui || typeof ui.archiveSession !== 'function') {
        throw new Error('uiWorkspace.archiveSession unavailable')
      }
      return ui.archiveSession(sessionId, options)
    },
  }
}

/**
 * @param {object} ctx - must expose remote.session, sessions, uiWorkspace
 * @param {object} agent - { id, agentId?, presetId?, dshPreset?, defaultModel?, model?, workspaceId? }
 * @param {string} workspaceId
 * @param {object} [options]
 * @param {(path: string, body: any) => Promise<any>} [options.post]
 * @param {number} [options.expectedRevision]
 * @param {() => Promise<any>} [options.loadProjected]
 * @param {(info: { sessionId: string, agentId: string, presetId: string }) => Promise<void>|void} [options.persistSessionBinding]
 * @param {(agent: object) => Promise<void>|void} [options.requireAgentPresetReady]
 */
export async function createClawSession(ctx, agent, workspaceId, options = {}) {
  const agentId = agent && (agent.agentId || agent.id)
  const presetId = agent && (agent.dshPreset || agent.presetId)
  if (!presetId) throw new Error('agent.presetId required')
  if (!workspaceId) throw new Error('workspaceId required')
  const remote = ctx && ctx.remote && ctx.remote.session
  if (!remote || typeof remote.create !== 'function') {
    throw new Error('remote.session.create unavailable')
  }
  if (typeof options.requireAgentPresetReady === 'function') {
    await options.requireAgentPresetReady(agent)
  }

  // 1. caller-owned id for idempotency
  const candidateId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? `session-${crypto.randomUUID()}`
    : `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

  const created = await remote.create({
    workspaceId,
    sessionId: candidateId,
    agentPreset: presetId,
  })
  const value = unwrapRemote(created)
  const actualSessionId = (value && value.sessionId) || candidateId
  if (!actualSessionId) throw new Error('session create returned no sessionId')

  // 2. verify target preset
  if (value && value.agentPreset != null && value.agentPreset !== presetId) {
    throw partialCreateError({ sessionId: actualSessionId, stage: 'verify-preset' })
  }

  // 3. persist binding BEFORE selecting model
  const hasWindow = typeof window !== 'undefined'
  let bindResult = null
  if (typeof options.post === 'function') {
    try {
      bindResult = await options.post('/api/dsh-claw/registry/session/bind', {
        sessionId: actualSessionId,
        agentId: agentId || 'main',
        workspaceId,
        presetId,
        expectedRevision: options.expectedRevision,
        source: 'create',
      })
    } catch (cause) {
      throw partialCreateError({ sessionId: actualSessionId, stage: 'bind-session', cause })
    }
  } else if (typeof options.persistSessionBinding === 'function') {
    await options.persistSessionBinding({
      sessionId: actualSessionId,
      agentId: agentId || 'main',
      presetId,
    })
  } else if (hasWindow && typeof fetch === 'function') {
    try {
      const res = await fetch('/api/dsh-claw/registry/session/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: actualSessionId,
          agentId: agentId || 'main',
          workspaceId,
          presetId,
          expectedRevision: options.expectedRevision,
          source: 'create',
        }),
      })
      const data = await res.json()
      if (!res.ok && (!data || data.ok !== true)) {
        const err = new Error((data && data.message) || 'bind failed')
        err.code = data && data.code
        throw err
      }
      bindResult = data
    } catch (cause) {
      throw partialCreateError({ sessionId: actualSessionId, stage: 'bind-session', cause })
    }
  }

  const currentRevision = (bindResult && bindResult.revision) != null
    ? bindResult.revision
    : options.expectedRevision

  // 4. select model
  const model = agent.model || agent.defaultModel
  try {
    if (model && model.provider && model.model && typeof remote.selectModel === 'function') {
      unwrapRemote(await remote.selectModel({
        sessionId: actualSessionId,
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort != null ? { reasoningEffort: model.reasoningEffort } : {}),
      }))
    }
    if (typeof options.post === 'function') {
      try {
        await options.post('/api/dsh-claw/registry/session/state', {
          sessionId: actualSessionId,
          state: 'ready',
          expectedRevision: currentRevision,
        })
      } catch { /* non-fatal */ }
    } else if (hasWindow && typeof fetch === 'function' && typeof options.persistSessionBinding !== 'function') {
      try {
        await fetch('/api/dsh-claw/registry/session/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: actualSessionId,
            state: 'ready',
            expectedRevision: currentRevision,
          }),
        })
      } catch { /* non-fatal */ }
    }
  } catch (cause) {
    if (typeof options.post === 'function') {
      try {
        await options.post('/api/dsh-claw/registry/session/state', {
          sessionId: actualSessionId,
          state: 'needs_model',
          expectedRevision: currentRevision,
        })
      } catch { /* non-fatal */ }
    } else if (hasWindow && typeof fetch === 'function' && typeof options.persistSessionBinding !== 'function') {
      try {
        await fetch('/api/dsh-claw/registry/session/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: actualSessionId,
            state: 'needs_model',
            expectedRevision: currentRevision,
          }),
        })
      } catch { /* non-fatal */ }
    }
    throw partialCreateError({ sessionId: actualSessionId, stage: 'select-model', cause })
  }

  // 5. reconcile & open
  if (ctx.sessions && typeof ctx.sessions.refresh === 'function') {
    await ctx.sessions.refresh()
  }
  if (typeof options.loadProjected === 'function') {
    await options.loadProjected()
  }
  if (ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === 'function') {
    ctx.uiWorkspace.openSession(actualSessionId)
  }
  return actualSessionId
}

