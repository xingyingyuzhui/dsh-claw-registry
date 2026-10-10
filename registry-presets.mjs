// Declared capability ceilings for preset templates. Phase 0 does not enforce.

import {
  AGENT_PRESET_IDS,
  INIT_PRESET,
  POLICY_SCHEMA_VERSION,
  PRESET_IDS,
  TOOL_IDS,
  applyPreset,
  clampClawPolicy,
  clawHardCap,
  declaredOf,
  intersectPolicies,
  isPresetId,
  isToolEnabled,
  normalizePolicy,
  optionAllowed,
  toggleTool,
} from 'dsh-claw-policy/schema'

export {
  AGENT_PRESET_IDS,
  INIT_PRESET,
  POLICY_SCHEMA_VERSION,
  PRESET_IDS,
  TOOL_IDS,
  applyPreset,
  clampClawPolicy,
  clawHardCap,
  declaredOf,
  intersectPolicies,
  isPresetId,
  isToolEnabled,
  normalizePolicy,
  optionAllowed,
  toggleTool,
}

export const SHIPPED_PRESET_IDS = ['standard', 'code', 'minimal', 'cordis']
export const TEMPLATE_ID = 'wa-template'

export function presetIdForWorkspace(workspaceId) {
  return 'wa-' + String(workspaceId)
}

export function isShippedPreset(id) {
  return SHIPPED_PRESET_IDS.includes(id)
}

export function isClawPresetId(id) {
  if (typeof id !== 'string' || id === '') return false
  if (id === TEMPLATE_ID) return true
  if (isShippedPreset(id)) return false
  return id.startsWith('wa-')
}

/**
 * Unset volatile selectedDefault when it points at a Claw wa-* / template preset.
 * Namespace is agent-preset-registry (0.2+); path is selectedDefault only.
 */
export async function clearSelectedClawDefault(settings, selectedDefault, expectedRevision) {
  if (!isClawPresetId(selectedDefault)) return { cleared: false }
  if (settings == null || typeof settings.mutate !== 'function') {
    return { cleared: false, skipped: true }
  }
  const args = expectedRevision === undefined
    ? ['agent-preset-registry', [{ op: 'unset', path: ['selectedDefault'] }]]
    : ['agent-preset-registry', [{ op: 'unset', path: ['selectedDefault'] }], expectedRevision]
  await settings.mutate(...args)
  return { cleared: true }
}
