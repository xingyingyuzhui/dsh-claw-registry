import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'client.js')
const src = readFileSync(dest, 'utf8')

const ACTIVE_SOURCES = [
  'registry-i18n.mjs',
  'registry-marks.mjs',
  'registry-styles.mjs',
  'registry-presets.mjs',
  'registry-model.mjs',
  'registry-view.mjs',
  'registry-observe.mjs',
  'registry-settings.mjs',
  'registry-template.mjs',
  'registry-navigation.mjs',
  'registry-bindings.mjs',
  'registry-claw-browser.mjs',
  'registry-browser-mode.mjs',
  'registry-session-mark.mjs',
  'registry-client-apply.mjs',
]

const FORBIDDEN = [
  'connection.api',
  'sessions.open',
  'sessions.get',
  'workspaces.startSession',
  'currentSessionOf',
  'MutationObserver',
  'wrapWorkspaceList',
  'wrapPresetList',
  'wrapSessionSearch',
]

test('generated client keeps the factory contract', () => {
  const check = spawnSync(process.execPath, ['--check', dest], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
  assert.match(src, /Do not edit by hand/)
  assert.match(src, /id: 'dsh-claw-registry'/)
  assert.match(src, /inject = \['slots', 'locale', 'sessions', 'uiWorkspace', 'remote', 'workspaces'\]/)
  assert.match(src, /return module\.exports/)
  assert.match(src, /claw区agent模板/)
  assert.doesNotMatch(src, /sidebar\.panellist/)
  assert.doesNotMatch(src, /sidebar\.workspaces\.session\.menu\.item/)
  assert.doesNotMatch(src, /sidebar\.workspaces\.session\.row\.action/)
  assert.match(src, /registerBrowserMode/)
  assert.match(src, /createClaimsStore/)
  assert.match(src, /createClawBrowser/)
  assert.match(src, /sidebar\.session\.row\.leading/)
  assert.match(src, /settings\.section/)
  assert.match(src, /createClawSession/)
  assert.match(src, /uiWorkspace/)
  assert.match(src, /remote\.session/)
  assert.match(src, /agent-preset-registry/)
  assert.match(src, /selectedDefault/)
  assert.match(src, /POLICY_SCHEMA_VERSION/)
  assert.match(src, /tabPersona: '核心'/)
  assert.match(src, /tabTemplate: 'Claw Agent模板'/)
  assert.match(src, /dsh-claw-registry-template/)
  assert.match(src, /CLAW_MARK_OPEN/)
  assert.match(src, /function normalizeModel/)
  assert.match(src, /function newTraceId/)
  assert.match(src, /function formatObserveFail/)
  assert.match(src, /leaveBehindArchive: '归档'/)
  assert.match(src, /leave-behind/)
  assert.match(src, /data-dar-claw-browser/)
  assert.match(src, /\/api\/dsh-claw\/registry\//)
  assert.doesNotMatch(src, /\/dsh-claw-registry\//)
  assert.doesNotMatch(src, /\/dsh-claw-identity\//)
  assert.doesNotMatch(src, /\/dsh-claw-memory\//)
  assert.doesNotMatch(src, /X-DSH-Agent-Registry/)
  assert.doesNotMatch(src, /X-DSH-Agent-Identity/)
  assert.doesNotMatch(src, /X-DSH-Agent-Memory/)
  assert.doesNotMatch(src, /agentPresets\.select\(/)
})

test('active client sources and bundle contain no forbidden APIs', () => {
  for (const file of ACTIVE_SOURCES) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const needle of FORBIDDEN) {
      assert.equal(text.includes(needle), false, `${file} must not contain ${needle}`)
    }
  }
  for (const needle of FORBIDDEN) {
    assert.equal(src.includes(needle), false, `client.js must not contain ${needle}`)
  }
})

test('unused isolate modules are not concatenated into client.js', () => {
  assert.doesNotMatch(src, /function wrapPresetList/)
  assert.doesNotMatch(src, /function isolateWorkspaceSnapshot/)
  assert.doesNotMatch(src, /function wrapSessionSearch/)
  assert.doesNotMatch(src, /function wrapWorkspaceList/)
  assert.doesNotMatch(src, /function currentSessionOf/)
  assert.doesNotMatch(src, /new MutationObserver/)
})
