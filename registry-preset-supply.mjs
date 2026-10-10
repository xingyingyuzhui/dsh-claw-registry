/**
 * Claw `wa-*` preset supply for DSH 0.2: each Claw agent's preset is declared at runtime through
 * the public `agentPresets.register()` using a composition read from an existing preset document.
 */
import yaml from 'js-yaml'
import { isClawPresetId, TEMPLATE_ID } from './registry-presets.mjs'

// `!!js` scalars must load as `{ __jsExpr }`: the shape the official Loader evaluates
// (`entryListSchema` in @deepseek-ai/cordis-plugin-include, which plugins cannot import).
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: (value) => value instanceof Object && '__jsExpr' in value,
  represent: (value) => value.__jsExpr,
})

export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

/** User-declared template first, then the official general-purpose preset. */
export const BASE_PRESET_CANDIDATES = [TEMPLATE_ID, 'standard']

export const CLAW_PRESET_ORDER = 1000

export function parseComposition(content) {
  const rows = yaml.load(String(content || ''), { schema: entryListSchema })
  if (!Array.isArray(rows)) throw new Error('preset composition must be a list of plugin rows')
  return rows
}

export async function readBaseComposition(presets) {
  const rows = await presets.list()
  const live = new Map(rows.filter(Boolean).map((row) => [row.id, row]))
  const order = [...BASE_PRESET_CANDIDATES]
  const fallback = presets.defaultId
  if (typeof fallback === 'string' && !isClawPresetId(fallback) && !order.includes(fallback)) order.push(fallback)
  for (const id of order) {
    const row = live.get(id)
    if (!row || row.broken) continue
    const doc = await presets.readDocument(id)
    return { source: id, plugins: parseComposition(doc && doc.content) }
  }
  throw new Error('no usable base preset (' + order.join(' / ') + ')')
}

export function clawPresetDefinition(agent, plugins) {
  const title = (agent && agent.title) || (agent && agent.slug) || agent.dshPreset
  return {
    id: agent.dshPreset,
    name: 'Claw · ' + title,
    description: 'Claw Agent ' + title,
    order: CLAW_PRESET_ORDER,
    plugins: structuredClone(plugins),
  }
}

function isDuplicate(error) {
  return Boolean(error && typeof error.message === 'string' && error.message.startsWith('Duplicate agent preset'))
}

/**
 * @param {object} presets - official `agentPresets` service (0.2: list/readDocument/register/defaultId)
 */
export function createPresetSupply(presets) {
  const held = new Map()
  let base = null

  function baseComposition() {
    if (!base) {
      base = readBaseComposition(presets).catch((error) => {
        base = null
        throw error
      })
    }
    return base
  }

  function ensure(agent) {
    const id = agent && agent.dshPreset
    if (!isClawPresetId(id) || id === TEMPLATE_ID) {
      return Promise.reject(new Error('agent has no Claw preset id'))
    }
    if (presets == null || typeof presets.register !== 'function' || typeof presets.readDocument !== 'function') {
      return Promise.reject(new Error('agentPresets.register unavailable'))
    }
    const existing = held.get(id)
    if (existing) return existing.ready
    const entry = { dispose: null, ready: null }
    held.set(id, entry)
    entry.ready = (async () => {
      const { plugins } = await baseComposition()
      try {
        entry.dispose = await presets.register(clawPresetDefinition(agent, plugins))
      } catch (error) {
        if (!isDuplicate(error)) throw error
      }
      return id
    })().catch((error) => {
      if (held.get(id) === entry) held.delete(id)
      throw error
    })
    return entry.ready
  }

  async function ensureAll(agents) {
    const rows = (agents || []).filter((agent) => agent && isClawPresetId(agent.dshPreset) && agent.dshPreset !== TEMPLATE_ID)
    const settled = await Promise.allSettled(rows.map((agent) => ensure(agent)))
    return settled
      .map((result, index) => (result.status === 'rejected' ? { presetId: rows[index].dshPreset, error: result.reason } : null))
      .filter(Boolean)
  }

  async function release(id) {
    const entry = held.get(id)
    if (!entry) return
    held.delete(id)
    try { await entry.ready } catch { return }
    if (typeof entry.dispose === 'function') await entry.dispose()
  }

  async function disposeAll() {
    await Promise.allSettled([...held.keys()].map((id) => release(id)))
    base = null
  }

  return { ensure, ensureAll, release, disposeAll, has: (id) => held.has(id) }
}
