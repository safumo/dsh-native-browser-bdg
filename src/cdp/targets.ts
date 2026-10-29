/** Discovers CDP targets and exposes only the Sidebar browser guests. */

import { ToolError } from '../util.js'
import type { CdpTargetInfo } from '../types.js'
import type { CdpConnection } from './connection.js'

interface RawTargetInfo {
  readonly targetId?: unknown
  readonly type?: unknown
  readonly url?: unknown
  readonly title?: unknown
  readonly attached?: unknown
}

/** Tracks `Target.*` events and resolves the tab a tool should act on. */
export class TargetRegistry {
  readonly #targets = new Map<string, CdpTargetInfo>()
  readonly #listeners = new Set<() => void>()
  #unsubscribe: (() => void) | undefined

  constructor(
    private readonly connection: CdpConnection,
    private readonly allowPageTargets: boolean,
  ) {}

  /** Subscribe to discovery before asking for the current target list. */
  async start(): Promise<void> {
    this.#unsubscribe = this.connection.onEvent((method, params) => {
      this.#onEvent(method, params)
    })
    const current = await this.connection.send<{ targetInfos?: RawTargetInfo[] }>('Target.getTargets')
    for (const info of current.targetInfos ?? []) this.#upsert(info)
    await this.connection.send('Target.setDiscoverTargets', { discover: true })
  }

  /** All controllable tabs, most recently used first. */
  list(): CdpTargetInfo[] {
    return [...this.#targets.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt)
  }

  get(targetId: string): CdpTargetInfo | undefined {
    return this.#targets.get(targetId)
  }

  /**
   * Resolve one explicit target, or the most recently used one.
   * @param targetId - explicit handle from `browser_list_tabs`.
   */
  resolve(targetId?: string): CdpTargetInfo {
    if (targetId !== undefined && targetId !== '') {
      const target = this.#targets.get(targetId)
      if (target === undefined) {
        throw new ToolError(
          `target ${targetId} is not a controllable Sidebar browser tab. Call browser_list_tabs for current handles.`,
          'TARGET_NOT_FOUND',
        )
      }
      return target
    }
    const all = this.list()
    if (all.length === 0) {
      throw new ToolError(
        'no controllable browser tab was found. Open a page in the right Sidebar Browser first, then retry.',
        'TARGET_NOT_FOUND',
      )
    }
    return all[0]!
  }

  /** Record a tool interaction so the default target follows recent activity. */
  touch(targetId: string): void {
    const target = this.#targets.get(targetId)
    if (target === undefined) return
    target.lastActivityAt = Date.now()
    this.#notify()
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  dispose(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#targets.clear()
    this.#listeners.clear()
  }

  #onEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info = params.targetInfo
        if (typeof info === 'object' && info !== null) this.#upsert(info as RawTargetInfo)
        break
      }
      case 'Target.targetDestroyed': {
        const targetId = params.targetId
        if (typeof targetId === 'string' && this.#targets.delete(targetId)) this.#notify()
        break
      }
      default:
        break
    }
  }

  #upsert(info: RawTargetInfo): void {
    const targetId = typeof info.targetId === 'string' ? info.targetId : ''
    if (targetId === '') return
    const type = typeof info.type === 'string' ? info.type : ''
    const url = typeof info.url === 'string' ? info.url : ''
    if (!this.#accepts(type, url)) {
      if (this.#targets.delete(targetId)) this.#notify()
      return
    }
    const previous = this.#targets.get(targetId)
    this.#targets.set(targetId, {
      targetId,
      type,
      url: url === '' ? (previous?.url ?? '') : url,
      title: typeof info.title === 'string' ? info.title : (previous?.title ?? ''),
      attached: typeof info.attached === 'boolean' ? info.attached : (previous?.attached ?? false),
      alias: previous?.alias ?? parseAlias(url),
      lastActivityAt: previous?.lastActivityAt ?? Date.now(),
    })
    this.#notify()
  }

  #accepts(type: string, url: string): boolean {
    if (type === 'webview') return true
    if (type !== 'page') return false
    if (!this.allowPageTargets) return false
    return (url.startsWith('http:') || url.startsWith('https:')) && !url.startsWith('dsh-app:')
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('browser-cdp: target listener failed', error)
      }
    }
  }
}

/** Extract the Sidebar lease from a guest bootstrap URL. */
function parseAlias(url: string): string | undefined {
  const prefix = 'about:blank#'
  return url.startsWith(prefix) ? url.slice(prefix.length) : undefined
}
