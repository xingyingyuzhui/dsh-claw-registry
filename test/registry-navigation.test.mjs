import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createClawSession,
  createNavigation,
  partialCreateError,
  unwrapRemote,
} from '../registry-navigation.mjs'

test('unwrapRemote returns value on ok', () => {
  assert.deepEqual(unwrapRemote({ ok: true, value: { sessionId: 's1' } }), { sessionId: 's1' })
})

test('unwrapRemote throws on failure', () => {
  assert.throws(() => unwrapRemote({ ok: false, error: { code: 'X', message: 'nope' } }), /nope/)
})

test('partialCreateError carries sessionId and stage', () => {
  const err = partialCreateError({ sessionId: 's9', stage: 'select-model', cause: new Error('boom') })
  assert.equal(err.name, 'ClawPartialCreateError')
  assert.equal(err.sessionId, 's9')
  assert.equal(err.stage, 'select-model')
  assert.ok(err.actions.includes('retry'))
})

test('createClawSession happy path', async () => {
  const opened = []
  const refreshed = []
  const created = []
  const models = []
  const bindings = []
  const ctx = {
    remote: {
      session: {
        async create(payload) {
          created.push(payload)
          return { ok: true, value: { sessionId: 'sess-1', agentPreset: payload.agentPreset } }
        },
        async selectModel(payload) {
          models.push(payload)
          return { ok: true, value: {} }
        },
      },
    },
    sessions: {
      async refresh() { refreshed.push(1) },
    },
    uiWorkspace: {
      openSession(id) { opened.push(id) },
    },
  }
  const id = await createClawSession(ctx, {
    id: 'wa_a',
    presetId: 'wa-a',
    defaultModel: { provider: 'deepseek', model: 'deepseek-chat' },
  }, 'ws-1', {
    async persistSessionBinding(info) { bindings.push(info) },
    async requireAgentPresetReady(agent) {
      assert.equal(agent.presetId, 'wa-a')
    },
  })
  assert.equal(id, 'sess-1')
  assert.equal(created[0].workspaceId, 'ws-1')
  assert.equal(created[0].agentPreset, 'wa-a')
  assert.ok(created[0].sessionId)
  assert.deepEqual(models[0], {
    sessionId: 'sess-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  assert.deepEqual(bindings, [{ sessionId: 'sess-1', agentId: 'wa_a', presetId: 'wa-a' }])
  assert.deepEqual(refreshed, [1])
  assert.deepEqual(opened, ['sess-1'])
})

test('createClawSession fails closed on preset mismatch', async () => {
  const ctx = {
    remote: {
      session: {
        async create() {
          return { ok: true, value: { sessionId: 'sess-x', agentPreset: 'standard' } }
        },
      },
    },
  }
  await assert.rejects(
    () => createClawSession(ctx, { id: 'wa_a', presetId: 'wa-a' }, 'ws-1'),
    (err) => err.name === 'ClawPartialCreateError' && err.sessionId === 'sess-x' && err.stage === 'verify-preset',
  )
})

test('createClawSession model failure returns ClawPartialCreateError with sessionId', async () => {
  const ctx = {
    remote: {
      session: {
        async create() {
          return { ok: true, value: { sessionId: 'sess-m', agentPreset: 'wa-a' } }
        },
        async selectModel() {
          return { ok: false, error: { message: 'model denied' } }
        },
      },
    },
  }
  await assert.rejects(
    () => createClawSession(ctx, {
      id: 'wa_a',
      presetId: 'wa-a',
      defaultModel: { provider: 'p', model: 'm' },
    }, 'ws-1'),
    (err) => err.name === 'ClawPartialCreateError'
      && err.sessionId === 'sess-m'
      && err.stage === 'select-model',
  )
})

test('navigation open/fork/archive use uiWorkspace and sessions only', async () => {
  const calls = []
  const nav = createNavigation({
    uiWorkspace: {
      startSession(id) { calls.push(['start', id]) },
      openSession(id) { calls.push(['open', id]) },
      archiveSession(id, opts) { calls.push(['archive', id, opts]) },
    },
    sessions: {
      async fork(payload) {
        calls.push(['fork', payload.sessionId])
        return 'child-1'
      },
    },
  })
  nav.startSession('ws')
  nav.openSession('s1')
  await nav.forkSession('s1')
  nav.archiveSession('s1', { reason: 'test' })
  assert.deepEqual(calls, [
    ['start', 'ws'],
    ['open', 's1'],
    ['fork', 's1'],
    ['open', 'child-1'],
    ['archive', 's1', { reason: 'test' }],
  ])
})
