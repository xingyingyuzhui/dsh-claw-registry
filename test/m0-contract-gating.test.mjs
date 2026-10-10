import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { projectAgent } from '../registry-store.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'client.js')
const src = readFileSync(dest, 'utf8')

test('M0 Gating 1: Client bundle must not register global sidebar.panellist or main panel', () => {
  // Plan §1.1, §2.1, §11.4: Claw is not a global panel, must not register sidebar.panellist or main
  assert.doesNotMatch(
    src,
    /sidebar\.panellist/,
    'client.js must not register sidebar.panellist (Claw must be a Workspace Browser mode)'
  )
  assert.doesNotMatch(
    src,
    /name:\s*'main'/,
    'client.js must not register main page panel'
  )
})

test('M0 Gating 2: Client bundle must register uiWorkspace.registerBrowserMode', () => {
  // Plan §5, §8.2, §11.4: Claw must register as a BrowserMode
  assert.match(
    src,
    /registerBrowserMode/,
    'client.js must invoke registerBrowserMode on uiWorkspace'
  )
})

test('M0 Gating 3: Client bundle must not register duplicate copy-id or session actions', () => {
  // Plan §2.5, §8.5, §11.4: Duplicate session actions must be removed
  assert.doesNotMatch(
    src,
    /dsh-claw-registry-copy-id/,
    'client.js must not register duplicate copy-id item'
  )
  assert.doesNotMatch(
    src,
    /registerSessionActions/,
    'client.js must not include registerSessionActions'
  )
})

test('M0 Gating 4: Client bundle must invoke transaction session bind route', () => {
  // Plan §7.2, §7.3, §11.4: Session creation must bind via Host API
  assert.match(
    src,
    /\/api\/dsh-claw\/registry\/session\/bind/,
    'client.js must post to /api/dsh-claw/registry/session/bind'
  )
})

test('M0 Gating 5: projectAgent must only project explicitly bound sessions, not raw workspace.sessionIds', () => {
  // Plan §2.2, §6.3, §11.1: Ordinary session in workspace must not become agent session without binding
  const agent = {
    agentId: 'wa_test',
    workspaceId: 'ws_1',
    canonicalRoot: '/test',
    title: 'Test',
    slug: 'test',
    preset: 'test',
    dshPreset: 'wa-test',
    status: 'active',
  }
  const workspace = {
    id: 'ws_1',
    title: 'Test Workspace',
    path: '/test',
    sessionIds: ['session-unbound-1', 'session-unbound-2'],
  }

  // Under new contract (§6.3), projectAgent requires sessionBindings and must not project unbound sessions
  const projected = projectAgent(agent, workspace, {})
  assert.deepEqual(
    projected.sessionIds,
    [],
    'projectAgent must not adopt workspace.sessionIds without explicit binding'
  )
  assert.equal(
    projected.sessionCount,
    0,
    'projectAgent sessionCount must be 0 when no explicit bindings exist'
  )
})
