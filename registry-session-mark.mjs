import { CLAW_MARK_OPEN } from './registry-marks.mjs'

/**
 * Decorative leading mark for Claw-bound sessions only.
 * Idle / non-archived rows only (host seat rules); never authority.
 */

export function registerSessionMark(ctx, React, api) {
  const slots = ctx.get('slots')
  if (slots == null || React == null) return function () {}

  return slots.inject('sidebar.session.row.leading', function () {
    return slots.register({
      name: 'sidebar.session.row.leading',
      id: 'dsh-claw-registry-claw-mark',
      order: 50,
      locale: api.NS,
      label: function () { return api.t('panel') },
    }, function ClawSessionMark(props) {
      const sessionId = props && props.sessionId
      const bound = typeof api.isBoundSession === 'function'
        ? api.isBoundSession(sessionId)
        : false
      if (!bound) return null
      return React.createElement('img', {
        className: 'dar-claw-mark',
        src: CLAW_MARK_OPEN,
        alt: '',
        width: 14,
        height: 14,
        'data-dar-claw-leading': '1',
      })
    })
  })
}
