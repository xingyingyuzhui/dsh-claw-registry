/**
 * Pure client projections for session bindings, repair candidates, and classifications.
 */

export function bindingsForAgent(projected, agentId) {
  if (!projected || !projected.sessionBindings || !agentId) return []
  return Object.values(projected.sessionBindings).filter(
    (row) => row && row.agentId === agentId
  )
}

export function repairCandidatesForAgent(projected, agentId) {
  if (!projected || !projected.repairQueue || !agentId) return []
  return Object.values(projected.repairQueue).filter(
    (row) => row && row.suggestedAgentId === agentId
  )
}

export function repairCandidatesUnassigned(projected) {
  if (!projected || !projected.repairQueue) return []
  const knownAgents = new Set(Object.keys(projected.agents || {}))
  return Object.values(projected.repairQueue).filter(
    (row) => !row || !row.suggestedAgentId || !knownAgents.has(row.suggestedAgentId)
  )
}

export function classifySession(sessionId, projected) {
  if (!sessionId || !projected) return { kind: 'ordinary' }
  const binding = projected.sessionBindings && projected.sessionBindings[sessionId]
  if (binding) {
    return {
      kind: 'claw',
      agentId: binding.agentId,
      binding,
    }
  }
  const candidate = projected.repairQueue && projected.repairQueue[sessionId]
  if (candidate) {
    return {
      kind: 'claw-uncertain',
      candidate,
    }
  }
  return { kind: 'ordinary' }
}

export function isClawClaimed(sessionId, projected) {
  return classifySession(sessionId, projected).kind !== 'ordinary'
}
