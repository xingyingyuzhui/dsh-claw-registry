import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  atomicMutateRegistry,
  bindSession,
  defaultDshHome,
  loadRegistry,
  loadRegistrySync,
  markBindingState,
  registryFile,
  resolveSessionRepair,
  saveRegistry,
} from './registry-store.mjs'
import { defaultsFile, loadDefaultsSync, readTemplateSeedsSync, saveDefaults, writeTemplateSeed } from 'dsh-claw-policy/store'
import { clearSelectedClawDefault, normalizePolicy } from './registry-presets.mjs'
import { createPresetSupply } from './registry-preset-supply.mjs'
import {
  archiveAgent,
  explainAgent,
  identityPaths,
  listProjected,
  renameAgent,
  restoreAgent,
  sameRoot,
  syncBindings,
  updateAgentModel,
  updateAgentPolicy,
  updateAgentSkills,
} from './registry-logic.mjs'
import {
  applyLeaveBehind,
  applyLeaveBehindOffline,
  ensureOfficialWorkspaces,
  readProfilePackageSync,
  setLeaveBehind,
  shouldApplyLeaveBehind,
  writeLeavePlan,
} from './registry-leave.mjs'
import { listModelCatalog, normalizeModel } from './registry-model.mjs'
import {
  bindCreatedAgent,
  clawHome,
  isClawHomePath,
  listClawSlugs,
  purgeLegacyAgents,
  reserveClawWorkspace,
  sanitizeAgentTitle,
  seedFiles,
  slugFromName,
} from './registry-claw.mjs'
import { migrateClawLegacy, migrateRegistryV1ToV2 } from './registry-migrate.mjs'
import { CODES, currentTraceId, operation, runWithTrace, setObserveHome } from 'dsh-claw-observability/observe'
import { httpError, registerJsonRoute } from 'dsh-claw-core/http'

export const name = 'dsh-claw-registry'
export const inject = ['connection', 'workspaceRegistry', 'agentPresets', 'settings', 'sessionController']

let dshHome = defaultDshHome()

const _internal = {
  setDshHome(dir) {
    dshHome = dir
    setObserveHome(dir)
  },
  getDshHome() { return dshHome },
  migrateOnApply: true,
}
export { _internal }

function withTrace(data) {
  const traceId = currentTraceId()
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  if (!traceId || data.traceId != null) return data
  return { ...data, traceId }
}

function runLegacyMigrate(ctx) {
  const op = operation({ plugin: 'dsh-claw-registry', feature: 'legacy', operation: 'migrate_claw_presets' })
  try {
    const result = migrateClawLegacy(dshHome)
    const changed = (result.quarantined && result.quarantined.length) || (result.sessions && result.sessions.length)
    if (!changed && result.skipped) return
    op.start()
    if (result.incomplete) {
      op.degraded(CODES.REGISTRY_LEGACY_MIGRATE_FAILED, {
        quarantined: result.quarantined.length,
        sessions: result.sessions.length,
        errors: (result.errors || []).length,
      })
    } else {
      op.success({
        code: CODES.REGISTRY_LEGACY_MIGRATED,
        quarantined: result.quarantined.length,
        sessions: result.sessions.length,
      })
    }
    if (changed && ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info('dsh-claw-registry: migrated leftover wa-* (' + result.quarantined.length + ' presets, ' + result.sessions.length + ' sessions)')
    }
  } catch (error) {
    op.start()
    op.fail(CODES.REGISTRY_LEGACY_MIGRATE_FAILED, error)
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('dsh-claw-registry: leftover migrate failed: ' + (error && error.message ? error.message : error))
    }
  }
}

function optionalService(ctx, key) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const got = ctx.get(key)
      if (got != null) return got
    } catch { /* not injected */ }
  }
  if (ctx && Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key]
  return undefined
}

function listWorkspaces(ctx) {
  try {
    const list = ctx.workspaceRegistry && typeof ctx.workspaceRegistry.list === 'function'
      ? ctx.workspaceRegistry.list()
      : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function guardClawDefault(ctx) {
  const presets = ctx.agentPresets
  if (presets == null) return
  try {
    // defaultId resolves selectedDefault ?? deployment default; only unset when Claw.
    await clearSelectedClawDefault(ctx.settings, presets.defaultId)
  } catch (error) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('dsh-claw-registry: could not clear claw default: ' + (error && error.message ? error.message : error))
    }
  }
}

async function provisionPresets(ctx, registry) {
  await guardClawDefault(ctx)
  return registry
}

async function readSynced(ctx, supply) {
  const file = registryFile(dshHome)
  let loaded = await loadRegistry(file)
  if (loaded.version < 2 || !loaded.sessionBindings) {
    const migration = await migrateRegistryV1ToV2(dshHome, loaded, optionalService(ctx, 'sessionController'), listWorkspaces(ctx))
    if (migration.migrated) {
      loaded = migration.registry
    }
  }
  const purged = purgeLegacyAgents(loaded, dshHome)
  for (const agent of purged.removed) {
    await supply.release(agent.dshPreset)
  }
  let workspaces = listWorkspaces(ctx)
  const synced = syncBindings(purged.registry, workspaces)
  const provisioned = await provisionPresets(ctx, synced.registry, workspaces)
  const dirty = purged.changed || synced.changed || provisioned !== synced.registry
  let registry = dirty ? await saveRegistry(file, provisioned) : provisioned
  try {
    const ensured = await ensureOfficialWorkspaces(ctx, registry)
    if (ensured.created && ensured.registry !== registry) {
      registry = await saveRegistry(file, ensured.registry)
    }
  } catch { /* official create is best-effort */ }
  workspaces = listWorkspaces(ctx)
  try { writeLeavePlan(dshHome, registry, workspaces) } catch { /* plan is best-effort */ }
  return { registry, workspaces }
}

export function apply(ctx) {
  if (_internal.migrateOnApply) runLegacyMigrate(ctx)

  const supply = createPresetSupply(ctx.agentPresets)
  ctx.effect(() => () => { void supply.disposeAll() })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/list',
    handle: async (_body, request) => runWithTrace(request, async () => {
      const { registry, workspaces } = await readSynced(ctx, supply)
      const projected = listProjected(registry, workspaces, dshHome)
      if (projected.main) projected.main.files = identityPaths(dshHome, 'main', projected.main)
      return withTrace({
        home: dshHome,
        clawHome: clawHome(dshHome),
        leaveBehind: registry.settings && registry.settings.leaveBehind,
        template: {
          ...loadDefaultsSync(defaultsFile(dshHome)),
          seeds: readTemplateSeedsSync(dshHome),
          stockSeeds: seedFiles(''),
        },
        ...projected,
      })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/explain',
    handle: async (body, request) => runWithTrace(request, async () => {
      const { registry, workspaces } = await readSynced(ctx, supply)
      const row = explainAgent(registry, workspaces, body || {})
      if (!row) throw httpError(404, 'agent not found')
      return withTrace({ agent: row })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/archive',
    handle: async (body, request) => runWithTrace(request, async () => {
      const agentId = body && body.agentId
      if (typeof agentId !== 'string' || !agentId.startsWith('wa_')) {
        throw httpError(400, 'invalid agent id')
      }
      const file = registryFile(dshHome)
      const loaded = await loadRegistry(file)
      const result = archiveAgent(loaded, agentId)
      if (!result.agent) throw httpError(404, 'agent not found')
      await saveRegistry(file, result.registry)
      return withTrace({ agent: result.agent })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/rename',
    handle: async (body, request) => runWithTrace(request, async () => {
      const agentId = body && body.agentId
      const title = sanitizeAgentTitle(body && body.name)
      const op = operation({ plugin: 'dsh-claw-registry', feature: 'agent', operation: 'rename_agent', agentId })
      op.start()
      if (typeof agentId !== 'string' || !agentId.startsWith('wa_') || !title) {
        op.reject(CODES.REGISTRY_RENAME_INVALID)
        throw httpError(400, 'invalid rename', CODES.REGISTRY_RENAME_INVALID)
      }
      const file = registryFile(dshHome)
      const loaded = await loadRegistry(file)
      const result = renameAgent(loaded, agentId, title)
      if (!result.agent) {
        op.reject(CODES.REGISTRY_AGENT_NOT_FOUND)
        throw httpError(404, 'agent not found', CODES.REGISTRY_AGENT_NOT_FOUND)
      }
      try {
        await saveRegistry(file, result.registry)
      } catch (error) {
        op.fail(CODES.REGISTRY_RENAME_FAILED, error, { state: 'clean' })
        throw httpError(500, 'rename save failed', CODES.REGISTRY_RENAME_FAILED)
      }
      op.success({ agentId })
      return withTrace({ agent: result.agent })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/create',
    handle: async (body, request) => runWithTrace(request, async () => {
      const op = operation({ plugin: 'dsh-claw-registry', feature: 'agent', operation: 'create_agent' })
      op.start()
      const title = sanitizeAgentTitle(body && body.name)
      if (!title) {
        op.reject(CODES.REGISTRY_NAME_INVALID)
        throw httpError(400, 'name required', CODES.REGISTRY_NAME_INVALID)
      }
      const file = registryFile(dshHome)
      const loaded = await loadRegistry(file)
      const disk = listClawSlugs(dshHome)
      const registrySlugs = new Set(Object.values(loaded.agents).map((row) => row.slug).filter(Boolean))
      const preferred = slugFromName(title, registrySlugs)
      const used = new Set([...registrySlugs, ...disk])
      const slug = slugFromName(title, used)
      const skippedOrphan = preferred !== slug
      let path
      try {
        op.stage('reserve_dir')
        path = reserveClawWorkspace(dshHome, slug)
      } catch (error) {
        op.reject(CODES.REGISTRY_WORKSPACE_EXISTS, { state: 'clean' })
        throw httpError(409, error && error.message ? error.message : 'workspace exists', CODES.REGISTRY_WORKSPACE_EXISTS)
      }
      const files = { ...seedFiles(title), ...readTemplateSeedsSync(dshHome) }
      await mkdir(join(path, 'memory'), { recursive: true })
      for (const [name, text] of Object.entries(files)) {
        await writeFile(join(path, name), text)
      }
      if (ctx.workspaceRegistry == null || typeof ctx.workspaceRegistry.create !== 'function') {
        op.fail(CODES.REGISTRY_CREATE_FAILED, new Error('workspace registry unavailable'), {
          state: 'partially_applied',
          remainingArtifacts: ['workspace_dir', 'identity_files'],
        })
        throw httpError(500, 'workspace registry unavailable', CODES.REGISTRY_CREATE_FAILED)
      }
      const workspace = await ctx.workspaceRegistry.create(path, title)
      const dshPreset = 'wa-' + slug
      const bound = bindCreatedAgent(loaded, {
        workspaceId: workspace.id,
        slug,
        path: workspace.path || path,
        title: workspace.title || title,
        dshPreset,
      })
      const defaults = loadDefaultsSync(defaultsFile(dshHome))
      const seeded = updateAgentPolicy(bound.registry, bound.agent.agentId, normalizePolicy(defaults.policy || {
        preset: defaults.preset || bound.agent.preset || 'research',
        mcp: defaults.mcp,
        servers: defaults.servers,
      }))
      let registryOut = seeded.registry || bound.registry
      let agent = seeded.agent || bound.agent
      if (defaults.model) {
        const modeled = updateAgentModel(registryOut, agent.agentId, defaults.model)
        registryOut = modeled.registry
        agent = modeled.agent || agent
      }
      if (defaults.skills && defaults.skills.deny && defaults.skills.deny.length) {
        const skilled = updateAgentSkills(registryOut, agent.agentId, defaults.skills.deny)
        registryOut = skilled.registry
        agent = skilled.agent || agent
      }
      op.stage('policy_write')
      try {
        if (agent.canonicalRoot && isClawHomePath(dshHome, agent.canonicalRoot) && agent.policy) {
          await writeFile(join(agent.canonicalRoot, 'policy.json'), JSON.stringify(agent.policy, null, 2) + '\n')
        }
      } catch (error) {
        op.fail(CODES.REGISTRY_POLICY_WRITE_FAILED, error, {
          state: 'partially_applied',
          remainingArtifacts: ['workspace_dir', 'identity_files'],
          agentId: agent.agentId,
        })
        throw httpError(500, 'policy write failed', CODES.REGISTRY_POLICY_WRITE_FAILED)
      }
      op.stage('save_registry')
      try {
        await saveRegistry(file, registryOut)
      } catch (error) {
        op.fail(CODES.REGISTRY_SAVE_FAILED, error, {
          state: 'partially_applied',
          remainingArtifacts: ['workspace_dir', 'identity_files', 'policy_json'],
          agentId: agent.agentId,
        })
        throw httpError(500, 'registry save failed', CODES.REGISTRY_SAVE_FAILED)
      }
      op.stage('register_preset')
      try {
        await supply.ensure(agent)
      } catch (error) {
        op.degraded(CODES.REGISTRY_PRESET_UNAVAILABLE, { agentId: agent.agentId, presetId: agent.dshPreset, reason: error && error.message })
        return withTrace({ agent, clawHome: clawHome(dshHome), presetError: error && error.message })
      }
      if (skippedOrphan) op.success({ agentId: agent.agentId, slug, code: CODES.REGISTRY_ORPHAN_SLUG_SKIPPED })
      else op.success({ agentId: agent.agentId, slug })
      return withTrace({ agent, clawHome: clawHome(dshHome) })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/preset/ensure',
    handle: async (body, request) => runWithTrace(request, async () => {
      const agentId = body && body.agentId
      if (typeof agentId !== 'string' || !agentId.startsWith('wa_')) {
        throw httpError(400, 'invalid agent id')
      }
      const loaded = await loadRegistry(registryFile(dshHome))
      const agent = loaded.agents[agentId]
      if (!agent) throw httpError(404, 'agent not found', CODES.REGISTRY_AGENT_NOT_FOUND)
      const op = operation({ plugin: 'dsh-claw-registry', feature: 'agent', operation: 'ensure_preset', agentId })
      try {
        const presetId = await supply.ensure(agent)
        return withTrace({ presetId })
      } catch (error) {
        op.start()
        op.fail(CODES.REGISTRY_PRESET_UNAVAILABLE, error, { presetId: agent.dshPreset })
        throw httpError(409, 'preset unavailable: ' + (error && error.message ? error.message : error), CODES.REGISTRY_PRESET_UNAVAILABLE)
      }
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/diag',
    handle: async (body, request) => runWithTrace(request, async () => {
      const code = body && body.code
      if (code !== CODES.REGISTRY_RESPONSE_STALE) {
        throw httpError(400, 'unsupported diag code')
      }
      const op = operation({
        plugin: 'dsh-claw-registry',
        feature: 'settings',
        operation: (body && body.operation) || 'client_event',
      })
      op.start()
      op.degraded(CODES.REGISTRY_RESPONSE_STALE, { skipReason: 'stale', state: 'clean' })
      return withTrace({})
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/policy',
    handle: async (body, request) => runWithTrace(request, async () => {
      const agentId = body && body.agentId
      if (typeof agentId !== 'string' || !agentId.startsWith('wa_')) {
        throw httpError(400, 'invalid agent id')
      }
      const file = registryFile(dshHome)
      const loaded = await loadRegistry(file)
      const op = operation({ plugin: 'dsh-claw-registry', feature: 'policy', operation: 'save_policy', agentId })
      op.start()
      const result = updateAgentPolicy(loaded, agentId, normalizePolicy(body && body.policy))
      if (!result.agent) {
        op.reject(CODES.REGISTRY_AGENT_NOT_FOUND)
        throw httpError(404, 'agent not found', CODES.REGISTRY_AGENT_NOT_FOUND)
      }
      op.stage('policy_write')
      try {
        if (result.agent.canonicalRoot && isClawHomePath(dshHome, result.agent.canonicalRoot)) {
          await writeFile(join(result.agent.canonicalRoot, 'policy.json'), JSON.stringify(result.agent.policy, null, 2) + '\n')
        }
      } catch (error) {
        op.fail(CODES.REGISTRY_POLICY_WRITE_FAILED, error, { state: 'clean', agentId })
        throw httpError(500, 'policy write failed', CODES.REGISTRY_POLICY_WRITE_FAILED)
      }
      try {
        await saveRegistry(file, result.registry)
      } catch (error) {
        op.fail(CODES.REGISTRY_SAVE_FAILED, error, {
          state: 'partially_applied',
          remainingArtifacts: ['policy_json'],
          agentId,
        })
        throw httpError(500, 'registry save failed', CODES.REGISTRY_SAVE_FAILED)
      }
      op.success({ agentId })
      return withTrace({ agent: result.agent })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/skills',
    handle: async (body, request) => runWithTrace(request, async () => {
      const agentId = body && body.agentId
      if (typeof agentId !== 'string' || !agentId.startsWith('wa_')) {
        throw httpError(400, 'invalid agent id')
      }
      const file = registryFile(dshHome)
      const loaded = await loadRegistry(file)
      const result = updateAgentSkills(loaded, agentId, body && body.deny)
      if (!result.agent) throw httpError(404, 'agent not found')
      if (result.agent.canonicalRoot && isClawHomePath(dshHome, result.agent.canonicalRoot)) {
        await writeFile(join(result.agent.canonicalRoot, 'policy.json'), JSON.stringify(result.agent.policy, null, 2) + '\n')
      }
      await saveRegistry(file, result.registry)
      return withTrace({ agent: result.agent })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/models',
    handle: async (_body, request) => runWithTrace(request, async () => {
      const official = normalizeModel(optionalService(ctx, 'agentDefaultModel') && optionalService(ctx, 'agentDefaultModel').currentSelection())
      const groups = await listModelCatalog(optionalService(ctx, 'llm'))
      return withTrace({ official, groups })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/model',
    handle: async (body, request) => runWithTrace(request, async () => {
      const agentId = body && body.agentId
      if (typeof agentId !== 'string' || !agentId.startsWith('wa_')) {
        throw httpError(400, 'invalid agent id')
      }
      const file = registryFile(dshHome)
      const loaded = await loadRegistry(file)
      const result = updateAgentModel(loaded, agentId, body && body.inherit === true ? null : body && body.model)
      if (!result.agent) throw httpError(404, 'agent not found')
      await saveRegistry(file, result.registry)
      return withTrace({ agent: result.agent })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/leave-behind',
    handle: async (body, request) => runWithTrace(request, async () => {
      const file = registryFile(dshHome)
      const loaded = await loadRegistry(file)
      const registry = await saveRegistry(file, setLeaveBehind(loaded, body && body.leaveBehind))
      try { writeLeavePlan(dshHome, registry, listWorkspaces(ctx)) } catch { /* plan is best-effort */ }
      return withTrace({ leaveBehind: registry.settings.leaveBehind })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/template',
    handle: async (body, request) => runWithTrace(request, async () => {
      const file = defaultsFile(dshHome)
      const loaded = loadDefaultsSync(file)
      const seed = body && body.seed
      if (seed && typeof seed.file === 'string') {
        await writeTemplateSeed(dshHome, seed.file, seed.content)
      }
      const template = await saveDefaults(file, {
        ...loaded,
        preset: body && body.preset != null ? body.preset : loaded.preset,
        mcp: body && body.mcp != null ? body.mcp : loaded.mcp,
        servers: body && body.servers ? body.servers : loaded.servers,
        policy: body && body.policy ? body.policy : loaded.policy,
        model: body && body.inheritModel === true ? null : (body && body.model !== undefined ? body.model : loaded.model),
        skills: body && body.skills ? body.skills : loaded.skills,
      })
      return withTrace({
        template: {
          ...template,
          seeds: readTemplateSeedsSync(dshHome),
          stockSeeds: seedFiles(''),
        },
      })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/restore',
    handle: async (body, request) => runWithTrace(request, async () => {
      const agentId = body && body.agentId
      if (typeof agentId !== 'string' || !agentId.startsWith('wa_')) {
        throw httpError(400, 'invalid agent id')
      }
      const file = registryFile(dshHome)
      const loaded = await loadRegistry(file)
      const result = restoreAgent(loaded, agentId)
      if (!result.agent) throw httpError(404, 'agent not found')
      await saveRegistry(file, result.registry)
      return withTrace({ agent: result.agent })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/session/bind',
    handle: async (body, request) => runWithTrace(request, async () => {
      const sessionId = body && body.sessionId
      const agentId = body && body.agentId
      if (!sessionId || typeof sessionId !== 'string' || !agentId || typeof agentId !== 'string' || !agentId.startsWith('wa_')) {
        throw httpError(400, 'invalid bind payload', 'REGISTRY_BIND_INVALID')
      }

      const file = registryFile(dshHome)
      const expectedRevision = body.expectedRevision

      const loaded = await loadRegistry(file)
      if (expectedRevision !== undefined && expectedRevision !== null) {
        if (Number(loaded.revision || 1) !== Number(expectedRevision)) {
          throw httpError(409, 'revision conflict', 'REGISTRY_REVISION_CONFLICT')
        }
      }

      const agent = loaded.agents[agentId]
      if (!agent) {
        throw httpError(404, 'agent not found', 'REGISTRY_AGENT_NOT_FOUND')
      }
      if (agent.status !== 'active') {
        throw httpError(409, 'agent is not active', 'REGISTRY_AGENT_NOT_FOUND')
      }

      const workspaces = listWorkspaces(ctx)
      const workspace = workspaces.find((w) => String(w.id != null ? w.id : w.workspaceId) === String(agent.workspaceId))
      if (!workspace) {
        throw httpError(409, 'workspace not found or mismatch', 'REGISTRY_WORKSPACE_MISMATCH')
      }

      const sessionController = optionalService(ctx, 'sessionController')
      if (sessionController && typeof sessionController.inspect === 'function') {
        let meta
        try {
          meta = await sessionController.inspect(sessionId)
        } catch {
          throw httpError(404, 'session cannot be inspected', 'REGISTRY_SESSION_NOT_FOUND')
        }
        if (!meta) {
          throw httpError(404, 'session cannot be inspected', 'REGISTRY_SESSION_NOT_FOUND')
        }
        if (agent.canonicalRoot && meta.cwd && !sameRoot(meta.cwd, agent.canonicalRoot)) {
          throw httpError(409, 'cwd does not match agent canonicalRoot', 'REGISTRY_WORKSPACE_MISMATCH')
        }
        if (agent.dshPreset && meta.agentPreset && meta.agentPreset !== agent.dshPreset) {
          throw httpError(409, 'agentPreset does not match agent dshPreset', 'REGISTRY_PRESET_MISMATCH')
        }
      }

      const existing = loaded.sessionBindings && loaded.sessionBindings[sessionId]
      if (existing) {
        if (existing.agentId === agentId && existing.workspaceId === agent.workspaceId) {
          return withTrace({
            revision: Number(loaded.revision) || 1,
            binding: existing,
            idempotent: true,
          })
        }
        throw httpError(409, 'session already bound to another agent', 'REGISTRY_BIND_CONFLICT')
      }

      let mutated
      try {
        mutated = await atomicMutateRegistry(file, expectedRevision, (reg) => {
          return bindSession(reg, {
            sessionId,
            agentId,
            workspaceId: agent.workspaceId,
            presetId: agent.dshPreset,
            source: body.source || 'create',
            state: body.state || 'ready',
          })
        })
      } catch (err) {
        if (err.code === 'REGISTRY_REVISION_CONFLICT') {
          throw httpError(409, err.message, 'REGISTRY_REVISION_CONFLICT')
        }
        throw httpError(500, err && err.message ? err.message : 'bind save failed', 'REGISTRY_BIND_SAVE_FAILED')
      }

      return withTrace({
        revision: mutated.revision,
        binding: mutated.binding,
      })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/session/state',
    handle: async (body, request) => runWithTrace(request, async () => {
      const sessionId = body && body.sessionId
      const state = body && body.state
      const validStates = ['provisioning', 'needs_model', 'ready']
      if (!sessionId || typeof sessionId !== 'string' || !validStates.includes(state)) {
        throw httpError(400, 'invalid session state payload', 'REGISTRY_BIND_INVALID')
      }

      const file = registryFile(dshHome)
      const expectedRevision = body.expectedRevision

      let mutated
      try {
        mutated = await atomicMutateRegistry(file, expectedRevision, (reg) => {
          const res = markBindingState(reg, sessionId, state)
          if (!res.binding) {
            const err = new Error('session binding not found')
            err.code = 'NOT_FOUND'
            throw err
          }
          return res
        })
      } catch (err) {
        if (err.code === 'NOT_FOUND') {
          throw httpError(404, 'session binding not found', 'REGISTRY_SESSION_NOT_FOUND')
        }
        if (err.code === 'REGISTRY_REVISION_CONFLICT') {
          throw httpError(409, err.message, 'REGISTRY_REVISION_CONFLICT')
        }
        throw httpError(500, err && err.message ? err.message : 'state save failed', 'REGISTRY_BIND_SAVE_FAILED')
      }

      return withTrace({
        revision: mutated.revision,
        binding: mutated.binding,
      })
    }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/registry/session/adopt',
    handle: async (body, request) => runWithTrace(request, async () => {
      const sessionId = body && body.sessionId
      const agentId = body && body.agentId
      if (!sessionId || typeof sessionId !== 'string' || !agentId || typeof agentId !== 'string' || !agentId.startsWith('wa_')) {
        throw httpError(400, 'invalid adopt payload', 'REGISTRY_BIND_INVALID')
      }

      const file = registryFile(dshHome)
      const expectedRevision = body.expectedRevision

      const loaded = await loadRegistry(file)
      if (expectedRevision !== undefined && expectedRevision !== null) {
        if (Number(loaded.revision || 1) !== Number(expectedRevision)) {
          throw httpError(409, 'revision conflict', 'REGISTRY_REVISION_CONFLICT')
        }
      }

      const agent = loaded.agents[agentId]
      if (!agent) {
        throw httpError(404, 'agent not found', 'REGISTRY_AGENT_NOT_FOUND')
      }
      if (agent.status !== 'active') {
        throw httpError(409, 'agent is not active', 'REGISTRY_AGENT_NOT_FOUND')
      }

      const workspaces = listWorkspaces(ctx)
      const workspace = workspaces.find((w) => String(w.id != null ? w.id : w.workspaceId) === String(agent.workspaceId))
      if (!workspace) {
        throw httpError(409, 'workspace not found or mismatch', 'REGISTRY_WORKSPACE_MISMATCH')
      }

      const sessionController = optionalService(ctx, 'sessionController')
      if (sessionController && typeof sessionController.inspect === 'function') {
        let meta
        try {
          meta = await sessionController.inspect(sessionId)
        } catch {
          throw httpError(404, 'session cannot be inspected', 'REGISTRY_SESSION_NOT_FOUND')
        }
        if (!meta) {
          throw httpError(404, 'session cannot be inspected', 'REGISTRY_SESSION_NOT_FOUND')
        }
        if (agent.canonicalRoot && meta.cwd && !sameRoot(meta.cwd, agent.canonicalRoot)) {
          throw httpError(409, 'cwd does not match agent canonicalRoot', 'REGISTRY_WORKSPACE_MISMATCH')
        }
        if (agent.dshPreset && meta.agentPreset && meta.agentPreset !== agent.dshPreset) {
          throw httpError(409, 'agentPreset does not match agent dshPreset', 'REGISTRY_PRESET_MISMATCH')
        }
      }

      let mutated
      try {
        mutated = await atomicMutateRegistry(file, expectedRevision, (reg) => {
          return resolveSessionRepair(reg, sessionId, agentId)
        })
      } catch (err) {
        if (err.code === 'REGISTRY_REVISION_CONFLICT') {
          throw httpError(409, err.message, 'REGISTRY_REVISION_CONFLICT')
        }
        throw httpError(500, err && err.message ? err.message : 'adopt save failed', 'REGISTRY_BIND_SAVE_FAILED')
      }

      return withTrace({
        revision: mutated.revision,
        binding: mutated.binding,
      })
    }),
  })

  ctx.effect(() => () => {
    try {
      if (!shouldApplyLeaveBehind(readProfilePackageSync(dshHome))) return
      const registry = loadRegistrySync(registryFile(dshHome))
      const payload = {
        home: dshHome,
        registry,
        workspaces: listWorkspaces(ctx),
        workspaceRegistry: ctx.workspaceRegistry,
        mode: registry.settings && registry.settings.leaveBehind,
      }
      applyLeaveBehindOffline(payload)
      void applyLeaveBehind(payload)
    } catch { /* uninstall cleanup is best-effort */ }
  })

  void guardClawDefault(ctx)
  void registerKnownPresets(ctx, supply)
}

async function registerKnownPresets(ctx, supply) {
  let agents = []
  try {
    agents = Object.values(loadRegistrySync(registryFile(dshHome)).agents || {})
  } catch { return }
  const failed = await supply.ensureAll(agents)
  if (failed.length === 0) return
  const op = operation({ plugin: 'dsh-claw-registry', feature: 'agent', operation: 'register_presets' })
  op.start()
  op.degraded(CODES.REGISTRY_PRESET_UNAVAILABLE, {
    failed: failed.length,
    presets: failed.map((row) => row.presetId),
    reason: failed[0].error && failed[0].error.message,
  })
  if (ctx.logger && typeof ctx.logger.warn === 'function') {
    ctx.logger.warn('dsh-claw-registry: ' + failed.length + ' Claw preset(s) unavailable: ' + (failed[0].error && failed[0].error.message))
  }
}
