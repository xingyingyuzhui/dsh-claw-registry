import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bindingsForAgent,
  classifySession,
  isClawClaimed,
  repairCandidatesForAgent,
  repairCandidatesUnassigned,
} from '../registry-bindings.mjs'

test('bindingsForAgent filters bindings for matching agentId', () => {
  const projected = {
    sessionBindings: {
      's1': { sessionId: 's1', agentId: 'wa_1' },
      's2': { sessionId: 's2', agentId: 'wa_2' },
      's3': { sessionId: 's3', agentId: 'wa_1' },
    },
  }
  const b1 = bindingsForAgent(projected, 'wa_1')
  assert.equal(b1.length, 2)
  assert.deepEqual(b1.map((r) => r.sessionId).sort(), ['s1', 's3'])

  const bEmpty = bindingsForAgent(projected, 'wa_unknown')
  assert.deepEqual(bEmpty, [])
})

test('repairCandidates filters by suggestedAgentId and unassigned', () => {
  const projected = {
    agents: {
      wa_1: { agentId: 'wa_1' },
    },
    repairQueue: {
      'r1': { sessionId: 'r1', suggestedAgentId: 'wa_1' },
      'r2': { sessionId: 'r2', suggestedAgentId: 'wa_2' },
      'r3': { sessionId: 'r3', suggestedAgentId: null },
    },
  }
  const assigned = repairCandidatesForAgent(projected, 'wa_1')
  assert.equal(assigned.length, 1)
  assert.equal(assigned[0].sessionId, 'r1')

  const unassigned = repairCandidatesUnassigned(projected)
  assert.equal(unassigned.length, 2)
  assert.deepEqual(unassigned.map((r) => r.sessionId).sort(), ['r2', 'r3'])
})

test('classifySession returns ordinary, claw, and claw-uncertain', () => {
  const projected = {
    sessionBindings: {
      's-claw': { sessionId: 's-claw', agentId: 'wa_1' },
    },
    repairQueue: {
      's-repair': { sessionId: 's-repair', suggestedAgentId: 'wa_1' },
    },
  }

  assert.deepEqual(classifySession('s-claw', projected), {
    kind: 'claw',
    agentId: 'wa_1',
    binding: { sessionId: 's-claw', agentId: 'wa_1' },
  })
  assert.equal(isClawClaimed('s-claw', projected), true)

  const rep = classifySession('s-repair', projected)
  assert.equal(rep.kind, 'claw-uncertain')
  assert.equal(rep.candidate.sessionId, 's-repair')
  assert.equal(isClawClaimed('s-repair', projected), true)

  assert.deepEqual(classifySession('s-other', projected), { kind: 'ordinary' })
  assert.equal(isClawClaimed('s-other', projected), false)
})
