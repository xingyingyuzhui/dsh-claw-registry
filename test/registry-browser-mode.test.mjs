import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createClaimsStore,
  registerClawBrowserMode,
} from '../registry-browser-mode.mjs'

test('createClaimsStore snapshot and notification', () => {
  let claimsData = { workspaceIds: ['ws-1'], sessionIds: ['s-1'] }
  const store = createClaimsStore(() => claimsData)

  assert.deepEqual(store.getSnapshot(), {
    workspaceIds: ['ws-1'],
    sessionIds: ['s-1'],
  })

  let notifications = 0
  const unsub = store.subscribe(() => {
    notifications += 1
  })

  claimsData = { workspaceIds: ['ws-1', 'ws-2'], sessionIds: ['s-1', 's-2'] }
  store.notify()

  assert.equal(notifications, 1)
  assert.deepEqual(store.getSnapshot(), {
    workspaceIds: ['ws-1', 'ws-2'],
    sessionIds: ['s-1', 's-2'],
  })

  unsub()
  store.notify()
  assert.equal(notifications, 1)
})

test('registerClawBrowserMode hard gate when registerBrowserMode is missing', () => {
  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args)

  try {
    const ctx = {
      uiWorkspace: {}, // No registerBrowserMode!
    }
    const shared = {
      t: (k) => k,
      getProjected: () => null,
      subscribeProjected: () => () => {},
      requestClawSession: () => {},
    }

    const dispose = registerClawBrowserMode(ctx, null, shared)
    assert.equal(typeof dispose, 'function')
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].some((w) => String(w).includes('incompatibleDsh')))
  } finally {
    console.warn = origWarn
  }
})

test('registerClawBrowserMode registers mode and handles claims and startSession', () => {
  let registeredDef = null
  let unregisterCalled = false

  const ctx = {
    uiWorkspace: {
      registerBrowserMode(def) {
        registeredDef = def
        return () => { unregisterCalled = true }
      },
    },
  }

  let projectedData = {
    claims: { workspaceIds: ['ws-claw-1'], sessionIds: ['sess-claw-1'] },
  }
  let projectedSubscribers = []
  let sessionRequested = false

  const shared = {
    t: (k) => k === 'zoneClaw' ? 'Claw Agent' : k,
    getProjected: () => projectedData,
    subscribeProjected: (fn) => {
      projectedSubscribers.push(fn)
      return () => {
        projectedSubscribers = projectedSubscribers.filter((s) => s !== fn)
      }
    },
    requestClawSession: () => {
      sessionRequested = true
    },
  }

  const dispose = registerClawBrowserMode(ctx, null, shared)

  assert.ok(registeredDef)
  assert.equal(registeredDef.id, 'dsh-claw')
  assert.equal(registeredDef.order, 100)
  assert.equal(registeredDef.label(), 'Claw Agent')

  // Claims store works
  assert.deepEqual(registeredDef.claims.getSnapshot(), {
    workspaceIds: ['ws-claw-1'],
    sessionIds: ['sess-claw-1'],
  })

  // startSession triggers requestClawSession
  registeredDef.startSession()
  assert.equal(sessionRequested, true)

  // Dispose unregisters mode
  dispose()
  assert.equal(unregisterCalled, true)
  assert.equal(projectedSubscribers.length, 0)
})
