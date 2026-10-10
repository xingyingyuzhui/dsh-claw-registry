// Durable workspace ↔ agent bindings. Pure + filesystem. No tool gating.

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { clampClawPolicy, declaredOf, INIT_PRESET, normalizePolicy, presetIdForWorkspace } from './registry-presets.mjs'
import { normalizeLeaveBehind } from './registry-leave.mjs'
import { normalizeModel } from './registry-model.mjs'

export function defaultDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function registryFile(home) {
  return join(home || defaultDshHome(), 'workspace-agents', 'registry.json')
}

export function agentIdForWorkspace(workspaceId) {
  return 'wa_' + String(workspaceId)
}

export function emptyRegistry(now = new Date().toISOString()) {
  return {
    version: 2,
    revision: 1,
    main: { agentId: 'main', createdAt: now },
    settings: { leaveBehind: 'archive' },
    agents: {},
    sessionBindings: {},
    repairQueue: {},
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function normalizeSessionBinding(raw, fallbackSessionId) {
  const value = asObject(raw)
  const sessionId = typeof value.sessionId === 'string' && value.sessionId
    ? value.sessionId
    : fallbackSessionId
  if (!sessionId) return null
  const agentId = typeof value.agentId === 'string' ? value.agentId : ''
  if (!agentId) return null
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : ''
  const presetId = typeof value.presetId === 'string' ? value.presetId : ''
  const validStates = ['provisioning', 'needs_model', 'ready']
  const state = validStates.includes(value.state) ? value.state : 'ready'
  const validSources = ['create', 'adopt', 'migration']
  const source = validSources.includes(value.source) ? value.source : 'create'
  const now = new Date().toISOString()
  return {
    sessionId,
    agentId,
    workspaceId,
    presetId,
    state,
    source,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
  }
}

export function normalizeRepairCandidate(raw, fallbackSessionId) {
  const value = asObject(raw)
  const sessionId = typeof value.sessionId === 'string' && value.sessionId
    ? value.sessionId
    : fallbackSessionId
  if (!sessionId) return null
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : ''
  const suggestedAgentId = typeof value.suggestedAgentId === 'string' ? value.suggestedAgentId : ''
  const reason = typeof value.reason === 'string' ? value.reason : 'missing-preset-evidence'
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter((e) => typeof e === 'string') : []
  const now = new Date().toISOString()
  return {
    sessionId,
    workspaceId,
    suggestedAgentId,
    reason,
    evidence,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
  }
}

export function normalizeRegistry(raw) {
  const value = asObject(raw)
  const main = asObject(value.main)
  const agentsIn = asObject(value.agents)
  const agents = {}
  for (const [key, row] of Object.entries(agentsIn)) {
    const agent = normalizeAgent(row, key)
    if (agent) agents[agent.agentId] = agent
  }
  const settingsIn = asObject(value.settings)

  const sessionBindingsIn = asObject(value.sessionBindings)
  const sessionBindings = {}
  for (const [key, row] of Object.entries(sessionBindingsIn)) {
    const binding = normalizeSessionBinding(row, key)
    if (binding && agents[binding.agentId]) {
      const targetAgent = agents[binding.agentId]
      binding.workspaceId = targetAgent.workspaceId
      binding.presetId = targetAgent.dshPreset
      sessionBindings[binding.sessionId] = binding
    }
  }

  const repairQueueIn = asObject(value.repairQueue)
  const repairQueue = {}
  for (const [key, row] of Object.entries(repairQueueIn)) {
    const candidate = normalizeRepairCandidate(row, key)
    if (candidate && !sessionBindings[candidate.sessionId]) {
      repairQueue[candidate.sessionId] = candidate
    }
  }

  const revision = Number.isFinite(Number(value.revision)) ? Math.max(1, Math.floor(Number(value.revision))) : 1

  return {
    version: 2,
    revision,
    main: {
      agentId: 'main',
      createdAt: typeof main.createdAt === 'string' ? main.createdAt : new Date().toISOString(),
    },
    settings: {
      leaveBehind: normalizeLeaveBehind(settingsIn.leaveBehind),
    },
    agents,
    sessionBindings,
    repairQueue,
  }
}

export function normalizeAgent(raw, fallbackId) {
  const value = asObject(raw)
  const workspaceId = value.workspaceId != null ? String(value.workspaceId) : ''
  if (!workspaceId) return null
  const agentId = typeof value.agentId === 'string' && value.agentId
    ? value.agentId
    : (fallbackId || agentIdForWorkspace(workspaceId))
  const now = new Date().toISOString()
  return {
    agentId,
    workspaceId,
    canonicalRoot: typeof value.canonicalRoot === 'string' ? value.canonicalRoot : '',
    title: typeof value.title === 'string' ? value.title : '',
    slug: typeof value.slug === 'string' ? value.slug : '',
    kind: 'claw',
    preset: value.preset === undefined ? INIT_PRESET : String(value.preset),
    dshPreset: typeof value.dshPreset === 'string' && value.dshPreset
      ? value.dshPreset
      : presetIdForWorkspace(workspaceId),
    policyVersion: Number.isFinite(Number(value.policyVersion)) ? Number(value.policyVersion) : 1,
    policy: value.policy == null ? null : normalizePolicy(value.policy, value.preset === undefined ? INIT_PRESET : value.preset),
    model: normalizeModel(value.model),
    status: value.status === 'archived' ? 'archived' : 'active',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
  }
}

export function bindingsForAgent(registryOrBindings, agentId) {
  if (!registryOrBindings || !agentId) return []
  const bindings = registryOrBindings.sessionBindings || registryOrBindings
  if (!bindings || typeof bindings !== 'object') return []
  return Object.values(bindings).filter((b) => b && b.agentId === agentId)
}

export function bindingForSession(registryOrBindings, sessionId) {
  if (!registryOrBindings || !sessionId) return null
  const bindings = registryOrBindings.sessionBindings || registryOrBindings
  if (!bindings || typeof bindings !== 'object') return null
  return bindings[sessionId] || null
}

export function bindSession(registry, input, now = new Date().toISOString()) {
  const normalized = normalizeSessionBinding(input)
  if (!normalized) return { registry, binding: null, error: 'invalid_binding_payload' }
  const agent = registry.agents[normalized.agentId]
  if (!agent) return { registry, binding: null, error: 'agent_not_found' }
  if (normalized.workspaceId && agent.workspaceId && normalized.workspaceId !== agent.workspaceId) {
    return { registry, binding: null, error: 'workspace_mismatch' }
  }
  if (normalized.presetId && agent.dshPreset && normalized.presetId !== agent.dshPreset) {
    return { registry, binding: null, error: 'preset_mismatch' }
  }

  const existing = registry.sessionBindings && registry.sessionBindings[normalized.sessionId]
  if (existing) {
    if (existing.agentId === normalized.agentId && existing.workspaceId === agent.workspaceId) {
      return { registry, binding: existing, idempotent: true }
    }
    return { registry, binding: null, error: 'session_already_bound' }
  }

  const sessionBindings = {
    ...registry.sessionBindings,
    [normalized.sessionId]: {
      ...normalized,
      workspaceId: agent.workspaceId,
      presetId: agent.dshPreset,
      updatedAt: now,
    },
  }

  let repairQueue = registry.repairQueue
  if (repairQueue && repairQueue[normalized.sessionId]) {
    repairQueue = { ...repairQueue }
    delete repairQueue[normalized.sessionId]
  }

  const nextRegistry = {
    ...registry,
    revision: (Number(registry.revision) || 1) + 1,
    sessionBindings,
    repairQueue,
  }

  return { registry: nextRegistry, binding: sessionBindings[normalized.sessionId] }
}

export function markBindingState(registry, sessionId, state, now = new Date().toISOString()) {
  const current = registry.sessionBindings && registry.sessionBindings[sessionId]
  if (!current) return { registry, binding: null }
  const validStates = ['provisioning', 'needs_model', 'ready']
  if (!validStates.includes(state)) return { registry, binding: null }
  if (current.state === state) return { registry, binding: current }
  const binding = { ...current, state, updatedAt: now }
  const sessionBindings = { ...registry.sessionBindings, [sessionId]: binding }
  return {
    registry: {
      ...registry,
      revision: (Number(registry.revision) || 1) + 1,
      sessionBindings,
    },
    binding,
  }
}

export function unbindSession(registry, sessionId, now = new Date().toISOString()) {
  if (!registry.sessionBindings || !registry.sessionBindings[sessionId]) {
    return { registry, removed: false }
  }
  const sessionBindings = { ...registry.sessionBindings }
  delete sessionBindings[sessionId]
  return {
    registry: {
      ...registry,
      revision: (Number(registry.revision) || 1) + 1,
      sessionBindings,
    },
    removed: true,
  }
}

export function queueSessionRepair(registry, candidate, now = new Date().toISOString()) {
  const normalized = normalizeRepairCandidate(candidate)
  if (!normalized) return { registry, candidate: null }
  if (registry.sessionBindings && registry.sessionBindings[normalized.sessionId]) {
    return { registry, candidate: null }
  }
  const repairQueue = { ...registry.repairQueue, [normalized.sessionId]: normalized }
  return {
    registry: {
      ...registry,
      revision: (Number(registry.revision) || 1) + 1,
      repairQueue,
    },
    candidate: normalized,
  }
}

export function resolveSessionRepair(registry, sessionId, agentId, now = new Date().toISOString()) {
  const item = registry.repairQueue && registry.repairQueue[sessionId]
  if (!item) return { registry, binding: null, error: 'repair_item_not_found' }
  const targetAgentId = agentId || item.suggestedAgentId
  const agent = registry.agents[targetAgentId]
  if (!agent) return { registry, binding: null, error: 'agent_not_found' }
  return bindSession(registry, {
    sessionId,
    agentId: targetAgentId,
    workspaceId: agent.workspaceId,
    presetId: agent.dshPreset,
    source: 'adopt',
    state: 'ready',
  }, now)
}

export function computeClaims(registry, workspaces = []) {
  const byId = new Map()
  for (const ws of workspaces || []) {
    if (ws && (ws.id != null || ws.workspaceId != null)) {
      byId.set(String(ws.id != null ? ws.id : ws.workspaceId), ws)
    }
  }

  const wsSet = new Set()
  const sessSet = new Set()

  for (const agent of Object.values(registry.agents || {})) {
    if (agent.status === 'active' && agent.workspaceId) {
      wsSet.add(String(agent.workspaceId))
      const ws = byId.get(String(agent.workspaceId))
      if (ws && Array.isArray(ws.sessionIds)) {
        for (const sid of ws.sessionIds) {
          if (sid) sessSet.add(String(sid))
        }
      }
    }
  }

  for (const binding of Object.values(registry.sessionBindings || {})) {
    if (binding && binding.sessionId) {
      sessSet.add(String(binding.sessionId))
    }
  }

  return {
    workspaceIds: [...wsSet].sort(),
    sessionIds: [...sessSet].sort(),
  }
}

export function refreshBinding(registry, workspace, now = new Date().toISOString()) {
  const workspaceId = String(workspace.id)
  const current = Object.values(registry.agents).find((row) => String(row.workspaceId) === workspaceId)
  if (!current) return { registry, agent: null, changed: false }
  const title = workspace.title != null ? String(workspace.title) : current.title
  const root = workspace.path != null ? String(workspace.path) : current.canonicalRoot
  if (title === current.title && root === current.canonicalRoot) {
    return { registry, agent: current, changed: false }
  }
  const agent = { ...current, title, canonicalRoot: root, updatedAt: now }
  return {
    registry: {
      ...registry,
      revision: (Number(registry.revision) || 1) + 1,
      agents: { ...registry.agents, [current.agentId]: agent },
    },
    agent,
    changed: true,
  }
}

export function ensureBinding(registry, workspace, now = new Date().toISOString()) {
  const workspaceId = String(workspace.id)
  const agentId = agentIdForWorkspace(workspaceId)
  const current = registry.agents[agentId]
  if (current) {
    const title = workspace.title != null ? String(workspace.title) : current.title
    const root = workspace.path != null ? String(workspace.path) : current.canonicalRoot
    const dshPreset = current.dshPreset || presetIdForWorkspace(workspaceId)
    if (title === current.title && root === current.canonicalRoot && current.dshPreset === dshPreset) {
      return { registry, agent: current, created: false, changed: false }
    }
    const agent = { ...current, title, canonicalRoot: root, dshPreset, updatedAt: now }
    return {
      registry: {
        ...registry,
        revision: (Number(registry.revision) || 1) + 1,
        agents: { ...registry.agents, [agentId]: agent },
      },
      agent,
      created: false,
      changed: true,
    }
  }
  const agent = {
    agentId,
    workspaceId,
    canonicalRoot: workspace.path != null ? String(workspace.path) : '',
    title: workspace.title != null ? String(workspace.title) : '',
    preset: INIT_PRESET,
    dshPreset: presetIdForWorkspace(workspaceId),
    policyVersion: 1,
    model: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  return {
    registry: {
      ...registry,
      revision: (Number(registry.revision) || 1) + 1,
      agents: { ...registry.agents, [agentId]: agent },
    },
    agent,
    created: true,
    changed: true,
  }
}

export function setAgentPolicy(registry, agentId, policy, now = new Date().toISOString()) {
  const current = registry.agents[agentId]
  if (!current) return { registry, agent: null }
  const nextPolicy = clampClawPolicy(normalizePolicy(policy, current.preset))
  const agent = {
    ...current,
    preset: nextPolicy.preset,
    policy: nextPolicy,
    policyVersion: (Number(current.policyVersion) || 1) + 1,
    updatedAt: now,
  }
  return {
    registry: {
      ...registry,
      revision: (Number(registry.revision) || 1) + 1,
      agents: { ...registry.agents, [agentId]: agent },
    },
    agent,
  }
}

export function setAgentModel(registry, agentId, selection, now = new Date().toISOString()) {
  const current = registry.agents[agentId]
  if (!current) return { registry, agent: null }
  const model = normalizeModel(selection)
  const agent = { ...current, model, updatedAt: now }
  return {
    registry: {
      ...registry,
      revision: (Number(registry.revision) || 1) + 1,
      agents: { ...registry.agents, [agentId]: agent },
    },
    agent,
  }
}

export function setAgentSkills(registry, agentId, deny, now = new Date().toISOString()) {
  const current = registry.agents[agentId]
  if (!current) return { registry, agent: null }
  const base = clampClawPolicy(normalizePolicy(current.policy || { preset: current.preset }, current.preset))
  const names = Array.isArray(deny) ? deny.filter((item) => typeof item === 'string' && item) : []
  return setAgentPolicy(registry, agentId, { ...base, skills: { deny: names } }, now)
}

export function setStatus(registry, agentId, status, now = new Date().toISOString()) {
  const current = registry.agents[agentId]
  if (!current) return { registry, agent: null }
  if (current.status === status) return { registry, agent: current }
  const agent = { ...current, status, updatedAt: now }
  return {
    registry: {
      ...registry,
      revision: (Number(registry.revision) || 1) + 1,
      agents: { ...registry.agents, [agentId]: agent },
    },
    agent,
  }
}

export function projectAgent(agent, workspace, sessionBindings = {}) {
  const declared = { ...clampClawPolicy(agent.policy ? normalizePolicy(agent.policy, agent.preset) : declaredOf(agent.preset)), enforced: false }
  const live = workspace != null
  const bindings = bindingsForAgent(sessionBindings, agent.agentId)
  const sessionIds = bindings.map((row) => row.sessionId)
  const sessionCount = bindings.length
  return {
    ...agent,
    title: live ? workspace.title : agent.title,
    canonicalRoot: live ? workspace.path : agent.canonicalRoot,
    sessionIds,
    sessionCount,
    workspacePresent: live,
    declared,
  }
}

export function loadRegistrySync(file) {
  try {
    return normalizeRegistry(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyRegistry()
    throw error
  }
}

export async function loadRegistry(file) {
  try {
    const text = await readFile(file, 'utf8')
    return normalizeRegistry(JSON.parse(text))
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyRegistry()
    throw error
  }
}

const registryQueues = new Map()

function enqueueRegistry(file, fn) {
  const prev = registryQueues.get(file) || Promise.resolve()
  const next = prev.then(fn, fn)
  registryQueues.set(file, next.then(() => {}, () => {}))
  return next
}

async function saveRegistryInternal(file, next) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return next
}

export async function saveRegistry(file, registry) {
  const next = normalizeRegistry(registry)
  return enqueueRegistry(file, async () => {
    return saveRegistryInternal(file, next)
  })
}

export async function atomicMutateRegistry(file, expectedRevision, mutateFn) {
  return enqueueRegistry(file, async () => {
    const loaded = await loadRegistry(file)
    const currentRev = Number(loaded.revision) || 1
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (currentRev !== Number(expectedRevision)) {
        const conflict = new Error(`Revision conflict: expected ${expectedRevision}, current is ${currentRev}`)
        conflict.code = 'REGISTRY_REVISION_CONFLICT'
        conflict.currentRevision = currentRev
        throw conflict
      }
    }
    const mutated = await mutateFn(loaded)
    const nextRegistry = mutated.registry || mutated
    const nextWithRevision = {
      ...nextRegistry,
      revision: currentRev + 1,
    }
    const saved = await saveRegistryInternal(file, normalizeRegistry(nextWithRevision))
    return {
      registry: saved,
      revision: saved.revision,
      ...(mutated.result ? mutated.result : {}),
      binding: mutated.binding,
      candidate: mutated.candidate,
      idempotent: mutated.idempotent,
    }
  })
}
