import assert from 'node:assert/strict'
import test from 'node:test'
import yaml from 'js-yaml'
import {
  CLAW_PRESET_ORDER,
  clawPresetDefinition,
  createPresetSupply,
  entryListSchema,
  parseComposition,
  readBaseComposition,
} from '../registry-preset-supply.mjs'

const STANDARD_DOC = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  "  disabled: !!js process.platform === 'win32'",
  '- id: delegation',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: tool-subagent',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '',
].join('\n')

function fakePresets({ rows, docs = {}, defaultId = 'standard', register } = {}) {
  const calls = { register: [], disposed: [], readDocument: [] }
  return {
    calls,
    defaultId,
    async list() { return rows || [{ id: 'standard' }] },
    async readDocument(id) {
      calls.readDocument.push(id)
      if (!(id in docs)) throw new Error('Unknown agent preset: ' + id)
      return { agentPreset: id, content: docs[id] }
    },
    async register(definition) {
      calls.register.push(definition)
      if (register) await register(definition)
      return async () => { calls.disposed.push(definition.id) }
    },
  }
}

test('parseComposition keeps !!js expressions in the official { __jsExpr } shape', () => {
  const rows = parseComposition(STANDARD_DOC)
  assert.deepEqual(rows[1].disabled, { __jsExpr: "process.platform === 'win32'" })
  assert.equal(rows[2].config[0].name, '@deepseek-ai/dsh-tool-subagent')
  const round = yaml.dump(rows, { schema: entryListSchema })
  assert.match(round, /!!js process\.platform === 'win32'/)
})

test('parseComposition rejects documents that are not a row list', () => {
  assert.throws(() => parseComposition('id: x\n'), /list of plugin rows/)
})

test('readBaseComposition prefers wa-template, then standard, then a non-Claw default', async () => {
  const docs = { 'wa-template': '- id: a\n  name: x\n', standard: STANDARD_DOC, code: '- id: c\n  name: y\n' }
  const both = fakePresets({ rows: [{ id: 'standard' }, { id: 'wa-template' }], docs })
  assert.equal((await readBaseComposition(both)).source, 'wa-template')

  const brokenTemplate = fakePresets({ rows: [{ id: 'wa-template', broken: 'x' }, { id: 'standard' }], docs })
  assert.equal((await readBaseComposition(brokenTemplate)).source, 'standard')

  const onlyDefault = fakePresets({ rows: [{ id: 'code' }], docs, defaultId: 'code' })
  assert.equal((await readBaseComposition(onlyDefault)).source, 'code')

  const clawDefault = fakePresets({ rows: [{ id: 'wa-lab' }], docs, defaultId: 'wa-lab' })
  await assert.rejects(() => readBaseComposition(clawDefault), /no usable base preset/)
})

test('clawPresetDefinition names the preset after the agent and clones the rows', () => {
  const plugins = parseComposition(STANDARD_DOC)
  const def = clawPresetDefinition({ dshPreset: 'wa-lab-a', title: 'lab-a' }, plugins)
  assert.equal(def.id, 'wa-lab-a')
  assert.equal(def.name, 'Claw · lab-a')
  assert.equal(def.order, CLAW_PRESET_ORDER)
  assert.deepEqual(def.plugins, plugins)
  assert.notEqual(def.plugins, plugins)
})

test('ensure registers each Claw preset once, even when called concurrently', async () => {
  const presets = fakePresets({ docs: { standard: STANDARD_DOC } })
  const supply = createPresetSupply(presets)
  const agent = { dshPreset: 'wa-lab-a', title: 'lab-a' }
  const [a, b] = await Promise.all([supply.ensure(agent), supply.ensure(agent)])
  assert.equal(a, 'wa-lab-a')
  assert.equal(b, 'wa-lab-a')
  await supply.ensure(agent)
  assert.equal(presets.calls.register.length, 1)
  assert.equal(presets.calls.readDocument.length, 1)
  assert.equal(supply.has('wa-lab-a'), true)
})

test('ensure refuses non-Claw ids and the template id', async () => {
  const supply = createPresetSupply(fakePresets({ docs: { standard: STANDARD_DOC } }))
  await assert.rejects(() => supply.ensure({ dshPreset: 'standard' }), /no Claw preset id/)
  await assert.rejects(() => supply.ensure({ dshPreset: 'wa-template' }), /no Claw preset id/)
  await assert.rejects(() => supply.ensure(null), /no Claw preset id/)
})

test('ensure reports a missing register API instead of falling back', async () => {
  const supply = createPresetSupply({ list: async () => [], copy: async () => {} })
  await assert.rejects(() => supply.ensure({ dshPreset: 'wa-lab-a' }), /register unavailable/)
})

test('a duplicate declaration from an earlier generation counts as ready', async () => {
  const presets = fakePresets({
    docs: { standard: STANDARD_DOC },
    register: async (def) => { throw new Error('Duplicate agent preset: ' + def.id) },
  })
  const supply = createPresetSupply(presets)
  assert.equal(await supply.ensure({ dshPreset: 'wa-lab-a' }), 'wa-lab-a')
  await supply.release('wa-lab-a')
  assert.deepEqual(presets.calls.disposed, [])
})

test('a failed registration is retried on the next ensure', async () => {
  let fail = true
  const presets = fakePresets({
    docs: { standard: STANDARD_DOC },
    register: async () => { if (fail) throw new Error('mount failed') },
  })
  const supply = createPresetSupply(presets)
  await assert.rejects(() => supply.ensure({ dshPreset: 'wa-lab-a' }), /mount failed/)
  assert.equal(supply.has('wa-lab-a'), false)
  fail = false
  assert.equal(await supply.ensure({ dshPreset: 'wa-lab-a' }), 'wa-lab-a')
})

test('ensureAll returns per-preset failures and skips non-Claw rows', async () => {
  const presets = fakePresets({
    docs: { standard: STANDARD_DOC },
    register: async (def) => { if (def.id === 'wa-bad') throw new Error('broken row') },
  })
  const supply = createPresetSupply(presets)
  const failed = await supply.ensureAll([
    { dshPreset: 'wa-good' },
    { dshPreset: 'wa-bad' },
    { dshPreset: 'standard' },
    null,
  ])
  assert.deepEqual(failed.map((row) => row.presetId), ['wa-bad'])
  assert.deepEqual(presets.calls.register.map((def) => def.id), ['wa-good', 'wa-bad'])
})

test('release and disposeAll call the disposers register returned', async () => {
  const presets = fakePresets({ docs: { standard: STANDARD_DOC } })
  const supply = createPresetSupply(presets)
  await supply.ensureAll([{ dshPreset: 'wa-a' }, { dshPreset: 'wa-b' }])
  await supply.release('wa-a')
  assert.deepEqual(presets.calls.disposed, ['wa-a'])
  await supply.disposeAll()
  assert.deepEqual(presets.calls.disposed.sort(), ['wa-a', 'wa-b'])
  assert.equal(supply.has('wa-b'), false)
})
