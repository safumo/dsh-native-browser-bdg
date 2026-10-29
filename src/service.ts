/** Owns the CDP connection, target registry and one session per browser tab. */

import { CdpConnection } from './cdp/connection.js'
import { CdpSession } from './cdp/session.js'
import { TargetRegistry } from './cdp/targets.js'
import type { BrowserConfig } from './config.js'
import { discoverEndpoint, launcherPath } from './discovery.js'
import { ScriptStore, type StoredScript } from './scripts.js'
import { applyStealth } from './stealth.js'
import type { CdpTargetInfo } from './types.js'
import { ToolError, describeError } from './util.js'

interface VersionInfo {
  readonly Browser?: string
  readonly 'Protocol-Version'?: string
}

export class BrowserService {
  readonly #config: BrowserConfig
  readonly #sessions = new Map<string, CdpSession>()
  readonly #attaching = new Map<string, Promise<CdpSession>>()
  readonly #scriptStore = new ScriptStore()
  #restoreTimer: ReturnType<typeof setTimeout> | undefined
  #connection: CdpConnection | undefined
  #registry: TargetRegistry | undefined
  #connecting: Promise<void> | undefined

  constructor(config: BrowserConfig) {
    this.#config = config
  }

  get config(): BrowserConfig {
    return this.#config
  }

  /** All controllable Sidebar tabs, most recently used first. */
  async listTabs(): Promise<CdpTargetInfo[]> {
    await this.#ensure()
    return this.#registry?.list() ?? []
  }

  /** Resolve the target a tool should act on. */
  async target(targetId?: string): Promise<CdpTargetInfo> {
    await this.#ensure()
    const registry = this.#registry
    if (registry === undefined) throw new ToolError('CDP target registry is unavailable', 'CDP_UNAVAILABLE')
    const resolved = registry.resolve(targetId)
    registry.touch(resolved.targetId)
    return resolved
  }

  /** Resolve and attach the session for one target. */
  async session(targetId?: string): Promise<{ session: CdpSession; target: CdpTargetInfo }> {
    const target = await this.target(targetId)
    const cached = this.#sessions.get(target.targetId)
    if (cached !== undefined && !cached.disposed && cached.attached && !cached.lost) return { session: cached, target }
    if (cached !== undefined) {
      this.#sessions.delete(target.targetId)
      await cached.dispose().catch(() => undefined)
    }

    const pending = this.#attaching.get(target.targetId)
    if (pending !== undefined) return { session: await pending, target }

    const connection = this.#connection
    if (connection === undefined) throw new ToolError('CDP connection is unavailable', 'CDP_UNAVAILABLE')
    const created = new CdpSession(connection, target.targetId, this.#config)
    this.#sessions.set(target.targetId, created)
    const attaching = (async () => {
      try {
        await created.attach()
        await applyStealth(created, this.#config)
        await this.#applyScripts(created)
        return created
      } catch (error) {
        this.#sessions.delete(target.targetId)
        await created.dispose().catch(() => undefined)
        throw error
      } finally {
        this.#attaching.delete(target.targetId)
      }
    })()
    this.#attaching.set(target.targetId, attaching)
    return { session: await attaching, target }
  }

  /** Ask Chromium to activate one tab; the Sidebar still owns visibility. */
  async activateTarget(targetId: string): Promise<void> {
    await this.#ensure()
    const connection = this.#connection
    if (connection === undefined) throw new ToolError('CDP connection is unavailable', 'CDP_UNAVAILABLE')
    try {
      await connection.send('Target.activateTarget', { targetId })
    } catch (error) {
      throw new ToolError(`could not activate ${targetId}: ${describeError(error)}`, 'CDP_ERROR')
    }
  }

  /** Human-readable connectivity report; never throws. */
  async diagnose(): Promise<string> {
    const lines: string[] = []
    let found: Awaited<ReturnType<typeof discoverEndpoint>>
    try {
      found = await discoverEndpoint(this.#config)
    } catch (error) {
      lines.push('CDP: not available')
      lines.push('')
      lines.push(describeError(error))
      return lines.join('\n')
    }
    lines.push(`endpoint: ${found.endpoint}`)
    lines.push(`source: ${found.source}`)
    try {
      const response = await fetch(`${found.endpoint}/json/version`, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const info = (await response.json()) as VersionInfo
      lines.push(`browser: ${info.Browser ?? 'unknown'} (protocol ${info['Protocol-Version'] ?? '?'})`)
    } catch (error) {
      lines.push(`connection: FAILED — ${describeError(error)}`)
      lines.push('')
      lines.push(launchHint())
      return lines.join('\n')
    }

    try {
      const tabs = await this.listTabs()
      lines.push(`controllable tabs: ${tabs.length}`)
      for (const tab of tabs) {
        lines.push(`- ${tab.targetId}  ${tab.title === '' ? '(untitled)' : tab.title}`)
        lines.push(`  ${tab.url}`)
      }
      if (tabs.length === 0) {
        lines.push('')
        lines.push('Open a page in the right Sidebar Browser (or run browser_navigate) to create a webview target.')
      }
    } catch (error) {
      lines.push(`target discovery: FAILED — ${describeError(error)}`)
    }
    return lines.join('\n')
  }

  /** Persistent scripts plus the JSON file that stores them. */
  listScripts(): { path: string; scripts: StoredScript[] } {
    return { path: this.#scriptStore.path, scripts: this.#scriptStore.list() }
  }

  /**
   * Save a script under `$DSH_HOME/browser-cdp-scripts.json` and install it in
   * every attached tab. Existing ids are updated in place.
   */
  async persistScript(source: string, id?: string): Promise<StoredScript> {
    const script = this.#scriptStore.add(source, id)
    for (const session of this.#sessions.values()) {
      if (!session.attached || session.lost || session.disposed) continue
      try {
        await session.uninstallInitScript(script.id)
        await session.installInitScript(script.id, script.source)
      } catch (error) {
        console.warn('browser-cdp: could not refresh script', script.id, error)
      }
    }
    return script
  }

  /** Delete a persisted script and uninstall it from every attached tab. */
  async removeScript(id: string): Promise<boolean> {
    const removed = this.#scriptStore.remove(id)
    if (!removed) return false
    for (const session of this.#sessions.values()) {
      try {
        await session.uninstallInitScript(id)
      } catch (error) {
        console.warn('browser-cdp: could not remove script', id, error)
      }
    }
    return true
  }

  /**
   * Read the store and attach to every current tab so its scripts run on the
   * next document. Called at plugin activation and when targets appear.
   * @returns how many tabs were visited.
   */
  async restoreScripts(): Promise<number> {
    if (this.#scriptStore.list().length === 0 && !this.#config.stealth) return 0
    let tabs: CdpTargetInfo[]
    try {
      tabs = await this.listTabs()
    } catch {
      return 0
    }
    let visited = 0
    for (const tab of tabs) {
      try {
        await this.session(tab.targetId)
        visited += 1
      } catch (error) {
        console.warn('browser-cdp: could not restore scripts on tab', tab.targetId, error)
      }
    }
    return visited
  }

  /** Detach every session and close the connection. */
  async dispose(): Promise<void> {
    if (this.#restoreTimer !== undefined) {
      clearTimeout(this.#restoreTimer)
      this.#restoreTimer = undefined
    }
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    this.#attaching.clear()
    await Promise.all(sessions.map((session) => session.dispose().catch(() => undefined)))
    this.#registry?.dispose()
    this.#registry = undefined
    this.#connection?.close()
    this.#connection = undefined
  }

  async #applyScripts(session: CdpSession): Promise<void> {
    for (const script of this.#scriptStore.list()) {
      try {
        await session.installInitScript(script.id, script.source)
      } catch (error) {
        console.warn('browser-cdp: could not install script', script.id, error)
      }
    }
  }

  #scheduleRestore(): void {
    if (this.#scriptStore.list().length === 0 && !this.#config.stealth) return
    if (this.#restoreTimer !== undefined) return
    this.#restoreTimer = setTimeout(() => {
      this.#restoreTimer = undefined
      void this.restoreScripts()
    }, 200)
  }

  async #ensure(): Promise<void> {
    if (this.#connection?.alive === true && this.#registry !== undefined) return
    if (this.#connecting !== undefined) {
      await this.#connecting
      return
    }
    const connecting = this.#open().finally(() => {
      this.#connecting = undefined
    })
    this.#connecting = connecting
    await connecting
  }

  async #open(): Promise<void> {
    await this.#teardown()
    const found = await discoverEndpoint(this.#config)
    const connection = new CdpConnection(found.endpoint)
    await connection.connect()
    const registry = new TargetRegistry(connection, this.#config.allowPageTargets)
    try {
      await registry.start()
    } catch (error) {
      registry.dispose()
      connection.close()
      throw error
    }
    registry.onChange(() => {
      this.#pruneSessions()
      this.#scheduleRestore()
    })
    this.#connection = connection
    this.#registry = registry
  }

  #pruneSessions(): void {
    const registry = this.#registry
    if (registry === undefined) return
    for (const [targetId, session] of [...this.#sessions]) {
      if (registry.get(targetId) !== undefined) continue
      this.#sessions.delete(targetId)
      void session.dispose().catch(() => undefined)
    }
  }

  async #teardown(): Promise<void> {
    if (this.#restoreTimer !== undefined) {
      clearTimeout(this.#restoreTimer)
      this.#restoreTimer = undefined
    }
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    await Promise.all(sessions.map((session) => session.dispose().catch(() => undefined)))
    this.#registry?.dispose()
    this.#registry = undefined
    this.#connection?.close()
    this.#connection = undefined
  }
}

function launchHint(): string {
  return [
    'Browser control is off. The plugin can restart the app for you:',
    '',
    '  call browser_enable_cdp (the app closes and reopens with CDP)',
    '',
    'The same restart is offered at startup when autoRestart is "prompt", or',
    'performed silently when it is "always". A manual equivalent:',
    '',
    `  ${launcherPath()} --restart`,
  ].join('\n')
}
