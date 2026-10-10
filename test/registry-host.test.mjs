import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, inject, name, _internal } from '../host.js'

_internal.migrateOnApply = false

function fakeConnection() {
  const routes = []
  return {
    routes,
    connection: {
      fetch: {
        register(entry) {
          routes.push(entry)
          return () => { entry.disposed = true }
        },
      },
    },
  }
}

const EXPECTED_PATHS = [
  '/api/dsh-claw/registry/list',
  '/api/dsh-claw/registry/explain',
  '/api/dsh-claw/registry/archive',
  '/api/dsh-claw/registry/rename',
  '/api/dsh-claw/registry/create',
  '/api/dsh-claw/registry/diag',
  '/api/dsh-claw/registry/policy',
  '/api/dsh-claw/registry/skills',
  '/api/dsh-claw/registry/models',
  '/api/dsh-claw/registry/model',
  '/api/dsh-claw/registry/leave-behind',
  '/api/dsh-claw/registry/template',
  '/api/dsh-claw/registry/restore',
  '/api/dsh-claw/registry/session/bind',
  '/api/dsh-claw/registry/session/state',
  '/api/dsh-claw/registry/session/adopt',
]

test('host named exports', () => {
  assert.equal(name, 'dsh-claw-registry')
  assert.deepEqual(inject, ['connection', 'workspaceRegistry', 'agentPresets', 'settings', 'sessionController'])
})

test('apply registers Connection Fetch routes and disposes them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dar-home-'))
  _internal.setDshHome(dir)
  const effects = []
  const { connection, routes } = fakeConnection()
  const ctx = {
    workspaceRegistry: { list() { return [] } },
    agentPresets: { list: async () => [], copy: async () => {}, authorable: true },
    connection,
    effect(factory) {
      effects.push(factory)
    },
  }
  apply(ctx)
  assert.equal(routes.length, 16)
  assert.deepEqual(routes.map((row) => row.path), EXPECTED_PATHS)
  for (const row of routes) {
    assert.deepEqual(row.methods, ['POST'])
    assert.equal(row.requestBody, 'buffered')
    assert.equal(typeof row.fetch, 'function')
  }
  // registerJsonRoute owns dispose (13 routes) + leave-behind cleanup effect
  assert.ok(effects.length >= 13)
  for (const factory of effects) {
    const dispose = factory()
    if (typeof dispose === 'function') dispose()
  }
  assert.ok(routes.every((row) => row.disposed === true))
})

test('list handler does not bind ordinary workspaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dar-home-'))
  _internal.setDshHome(dir)
  const copies = []
  const { connection, routes } = fakeConnection()
  const ctx = {
    workspaceRegistry: {
      list() {
        return [{ id: 'ws-a', path: '/tmp/project', title: 'Project', sessionIds: ['s1'] }]
      },
    },
    agentPresets: {
      authorable: true,
      defaultId: 'standard',
      async list() { return [{ id: 'minimal' }, { id: 'standard' }] },
      async copy(from, id) { copies.push({ from, id }) },
    },
    settings: {
      async mutate(ns, ops) { ctx._ops.push({ ns, ops }) },
    },
    connection,
    effect() {},
  }
  ctx._ops = []
  apply(ctx)
  const list = routes.find((row) => row.path === '/api/dsh-claw/registry/list')
  const res = await list.fetch(new Request('dsh-app://host/api/dsh-claw/registry/list', {
    method: 'POST',
    body: '{}',
  }))
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.agents.length, 0)
  assert.equal(copies.length, 0)
  assert.match(payload.clawHome, /DSclaw/)
})

test('host does not wrap agentPresets composition APIs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dar-home-'))
  _internal.setDshHome(dir)
  const resolve = async (id) => ({ id })
  const mount = async () => ({})
  const recompose = async () => ({})
  const standingKeyFor = async (id) => ({ agentPreset: id })
  const { connection } = fakeConnection()
  const ctx = {
    workspaceRegistry: { list() { return [] } },
    agentPresets: {
      defaultId: 'standard',
      authorable: true,
      async list() { return [{ id: 'standard' }] },
      resolve,
      mount,
      recompose,
      standingKeyFor,
      async copy() {},
    },
    connection,
    effect(factory) { ctx._stop = factory() },
  }
  apply(ctx)
  assert.equal(ctx.agentPresets.resolve, resolve)
  assert.equal(ctx.agentPresets.mount, mount)
  assert.equal(ctx.agentPresets.recompose, recompose)
  assert.equal(ctx.agentPresets.standingKeyFor, standingKeyFor)
  if (typeof ctx._stop === 'function') ctx._stop()
})

test('create skips a non-empty orphan directory instead of overwriting it', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'dar-home-'))
  _internal.setDshHome(dir)
  const orphan = join(dir, 'DSclaw', 'demo')
  await mkdir(orphan, { recursive: true })
  await writeFile(join(orphan, 'SOUL.md'), 'keep custom soul\n')
  const { connection, routes } = fakeConnection()
  const ctx = {
    workspaceRegistry: {
      list() { return [] },
      async create(path, title) {
        return { id: 'ws-new', path, title }
      },
    },
    agentPresets: { authorable: true, async list() { return [] }, async copy() {} },
    settings: { async mutate() {} },
    connection,
    effect() {},
  }
  apply(ctx)
  const create = routes.find((row) => row.path === '/api/dsh-claw/registry/create')
  const res = await create.fetch(new Request('dsh-app://host/api/dsh-claw/registry/create', {
    method: 'POST',
    body: JSON.stringify({ name: 'Demo' }),
  }))
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.agent.slug, 'demo-2')
  assert.equal(await readFile(join(orphan, 'SOUL.md'), 'utf8'), 'keep custom soul\n')
})

test('session bind, state transition, and CAS revision handling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dar-home-session-'))
  _internal.setDshHome(dir)
  const agentRoot = join(dir, 'DSclaw', 'agent-a')
  await mkdir(agentRoot, { recursive: true })

  const { connection, routes } = fakeConnection()
  const inspectedSessions = new Map([
    ['s-1', { cwd: agentRoot, agentPreset: 'wa-agent-a' }],
    ['s-mismatch', { cwd: '/other/path', agentPreset: 'wa-agent-a' }],
  ])

  const ctx = {
    workspaceRegistry: {
      list() {
        return [
          { id: 'ws-a', path: agentRoot, title: 'Agent A', sessionIds: ['s-1'] },
        ]
      },
    },
    agentPresets: { authorable: true, async list() { return [] }, async copy() {} },
    settings: { async mutate() {} },
    sessionController: {
      async inspect(sessionId) {
        const meta = inspectedSessions.get(sessionId)
        if (!meta) throw new Error('not found')
        return meta
      },
    },
    connection,
    effect() {},
  }
  apply(ctx)

  // Seed an agent in registry
  const { registryFile, saveRegistry, emptyRegistry } = await import('../registry-store.mjs')
  const baseReg = emptyRegistry()
  baseReg.agents['wa_a'] = {
    agentId: 'wa_a',
    workspaceId: 'ws-a',
    canonicalRoot: agentRoot,
    title: 'Agent A',
    slug: 'agent-a',
    dshPreset: 'wa-agent-a',
    preset: 'research',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await saveRegistry(registryFile(dir), baseReg)

  const bindRoute = routes.find((r) => r.path === '/api/dsh-claw/registry/session/bind')
  const stateRoute = routes.find((r) => r.path === '/api/dsh-claw/registry/session/state')

  // 1. Successful bind with CAS expectedRevision: 1
  const res1 = await bindRoute.fetch(new Request('dsh-app://host/api/dsh-claw/registry/session/bind', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 's-1',
      agentId: 'wa_a',
      workspaceId: 'ws-a',
      presetId: 'wa-agent-a',
      expectedRevision: 1,
      source: 'create',
    }),
  }))
  assert.equal(res1.status, 200)
  const data1 = await res1.json()
  assert.equal(data1.ok, true)
  assert.equal(data1.revision, 2)
  assert.equal(data1.binding.sessionId, 's-1')
  assert.equal(data1.binding.agentId, 'wa_a')
  assert.equal(data1.binding.state, 'ready')

  // 2. Idempotent rebind
  const resIdempotent = await bindRoute.fetch(new Request('dsh-app://host/api/dsh-claw/registry/session/bind', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 's-1',
      agentId: 'wa_a',
      workspaceId: 'ws-a',
      presetId: 'wa-agent-a',
      source: 'create',
    }),
  }))
  assert.equal(resIdempotent.status, 200)
  const dataIdempotent = await resIdempotent.json()
  assert.equal(dataIdempotent.idempotent, true)

  // 3. CAS conflict
  const resConflict = await bindRoute.fetch(new Request('dsh-app://host/api/dsh-claw/registry/session/bind', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 's-2',
      agentId: 'wa_a',
      workspaceId: 'ws-a',
      presetId: 'wa-agent-a',
      expectedRevision: 999,
    }),
  }))
  assert.equal(resConflict.status, 409)

  // 4. Session mismatch on inspect (wrong cwd)
  const resMismatch = await bindRoute.fetch(new Request('dsh-app://host/api/dsh-claw/registry/session/bind', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 's-mismatch',
      agentId: 'wa_a',
      workspaceId: 'ws-a',
      presetId: 'wa-agent-a',
      expectedRevision: 2,
    }),
  }))
  assert.equal(resMismatch.status, 409)

  // 5. State transition to needs_model
  const resState = await stateRoute.fetch(new Request('dsh-app://host/api/dsh-claw/registry/session/state', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 's-1',
      state: 'needs_model',
      expectedRevision: 2,
    }),
  }))
  assert.equal(resState.status, 200)
  const dataState = await resState.json()
  assert.equal(dataState.revision, 3)
  assert.equal(dataState.binding.state, 'needs_model')
})

