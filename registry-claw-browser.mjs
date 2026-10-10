/**
 * Claw Workspace Browser Mode Component (Sidebar).
 * Replaces global panel with a partitioned tab adjacent to "工作区".
 */

import { CLAW_MARK_OPEN } from './registry-marks.mjs'
import { clawAgents } from './registry-view.mjs'
import {
  bindingsForAgent,
  repairCandidatesForAgent,
  repairCandidatesUnassigned,
} from './registry-bindings.mjs'
import { createClawSession } from './registry-navigation.mjs'

const EXPANDED_STORAGE_KEY = 'dsh.claw.expanded-agents.v1'

function loadExpandedState() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
      if (raw) return new Set(JSON.parse(raw))
    }
  } catch { /* ignore */ }
  return null
}

function saveExpandedState(set) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...set]))
    }
  } catch { /* ignore */ }
}

function formatRelativeTime(ts, t) {
  if (!ts) return ''
  const now = Date.now()
  const diff = now - Number(ts)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时`
  return t ? t('timeYesterday') : '昨天'
}

export function createClawBrowser(React, api) {
  return function ClawBrowser(props) {
    const el = React.createElement
    const [, setTick] = React.useState(0)
    const [busyId, setBusyId] = React.useState('')
    const [creatingAgent, setCreatingAgent] = React.useState(false)
    const [newAgentName, setNewAgentName] = React.useState('')
    const [submittingCreate, setSubmittingCreate] = React.useState(false)

    // Agent Quick-Select Popover state (Decision 4)
    const [popoverOpen, setPopoverOpen] = React.useState(false)
    const [popoverSearch, setPopoverSearch] = React.useState('')
    const [popoverIndex, setPopoverIndex] = React.useState(0)

    // Collapsible agent groups
    const [expandedSet, setExpandedSet] = React.useState(() => {
      const saved = loadExpandedState()
      return saved || new Set()
    })

    const containerRef = React.useRef(null)
    const popoverInputRef = React.useRef(null)
    const createInputRef = React.useRef(null)

    // Subscriptions
    React.useEffect(() => {
      if (typeof api.subscribeLocale !== 'function') return undefined
      return api.subscribeLocale(() => setTick((n) => n + 1))
    }, [api])

    React.useEffect(() => {
      if (typeof api.subscribeProjected !== 'function') return undefined
      return api.subscribeProjected(() => setTick((n) => n + 1))
    }, [api])

    React.useEffect(() => {
      const sessions = api.ctx && api.ctx.sessions
      if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
        return sessions.list.subscribe(() => setTick((n) => n + 1))
      }
      return undefined
    }, [api])

    const projected = api.getProjected()
    const agents = clawAgents(projected)
    const t = api.t

    // Auto-expand all when loaded for the first time if no saved state
    React.useEffect(() => {
      if (loadExpandedState() === null && agents.length > 0) {
        const next = new Set(agents.map((a) => a.agentId))
        setExpandedSet(next)
        saveExpandedState(next)
      }
    }, [agents.length])

    function toggleExpand(agentId) {
      setExpandedSet((prev) => {
        const next = new Set(prev)
        if (next.has(agentId)) {
          next.delete(agentId)
        } else {
          next.add(agentId)
        }
        saveExpandedState(next)
        return next
      })
    }

    async function handleStartSession(agent) {
      if (!agent || !agent.workspaceId) {
        api.toast(t('sessionCreateFailed'))
        return
      }
      setBusyId(agent.agentId)
      try {
        await createClawSession(api.ctx, agent, agent.workspaceId, {
          post: api.post,
          expectedRevision: projected && projected.revision,
          loadProjected: api.loadProjected,
        })
      } catch (err) {
        const msg = err && err.name === 'ClawPartialCreateError'
          ? t('sessionPartialCreate')
          : String((err && err.message) || t('sessionCreateFailed'))
        api.toast(msg)
      } finally {
        setBusyId('')
      }
    }

    // Handle "New Session" top-level request (Decision 4)
    React.useEffect(() => {
      if (typeof api.subscribeNewSessionRequest !== 'function') return undefined
      return api.subscribeNewSessionRequest(() => {
        if (agents.length === 0) {
          if (typeof props.expandSidebar === 'function') props.expandSidebar()
          setCreatingAgent(true)
          setTimeout(() => {
            if (createInputRef.current) createInputRef.current.focus()
          }, 50)
          return
        }
        if (agents.length === 1) {
          void handleStartSession(agents[0])
          return
        }
        // >= 2 agents: expand sidebar, scroll to top, open popover
        if (typeof props.expandSidebar === 'function') props.expandSidebar()
        if (containerRef.current) {
          containerRef.current.scrollTo({ top: 0, behavior: 'smooth' })
        }
        setPopoverSearch('')
        setPopoverIndex(0)
        setPopoverOpen(true)
        setTimeout(() => {
          if (popoverInputRef.current) popoverInputRef.current.focus()
        }, 50)
      })
    }, [agents, props.expandSidebar])

    function handleCreateAgent() {
      const val = String(newAgentName || '').trim()
      if (!val || submittingCreate) return
      setSubmittingCreate(true)
      Promise.resolve(api.createAgent(val)).then(() => {
        setNewAgentName('')
        setCreatingAgent(false)
      }).finally(() => {
        setSubmittingCreate(false)
      })
    }

    // Popover filtered list
    const filteredAgents = React.useMemo(() => {
      const q = String(popoverSearch || '').trim().toLowerCase()
      if (!q) return agents
      return agents.filter((a) => {
        const title = String(a.title || a.slug || a.agentId || '').toLowerCase()
        return title.includes(q)
      })
    }, [agents, popoverSearch])

    function handlePopoverKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setPopoverOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPopoverIndex((idx) => Math.min(filteredAgents.length - 1, idx + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPopoverIndex((idx) => Math.max(0, idx - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filteredAgents[popoverIndex]) {
          const selected = filteredAgents[popoverIndex]
          setPopoverOpen(false)
          void handleStartSession(selected)
        }
      }
    }

    // Repair actions (Decision 5)
    async function handleAdopt(candidate, targetAgentId) {
      try {
        await api.post('/api/dsh-claw/registry/session/adopt', {
          sessionId: candidate.sessionId,
          agentId: targetAgentId,
          expectedRevision: projected && projected.revision,
        })
        api.toast(t('saved'))
        await api.loadProjected()
      } catch (err) {
        api.toast(String(err && err.message ? err.message : t('fail')))
      }
    }

    async function handleReinspect() {
      if (api.ctx.sessions && typeof api.ctx.sessions.refresh === 'function') {
        await api.ctx.sessions.refresh()
      }
      await api.loadProjected()
    }

    async function handleArchiveCandidate(sessionId) {
      if (api.ctx.uiWorkspace && typeof api.ctx.uiWorkspace.archiveSession === 'function') {
        api.ctx.uiWorkspace.archiveSession(sessionId)
      }
      await api.loadProjected()
    }

    async function handleRetryModel(agent, sessionId) {
      const model = agent && (agent.model || agent.defaultModel)
      const remote = api.ctx && api.ctx.remote && api.ctx.remote.session
      if (!model || !remote || typeof remote.selectModel !== 'function') return
      try {
        await remote.selectModel({
          sessionId,
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort != null ? { reasoningEffort: model.reasoningEffort } : {}),
        })
        await api.post('/api/dsh-claw/registry/session/state', {
          sessionId,
          state: 'ready',
          expectedRevision: projected && projected.revision,
        })
        api.toast(t('saved'))
        await api.loadProjected()
      } catch (err) {
        api.toast(String(err && err.message ? err.message : t('fail')))
      }
    }

    const officialSessions = (api.ctx && api.ctx.sessions && api.ctx.sessions.list
      && typeof api.ctx.sessions.list.getSnapshot === 'function'
      && api.ctx.sessions.list.getSnapshot().byId) || {}

    const unassignedRepair = repairCandidatesUnassigned(projected)

    return el('div', {
      ref: containerRef,
      className: 'dar-claw-browser',
      'data-dar-claw-browser': '1',
      style: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '6px 8px',
      },
    },
      // Top toolbar: [+ 新建 Agent] and [刷新]
      el('div', {
        className: 'dar-claw-topbar',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: '8px',
        },
      },
        el('button', {
          type: 'button',
          className: 'dar-btn',
          style: { height: '30px', fontSize: '12px', padding: '0 10px', borderRadius: '6px' },
          onClick: () => {
            setCreatingAgent((prev) => !prev)
            setTimeout(() => {
              if (createInputRef.current) createInputRef.current.focus()
            }, 50)
          },
        }, `+ ${t('newAgent')}`),
        el('button', {
          type: 'button',
          className: 'dar-btn',
          style: { height: '30px', fontSize: '12px', padding: '0 8px', borderRadius: '6px' },
          onClick: () => { void api.loadProjected() },
        }, t('refresh')),
      ),

      // Inline create form
      creatingAgent
        ? el('div', {
            style: {
              display: 'flex',
              gap: '6px',
              marginBottom: '10px',
              padding: '6px',
              background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
              borderRadius: '8px',
            },
          },
          el('input', {
            ref: createInputRef,
            className: 'dar-input',
            value: newAgentName,
            placeholder: t('createPlaceholder'),
            style: { height: '30px', fontSize: '13px' },
            onChange: (e) => setNewAgentName(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') handleCreateAgent()
              if (e.key === 'Escape') setCreatingAgent(false)
            },
          }),
          el('button', {
            type: 'button',
            className: 'dar-btn',
            disabled: submittingCreate || !String(newAgentName || '').trim(),
            style: { height: '30px', fontSize: '12px', padding: '0 10px' },
            onClick: handleCreateAgent,
          }, submittingCreate ? t('panelBusy') : t('createAgent')),
        )
        : null,

      // Quick-Select Agent Popover (Decision 4)
      popoverOpen
        ? el('div', {
            className: 'dar-popover',
            style: {
              position: 'relative',
              zIndex: 100,
              display: 'flex',
              flexDirection: 'column',
              padding: '8px',
              marginBottom: '10px',
              border: '1px solid var(--dsw-alias-border-inverted, var(--dsw-alias-border-l2))',
              borderRadius: '10px',
              background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #1e2128))',
              boxShadow: 'var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,0.25))',
            },
          },
          el('input', {
            ref: popoverInputRef,
            className: 'dar-input',
            value: popoverSearch,
            placeholder: t('searchAgents'),
            style: { height: '30px', fontSize: '13px', marginBottom: '6px' },
            onChange: (e) => {
              setPopoverSearch(e.target.value)
              setPopoverIndex(0)
            },
            onKeyDown: handlePopoverKeyDown,
          }),
          el('div', {
            style: { maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' },
          },
            filteredAgents.length === 0
              ? el('div', { style: { padding: '6px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('searchNoMatch'))
              : filteredAgents.map((agent, i) => {
                  const isHighlighted = i === popoverIndex
                  const title = agent.title || agent.slug || agent.agentId
                  const count = (agent.sessionIds && agent.sessionIds.length) || 0
                  return el('div', {
                    key: agent.agentId,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      cursor: 'pointer',
                      background: isHighlighted ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.15))' : 'transparent',
                    },
                    onClick: () => {
                      setPopoverOpen(false)
                      void handleStartSession(agent)
                    },
                  },
                    el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
                    el('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginLeft: '6px' } }, `${count}`),
                  )
                }),
          ),
          el('div', {
            style: {
              borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.15))',
              marginTop: '6px',
              paddingTop: '6px',
            },
          },
            el('button', {
              type: 'button',
              className: 'dar-btn-link',
              style: { width: '100%', textAlign: 'left', fontSize: '12px', padding: '4px 6px' },
              onClick: () => {
                setPopoverOpen(false)
                setCreatingAgent(true)
                setTimeout(() => {
                  if (createInputRef.current) createInputRef.current.focus()
                }, 50)
              },
            }, `+ ${t('newAgent')}`),
          ),
        )
        : null,

      // Agents list
      agents.length === 0
        ? el('div', {
            style: { padding: '16px 8px', textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' },
          }, t('emptyClawBrowser'))
        : el('div', {
            className: 'dar-claw-list',
            style: { display: 'flex', flexDirection: 'column', gap: '4px' },
          },
            agents.map((agent) => {
              const isExpanded = expandedSet.has(agent.agentId)
              const title = agent.title || agent.slug || agent.agentId
              const bindings = bindingsForAgent(projected, agent.agentId)
              const repairs = repairCandidatesForAgent(projected, agent.agentId)
              const isBusy = busyId === agent.agentId

              return el('div', {
                key: agent.agentId,
                className: `dar-claw-group ${!isExpanded ? 'dar-claw-collapsed' : ''}`,
                'data-dar-agent-id': agent.agentId,
              },
                // Agent header row
                el('div', {
                  className: 'dar-claw-row',
                  onClick: () => toggleExpand(agent.agentId),
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 8px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                  },
                },
                  el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: 1 } },
                    el('span', {
                      className: 'dar-claw-slot',
                      style: {
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 120ms ease',
                      },
                    }, '▶'),
                    el('img', {
                      src: CLAW_MARK_OPEN,
                      alt: '',
                      width: 14,
                      height: 14,
                      style: { flex: 'none' },
                    }),
                    el('strong', {
                      className: 'dar-claw-title',
                      style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    }, title),
                    el('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', flex: 'none' },
                    }, `(${bindings.length})`),
                  ),
                  el('div', {
                    className: 'dar-claw-actions',
                    style: { display: 'flex', alignItems: 'center', gap: '6px' },
                    onClick: (e) => e.stopPropagation(),
                  },
                    el('button', {
                      type: 'button',
                      className: 'dar-claw-icon-btn',
                      title: t('clawAddSession', { name: title }),
                      disabled: isBusy || !agent.workspaceId,
                      style: { fontSize: '15px', lineHeight: 1 },
                      onClick: () => handleStartSession(agent),
                    }, '+'),
                  ),
                ),

                // Sessions and repairs when expanded
                isExpanded
                  ? el('div', {
                      className: 'dar-claw-sessions',
                      style: { paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' },
                    },
                      // Bound sessions
                      bindings.map((b) => {
                        const sid = b.sessionId
                        const summary = officialSessions[sid]
                        const displayTitle = (summary && (summary.displayTitle || summary.title)) || sid
                        const running = Boolean(summary && summary.running)
                        const timeStr = formatRelativeTime(summary && summary.updatedAt, t)
                        const needsModel = b.state === 'needs_model'

                        return el('div', {
                          key: sid,
                          className: 'dar-claw-session',
                          onClick: () => api.nav.openSession(sid),
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '3px 6px',
                            borderRadius: '5px',
                            cursor: 'pointer',
                            fontSize: '13px',
                          },
                        },
                          el('span', {
                            style: {
                              width: '6px',
                              height: '6px',
                              borderRadius: '50%',
                              backgroundColor: running ? 'var(--dsw-alias-state-success-primary, #10b981)' : 'var(--dsw-alias-label-tertiary, #9ca3af)',
                              flex: 'none',
                            },
                          }),
                          el('span', {
                            className: 'dar-claw-session-title',
                            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                          }, displayTitle),
                          needsModel
                            ? el('span', {
                                style: {
                                  fontSize: '11px',
                                  padding: '1px 5px',
                                  borderRadius: '4px',
                                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                                  color: 'var(--dsw-alias-state-error-primary, #ef4444)',
                                  flex: 'none',
                                },
                                title: t('needsModel'),
                                onClick: (e) => {
                                  e.stopPropagation()
                                  void handleRetryModel(agent, sid)
                                },
                              }, t('retryModel'))
                            : null,
                          timeStr
                            ? el('span', {
                                className: 'dar-claw-session-time',
                                style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', flex: 'none' },
                              }, timeStr)
                            : null,
                        )
                      }),

                      // Repair candidates for this agent
                      repairs.map((cand) => {
                        const sid = cand.sessionId
                        return el('div', {
                          key: sid,
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                            padding: '6px',
                            margin: '2px 0',
                            borderRadius: '6px',
                            border: '1px solid rgba(245, 158, 11, 0.3)',
                            background: 'rgba(245, 158, 11, 0.05)',
                            fontSize: '12px',
                          },
                        },
                          el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                            el('span', { style: { color: '#f59e0b', fontWeight: 'bold' } }, '!'),
                            el('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sid),
                            el('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px' } }, cand.reason),
                          ),
                          el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                            el('button', {
                              type: 'button',
                              className: 'dar-btn-link',
                              onClick: () => handleAdopt(cand, agent.agentId),
                            }, t('repairBindSuggested')),
                            el('button', {
                              type: 'button',
                              className: 'dar-btn-link',
                              onClick: handleReinspect,
                            }, t('repairReinspect')),
                            el('button', {
                              type: 'button',
                              className: 'dar-btn-link',
                              onClick: () => handleArchiveCandidate(sid),
                            }, t('repairArchive')),
                          ),
                        )
                      }),

                      bindings.length === 0 && repairs.length === 0
                        ? el('div', {
                            style: { padding: '4px 6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
                          }, '空')
                        : null,
                    )
                  : null,
              )
            }),
          ),

      // Unassigned repair queue section
      unassignedRepair.length > 0
        ? el('div', {
            style: {
              marginTop: '16px',
              padding: '8px',
              borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'rgba(239, 68, 68, 0.05)',
            },
          },
          el('div', { style: { fontSize: '12px', fontWeight: '600', marginBottom: '6px', color: 'var(--dsw-alias-state-warning-primary, #f59e0b)' } },
            t('repairQueueTitle'),
          ),
          unassignedRepair.map((cand) => el('div', {
            key: cand.sessionId,
            style: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '6px', fontSize: '12px' },
          },
            el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, cand.sessionId),
            el('div', { style: { display: 'flex', gap: '8px' } },
              el('button', {
                type: 'button',
                className: 'dar-btn-link',
                onClick: handleReinspect,
              }, t('repairReinspect')),
              el('button', {
                type: 'button',
                className: 'dar-btn-link',
                onClick: () => handleArchiveCandidate(cand.sessionId),
              }, t('repairArchive')),
            ),
          )),
        )
        : null,
    )
  }
}
