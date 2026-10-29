/**
 * Client half: an opt-in probe that can split the right Sidebar and open a
 * browser tab in the new pane. It is inert unless
 * `localStorage['dsh-browser-cdp.probe'] === 'split'`.
 */

interface ObservableSnapshot<T> {
  getSnapshot(): T
}

interface PaneIdBrand {
  readonly __brand?: 'PaneId'
}

interface SidebarRight {
  readonly mounted: ObservableSnapshot<string | undefined>
  isExpanded(): boolean
  toggleExpanded(): void
  split(paneId?: string): string | undefined
  openTab(kind: string, options: { paneId?: string; params?: { url: string } }): void
}

interface ClientContext {
  readonly sidebarRight: SidebarRight
  effect(callback: () => () => void, label?: string): void
}

export const inject = ['sidebarRight']

const PROBE_KEY = 'dsh-browser-cdp.probe'
const RESULT_KEY = 'dsh-browser-cdp.probe.result'
const RETRY_MS = 500
const MAX_ATTEMPTS = 40

/**
 * Run the split probe once, after the client has mounted a Session.
 * @param ctx - client plugin context carrying `sidebarRight`.
 */
export function apply(ctx: ClientContext): void {
  if (typeof localStorage === 'undefined' || localStorage.getItem(PROBE_KEY) !== 'split') return
  localStorage.removeItem(PROBE_KEY)

  let attempts = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
  const result = (value: unknown): void => {
    try {
      localStorage.setItem(RESULT_KEY, JSON.stringify(value))
    } catch {
      // The probe is diagnostic; storage failures are not fatal.
    }
  }

  timer = setInterval(() => {
    attempts += 1
    if (attempts > MAX_ATTEMPTS) {
      stop()
      result({ ok: false, reason: 'timeout waiting for a mounted Session' })
      return
    }
    if (ctx.sidebarRight.mounted.getSnapshot() === undefined) return
    stop()
    ctx.sidebarRight.toggleExpanded()
    const pane = ctx.sidebarRight.split()
    result({ ok: pane !== undefined, expanded: ctx.sidebarRight.isExpanded(), pane: pane ?? null })
    if (pane !== undefined) {
      ctx.sidebarRight.openTab('browser', {
        paneId: pane,
        params: { url: 'https://example.com/?from=client-split-probe' },
      })
    }
  }, RETRY_MS)

  ctx.effect(() => stop, 'browser-cdp: split probe')
}

export type { PaneIdBrand }
