/** Small shared helpers: errors, argument coercion, timings and key mapping. */

/** Error carrying a stable machine-readable code for tool diagnostics. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const omitted = text.length - max
  return `${text.slice(0, max)}\n… truncated ${omitted} characters`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringArg(value: unknown, name: string, fallback?: string): string {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw new ToolError(`missing required argument: ${name}`, 'INVALID_ARGS')
  }
  if (typeof value !== 'string') throw new ToolError(`${name} must be a string`, 'INVALID_ARGS')
  const trimmed = value.trim()
  if (trimmed === '' && fallback === undefined) throw new ToolError(`${name} must not be empty`, 'INVALID_ARGS')
  return trimmed === '' ? fallback ?? '' : trimmed
}

export function numberArg(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolError(`${name} must be a finite number`, 'INVALID_ARGS')
  }
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function boolArg(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Chromium modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function parseModifiers(value: unknown): number {
  if (value === undefined || value === null) return 0
  const list = Array.isArray(value) ? value : [value]
  let mask = 0
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    switch (raw.toLowerCase()) {
      case 'alt':
        mask |= 1
        break
      case 'ctrl':
      case 'control':
        mask |= 2
        break
      case 'meta':
      case 'cmd':
      case 'command':
        mask |= 4
        break
      case 'shift':
        mask |= 8
        break
      default:
        break
    }
  }
  return mask
}

/** One keyboard event descriptor derived from a human key name. */
export interface KeyInfo {
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  readonly text?: string
}

const NAMED_KEYS: Record<string, KeyInfo> = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

/** Map one key name (e.g. `Enter`, `a`, `F5`) to a CDP keyboard descriptor. */
export function keyInfo(name: string): KeyInfo {
  const normalized = name.trim()
  if (normalized === '') throw new ToolError('key must not be empty', 'INVALID_ARGS')
  const named = NAMED_KEYS[normalized.toLowerCase()]
  if (named !== undefined) return named
  if (/^f([1-9]|1[0-2])$/i.test(normalized)) {
    const index = Number(normalized.slice(1))
    return { key: `F${index}`, code: `F${index}`, windowsVirtualKeyCode: 111 + index }
  }
  if (/^[a-z]$/i.test(normalized)) {
    const upper = normalized.toUpperCase()
    return { key: normalized, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: normalized }
  }
  if (/^[0-9]$/.test(normalized)) {
    return { key: normalized, code: `Digit${normalized}`, windowsVirtualKeyCode: normalized.charCodeAt(0), text: normalized }
  }
  if ([...normalized].length === 1) {
    return { key: normalized, code: '', windowsVirtualKeyCode: normalized.toUpperCase().charCodeAt(0), text: normalized }
  }
  throw new ToolError(`unsupported key: ${name}`, 'INVALID_ARGS')
}

/** Decode base64 into bytes without Node buffers. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** One-line error description that never throws on exotic values. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
