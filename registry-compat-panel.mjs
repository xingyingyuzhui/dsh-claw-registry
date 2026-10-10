/**
 * Settings-hosted Claw entry for DSH builds without the ui-workspace Browser Mode seam (ADR-0002).
 * Reuses the sidebar ClawBrowser; leaving for a session closes the settings modal via the owner `close`.
 */

import { createClawBrowser } from './registry-claw-browser.mjs'

export function createCompatSettingsPage(React, shared, Page) {
  const ClawBrowser = createClawBrowser(React, shared)
  return function CompatSettingsPage(props) {
    const el = React.createElement
    const [revision, setRevision] = React.useState(0)
    React.useEffect(() => {
      return shared.subscribeProjected(() => setRevision((n) => n + 1))
    }, [])
    const close = props && typeof props.close === 'function' ? props.close : undefined
    return el(React.Fragment, null,
      el('section', { className: 'dar-card dar-compat', 'data-dar-compat': '1' },
        el('p', { className: 'dar-note', role: 'note' }, shared.t('compatNotice')),
        el('div', { className: 'dar-compat-browser' }, el(ClawBrowser, { onNavigate: close })),
      ),
      el(Page, { ...props, compatMode: true, refreshKey: revision }),
    )
  }
}
