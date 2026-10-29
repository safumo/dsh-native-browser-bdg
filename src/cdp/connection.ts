/** Minimal Chrome DevTools Protocol client over a WebSocket, with flattened sessions. */

import { ToolError, describeError } from '../util.js'

type EventHandler = (method: string, params: Record<string, unknown>, sessionId?: string) => void

interface PendingCall {
  readonly method: string
  readonly timer: ReturnType<typeof setTimeout>
  resolve(value: unknown): void
  reject(error: Error): void
}

interface VersionInfo {
  readonly webSocketDebuggerUrl?: string
  readonly Browser?: string
}

/** One browser-level CDP connection; sessions are multiplexed with `flatten`. */
export class CdpConnection {
  #ws: WebSocket | undefined
  #sequence = 0
  #pending = new Map<number, PendingCall>()
  #handlers = new Set<EventHandler>()
  #closed = false

  constructor(readonly endpoint: string) {}

  /** Whether the underlying socket is open. */
  get alive(): boolean {
    return this.#ws !== undefined && this.#ws.readyState === WebSocket.OPEN
  }

  /**
   * Discover the browser WebSocket URL and open the connection.
   * @throws ToolError with a relaunch hint when the endpoint is not reachable.
   */
  async connect(): Promise<void> {
    if (this.alive) return
    let info: VersionInfo
    try {
      const response = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(4000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      info = (await response.json()) as VersionInfo
    } catch (error) {
      throw new ToolError(
        `cannot reach the CDP endpoint ${this.endpoint} (${describeError(error)}). ` +
          'The desktop app must be started cold with --remote-debugging-port, for example: ' +
          `osascript -e 'quit app "DeepSeek Harness"'; sleep 1; ` +
          `open -a "DeepSeek Harness" --args --remote-debugging-port=${portOf(this.endpoint)}`,
        'CDP_UNAVAILABLE',
      )
    }
    if (info.webSocketDebuggerUrl === undefined || info.webSocketDebuggerUrl === '') {
      throw new ToolError(`CDP endpoint ${this.endpoint} did not advertise a browser WebSocket`, 'CDP_UNAVAILABLE')
    }

    const ws = new WebSocket(info.webSocketDebuggerUrl)
    this.#ws = ws
    this.#closed = false
    ws.onmessage = (event: MessageEvent) => {
      this.#onMessage(event.data)
    }
    ws.onclose = () => {
      this.#onClose()
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ToolError('CDP WebSocket did not open within 5s', 'CDP_UNAVAILABLE'))
      }, 5000)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new ToolError('CDP WebSocket failed to connect', 'CDP_UNAVAILABLE'))
        },
        { once: true },
      )
      ws.addEventListener(
        'close',
        () => {
          clearTimeout(timer)
          reject(new ToolError('CDP WebSocket closed during the handshake', 'CDP_UNAVAILABLE'))
        },
        { once: true },
      )
    })
  }

  /**
   * Send one protocol command.
   * @param method - CDP method name.
   * @param params - method parameters.
   * @param sessionId - flattened target session, if any.
   * @param timeoutMs - per-command timeout.
   */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30000,
  ): Promise<T> {
    const ws = this.#ws
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ToolError('CDP connection is not open', 'CDP_UNAVAILABLE'))
    }
    const id = ++this.#sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new ToolError(`CDP ${method} timed out after ${timeoutMs}ms`, 'CDP_TIMEOUT'))
      }, timeoutMs)
      this.#pending.set(id, {
        method,
        timer,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      try {
        ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new ToolError(`CDP ${method} could not be sent: ${describeError(error)}`, 'CDP_ERROR'))
      }
    })
  }

  /** Subscribe to every protocol event; the callback filters by `sessionId` as needed. */
  onEvent(handler: EventHandler): () => void {
    this.#handlers.add(handler)
    return () => {
      this.#handlers.delete(handler)
    }
  }

  /** Close the socket and reject outstanding calls. */
  close(): void {
    this.#closed = true
    const ws = this.#ws
    this.#ws = undefined
    if (ws !== undefined && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close()
      } catch {
        // Already closing.
      }
    }
    this.#rejectAll(new ToolError('CDP connection closed', 'CDP_UNAVAILABLE'))
  }

  #onMessage(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : ''
    if (text === '') return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    const id = message.id
    if (typeof id === 'number') {
      const pending = this.#pending.get(id)
      if (pending === undefined) return
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      const error = message.error
      if (typeof error === 'object' && error !== null) {
        const detail = error as { message?: unknown; data?: unknown; code?: unknown }
        const suffix = typeof detail.data === 'string' && detail.data !== '' ? ` (${detail.data})` : ''
        pending.reject(
          new ToolError(
            `CDP ${pending.method} failed: ${typeof detail.message === 'string' ? detail.message : 'unknown error'}${suffix}`,
            'CDP_ERROR',
          ),
        )
        return
      }
      pending.resolve(message.result)
      return
    }

    const method = message.method
    if (typeof method !== 'string') return
    const params =
      typeof message.params === 'object' && message.params !== null ? (message.params as Record<string, unknown>) : {}
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined
    for (const handler of [...this.#handlers]) {
      try {
        handler(method, params, sessionId)
      } catch (error) {
        console.error('browser-cdp: event handler failed', error)
      }
    }
  }

  #onClose(): void {
    if (this.#closed) return
    this.#closed = true
    this.#ws = undefined
    this.#rejectAll(new ToolError('CDP connection closed', 'CDP_UNAVAILABLE'))
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

function portOf(endpoint: string): string {
  try {
    return new URL(endpoint).port || '9333'
  } catch {
    return '9333'
  }
}
