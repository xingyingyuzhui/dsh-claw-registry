/**
 * Claw Browser Mode registration and claims store for ui-workspace.
 * Enforces hard gate barrier on older DSH without registerBrowserMode.
 */

import { createClawBrowser } from './registry-claw-browser.mjs'

export function createClaimsStore(getClaims) {
  const listeners = new Set()
  return {
    getSnapshot() {
      const c = getClaims()
      return {
        workspaceIds: (c && Array.isArray(c.workspaceIds)) ? c.workspaceIds : [],
        sessionIds: (c && Array.isArray(c.sessionIds)) ? c.sessionIds : [],
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notify() {
      for (const fn of listeners) {
        try { fn() } catch { /* listener */ }
      }
    },
  }
}

export function registerIncompatibleNotice(ctx, React, t) {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[dsh-claw-registry]', t('incompatibleDsh'))
  }
  // Hard barrier: Do NOT register legacy global panel fallback
}

export function registerClawBrowserMode(ctx, React, shared) {
  const t = shared.t
  if (!ctx.uiWorkspace || typeof ctx.uiWorkspace.registerBrowserMode !== 'function') {
    registerIncompatibleNotice(ctx, React, t)
    return function () {}
  }

  const claimsStore = createClaimsStore(() => {
    const p = shared.getProjected()
    return p && p.claims
  })

  const unsubProjected = shared.subscribeProjected(() => {
    claimsStore.notify()
  })

  const ClawBrowser = createClawBrowser(React, shared)

  const stopMode = ctx.uiWorkspace.registerBrowserMode({
    id: 'dsh-claw',
    order: 100,
    label: () => t('zoneClaw'),
    claims: claimsStore,
    component: ClawBrowser,
    startSession: () => shared.requestClawSession(),
  })

  return function dispose() {
    unsubProjected()
    if (typeof stopMode === 'function') stopMode()
  }
}
