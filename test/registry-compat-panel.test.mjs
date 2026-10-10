import assert from 'node:assert/strict'
import test from 'node:test'
import { hasBrowserModeSeam } from '../registry-browser-mode.mjs'
import { createCompatSettingsPage } from '../registry-compat-panel.mjs'

function fakeReact() {
  const effects = []
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(init) {
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect(fn) { effects.push(fn) },
    useRef() { return { current: null } },
    useMemo(fn) { return fn() },
  }
  return { React, effects }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

function sharedStub() {
  const listeners = new Set()
  return {
    t: (key) => key,
    ctx: {},
    nav: { openSession() {} },
    getProjected: () => null,
    subscribeProjected(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    listeners,
  }
}

test('hasBrowserModeSeam only accepts a registerBrowserMode function', () => {
  assert.equal(hasBrowserModeSeam(null), false)
  assert.equal(hasBrowserModeSeam({}), false)
  assert.equal(hasBrowserModeSeam({ uiWorkspace: {} }), false)
  assert.equal(hasBrowserModeSeam({ uiWorkspace: { registerBrowserMode: true } }), false)
  assert.equal(hasBrowserModeSeam({ uiWorkspace: { registerBrowserMode() {} } }), true)
})

test('compat settings page shows notice, Claw browser and the regular page', () => {
  const { React, effects } = fakeReact()
  const shared = sharedStub()
  function Page() { return null }
  const CompatPage = createCompatSettingsPage(React, shared, Page)
  const close = () => {}

  const tree = CompatPage({ close })
  const nodes = []
  walk(tree, (n) => nodes.push(n))

  const section = nodes.find((n) => n.props['data-dar-compat'] === '1')
  assert.ok(section, 'compat section rendered')
  assert.ok(nodes.some((n) => n.props.role === 'note' && n.children.includes('compatNotice')))

  const browser = nodes.find((n) => typeof n.type === 'function' && n.type.name === 'ClawBrowser')
  assert.ok(browser, 'ClawBrowser reused')
  assert.equal(browser.props.onNavigate, close, 'leaving for a session closes settings')

  const page = nodes.find((n) => n.type === Page)
  assert.ok(page, 'regular settings page still rendered')
  assert.equal(page.props.compatMode, true)
  assert.equal(page.props.close, close)
  assert.equal(page.props.refreshKey, 0)

  const dispose = effects[0]()
  assert.equal(shared.listeners.size, 1, 'subscribes to projected updates')
  dispose()
  assert.equal(shared.listeners.size, 0, 'unsubscribes on unmount')
})

test('compat settings page tolerates a missing close affordance', () => {
  const { React } = fakeReact()
  function Page() { return null }
  const tree = createCompatSettingsPage(React, sharedStub(), Page)({})
  const nodes = []
  walk(tree, (n) => nodes.push(n))
  const browser = nodes.find((n) => typeof n.type === 'function' && n.type.name === 'ClawBrowser')
  assert.equal(browser.props.onNavigate, undefined)
})
