/**
 * M2 Client apply: slot registration, projected load, dispose.
 * No DOM observers for hide/filter; no workspace/preset list patches.
 */

import { COPY, interpolate, NS, tWith } from './registry-i18n.mjs'
import { ATTR, CSS } from './registry-styles.mjs'
import { agentForSession } from './registry-view.mjs'
import { createSettingsPage, registerSettings } from './registry-settings.mjs'
import { createTemplatePage } from './registry-template.mjs'
import { createNavigation } from './registry-navigation.mjs'
import { registerClawBrowserMode } from './registry-browser-mode.mjs'
import { registerSessionMark } from './registry-session-mark.mjs'
import { formatObserveFail, newTraceId } from './registry-observe.mjs'

export const ICON = '<svg data-dar-icon="1" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6" cy="5.5" r="2.2" stroke="currentColor" stroke-width="1.3"/><circle cx="10.5" cy="6.2" r="1.8" stroke="currentColor" stroke-width="1.3"/><path d="M2.6 13.2c.4-2.1 2-3.4 3.4-3.4s3 1.3 3.4 3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M9.2 12.6c.3-1.4 1.3-2.3 2.3-2.3 1 0 1.8.7 2.2 1.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

export function apply(ctx) {
  const React = require('react')
  const slots = ctx.get('slots')
  if (slots == null || React == null) return

  const doc = typeof document === 'undefined' ? null : document
  let styleTag = null
  if (doc && doc.head) {
    styleTag = doc.createElement('style')
    styleTag.setAttribute(ATTR, '')
    styleTag.textContent = CSS
    doc.head.appendChild(styleTag)
    doc.body.setAttribute(ATTR, '')
  }

  let localeDispose = function () {}
  try {
    if (ctx.locale && typeof ctx.locale.register === 'function') {
      localeDispose = ctx.locale.register(NS, COPY) || function () {}
    }
  } catch { /* remount */ }

  function t(key, params) {
    return interpolate(tWith(ctx, key, params), params)
  }

  function subscribeLocale(fn) {
    if (ctx.locale && typeof ctx.locale.subscribe === 'function') {
      return ctx.locale.subscribe(fn) || function () {}
    }
    return function () {}
  }

  function post(path, payload) {
    const traceId = newTraceId()
    return fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DSH-Trace': traceId,
      },
      body: JSON.stringify(payload || {}),
    }).then((res) => res.json().then((data) => {
      if (!res.ok && (!data || data.ok !== true)) {
        const error = new Error(formatObserveFail(data, 'http ' + res.status))
        error.code = data && data.code
        error.traceId = (data && data.traceId) || traceId
        throw error
      }
      return data
    }))
  }

  function toast(message) {
    if (!doc) return
    const existing = doc.querySelector('.dar-toast')
    if (existing) existing.remove()
    const el = document.createElement('div')
    el.className = 'dar-toast'
    el.textContent = message
    doc.body.appendChild(el)
    setTimeout(() => { if (el.parentNode) el.remove() }, 1800)
  }

  let ReactDOM = null
  try { ReactDOM = require('react-dom') } catch { /* optional */ }
  const Page = createSettingsPage(React, t, post, toast, subscribeLocale, ReactDOM)
  const TemplatePage = createTemplatePage(React, t, post, toast, subscribeLocale, ReactDOM)
  const stopSettings = registerSettings(ctx, React, t, Page, TemplatePage)

  let projected = null
  const projectedListeners = new Set()

  function notifyProjected() {
    for (const fn of projectedListeners) {
      try { fn(projected) } catch { /* listener */ }
    }
  }

  function subscribeProjected(fn) {
    if (typeof fn !== 'function') return function () {}
    projectedListeners.add(fn)
    return function () { projectedListeners.delete(fn) }
  }

  function loadProjected() {
    return post('/api/dsh-claw/registry/list', {}).then((next) => {
      projected = next
      notifyProjected()
      return next
    }).catch(() => {
      notifyProjected()
    })
  }

  const nav = createNavigation(ctx)

  function isBoundSession(sessionId) {
    return Boolean(agentForSession(projected, sessionId, null))
  }

  const newSessionListeners = new Set()
  function requestClawSession() {
    for (const fn of newSessionListeners) {
      try { fn() } catch { /* listener */ }
    }
  }

  function subscribeNewSessionRequest(fn) {
    if (typeof fn !== 'function') return function () {}
    newSessionListeners.add(fn)
    return function () { newSessionListeners.delete(fn) }
  }

  const shared = {
    NS,
    t,
    ctx,
    nav,
    post,
    toast,
    getProjected() { return projected },
    loadProjected,
    subscribeLocale,
    subscribeProjected,
    isBoundSession,
    requestClawSession,
    subscribeNewSessionRequest,
    createAgent(name) {
      return post('/api/dsh-claw/registry/create', { name }).then((data) => {
        toast(t('created', { name: (data.agent && data.agent.title) || name }))
        return loadProjected()
      }).catch((err) => {
        toast(String(err.message || t('fail')))
      })
    },
    renameAgent(agentId, name) {
      return post('/api/dsh-claw/registry/rename', { agentId, name }).then((data) => {
        const workspaceId = data && data.agent && data.agent.workspaceId
        if (workspaceId && ctx.workspaces && typeof ctx.workspaces.rename === 'function') {
          return Promise.resolve(ctx.workspaces.rename(workspaceId, name)).then(() => loadProjected())
        }
        return loadProjected()
      })
    },
  }

  const stopBrowserMode = registerClawBrowserMode(ctx, React, shared)
  const stopMark = registerSessionMark(ctx, React, shared)

  ctx.effect(() => {
    let unsubSessions = function () {}
    let reloadTimer = null
    void loadProjected()
    try {
      const sessions = ctx.sessions
      if (sessions != null && sessions.list != null && typeof sessions.list.subscribe === 'function') {
        unsubSessions = sessions.list.subscribe(function () {
          if (reloadTimer != null) clearTimeout(reloadTimer)
          reloadTimer = setTimeout(function () {
            reloadTimer = null
            void loadProjected()
          }, 250)
        }) || function () {}
      }
    } catch { /* sessions optional */ }
    return function () {
      localeDispose()
      unsubSessions()
      if (reloadTimer != null) clearTimeout(reloadTimer)
      if (typeof stopBrowserMode === 'function') stopBrowserMode()
      if (typeof stopMark === 'function') stopMark()
      if (typeof stopSettings === 'function') stopSettings()
      if (styleTag != null) styleTag.remove()
      if (doc) doc.body.removeAttribute(ATTR)
    }
  })
}
