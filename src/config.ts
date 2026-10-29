/** Plugin configuration: endpoint, target policy, buffer caps and timeouts. */

export interface BrowserConfig {
  /** Explicit loopback CDP endpoint; empty discovers the running app automatically. */
  readonly endpoint: string
  /** Whether `page` targets may be driven; refused for the DSH application origin. */
  readonly allowPageTargets: boolean
  readonly maxNetworkEvents: number
  readonly maxConsoleEvents: number
  readonly snapshotMaxNodes: number
  readonly navTimeoutMs: number
  readonly commandTimeoutMs: number
  readonly maxTextChars: number
  /** `png` keeps text crisp; `jpeg` produces smaller screenshots. */
  readonly screenshotFormat: 'png' | 'jpeg'
  /** Startup detection: off, ask the user, or restart silently. */
  readonly autoRestart: 'off' | 'prompt' | 'always'
  /** Delay before the helper quits the app, so a tool result can be delivered. */
  readonly restartDelayMs: number
  /** Minimum spacing between restart attempts, to stop crash loops. */
  readonly restartGuardMs: number
  /** Strip credential-ish query parameters and headers from diagnostics. */
  readonly redactSensitive: boolean
  /** Normalise the Electron user agent/Client Hints and patch `window.chrome`. */
  readonly stealth: boolean
}

/** Empty endpoint means "discover the running app's DevTools port". */
export const DEFAULT_ENDPOINT = ''

const DEFAULTS: BrowserConfig = {
  endpoint: DEFAULT_ENDPOINT,
  allowPageTargets: false,
  maxNetworkEvents: 1000,
  maxConsoleEvents: 500,
  snapshotMaxNodes: 300,
  navTimeoutMs: 15000,
  commandTimeoutMs: 30000,
  maxTextChars: 20000,
  screenshotFormat: 'png',
  redactSensitive: true,
  stealth: true,
  autoRestart: 'prompt',
  restartDelayMs: 2500,
  restartGuardMs: 120000,
}

export interface ConfigIssue {
  readonly message: string
  readonly path: readonly string[]
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1']

function endpoint(value: unknown): { value: string } | { issue: ConfigIssue } {
  if (value === undefined || value === null || value === '') return { value: '' }
  if (typeof value !== 'string') return { issue: { message: 'endpoint must be a string', path: ['endpoint'] } }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { issue: { message: 'endpoint must be a valid URL such as http://127.0.0.1:9333', path: ['endpoint'] } }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { issue: { message: 'endpoint must use http or https', path: ['endpoint'] } }
  }
  if (!LOCAL_HOSTS.includes(url.hostname)) {
    return { issue: { message: 'endpoint must point at loopback (127.0.0.1/localhost)', path: ['endpoint'] } }
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { issue: { message: 'endpoint must not carry a path', path: ['endpoint'] } }
  }
  return { value: url.origin }
}

function integer(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): { value: number } | { issue: ConfigIssue } {
  if (value === undefined || value === null) return { value: fallback }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { issue: { message: `${name} must be a finite number`, path: [name] } }
  }
  const rounded = Math.trunc(value)
  if (rounded < min || rounded > max) {
    return { issue: { message: `${name} must be between ${min} and ${max}`, path: [name] } }
  }
  return { value: rounded }
}

function boolean(value: unknown, name: string, fallback: boolean): { value: boolean } | { issue: ConfigIssue } {
  if (value === undefined || value === null) return { value: fallback }
  if (typeof value !== 'boolean') return { issue: { message: `${name} must be a boolean`, path: [name] } }
  return { value }
}

function inspect(raw: unknown): { config: BrowserConfig; issues: ConfigIssue[] } {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const issues: ConfigIssue[] = []
  const pick = <T>(result: { value: T } | { issue: ConfigIssue }, fallback: T): T => {
    if ('issue' in result) {
      issues.push(result.issue)
      return fallback
    }
    return result.value
  }

  let screenshotFormat: 'png' | 'jpeg' = DEFAULTS.screenshotFormat
  if (source.screenshotFormat !== undefined && source.screenshotFormat !== null) {
    if (source.screenshotFormat === 'png' || source.screenshotFormat === 'jpeg') {
      screenshotFormat = source.screenshotFormat
    } else {
      issues.push({ message: 'screenshotFormat must be "png" or "jpeg"', path: ['screenshotFormat'] })
    }
  }

  let autoRestart: 'off' | 'prompt' | 'always' = DEFAULTS.autoRestart
  if (source.autoRestart !== undefined && source.autoRestart !== null) {
    if (source.autoRestart === 'off' || source.autoRestart === 'prompt' || source.autoRestart === 'always') {
      autoRestart = source.autoRestart
    } else {
      issues.push({ message: 'autoRestart must be "off", "prompt" or "always"', path: ['autoRestart'] })
    }
  }

  const config: BrowserConfig = {
    endpoint: pick(endpoint(source.endpoint), DEFAULTS.endpoint),
    allowPageTargets: pick(boolean(source.allowPageTargets, 'allowPageTargets', DEFAULTS.allowPageTargets), false),
    maxNetworkEvents: pick(integer(source.maxNetworkEvents, 'maxNetworkEvents', DEFAULTS.maxNetworkEvents, 10, 10000), 1000),
    maxConsoleEvents: pick(integer(source.maxConsoleEvents, 'maxConsoleEvents', DEFAULTS.maxConsoleEvents, 10, 5000), 500),
    snapshotMaxNodes: pick(integer(source.snapshotMaxNodes, 'snapshotMaxNodes', DEFAULTS.snapshotMaxNodes, 10, 2000), 300),
    navTimeoutMs: pick(integer(source.navTimeoutMs, 'navTimeoutMs', DEFAULTS.navTimeoutMs, 1000, 120000), 15000),
    commandTimeoutMs: pick(
      integer(source.commandTimeoutMs, 'commandTimeoutMs', DEFAULTS.commandTimeoutMs, 1000, 120000),
      30000,
    ),
    maxTextChars: pick(integer(source.maxTextChars, 'maxTextChars', DEFAULTS.maxTextChars, 1000, 200000), 20000),
    screenshotFormat,
    redactSensitive: pick(boolean(source.redactSensitive, 'redactSensitive', DEFAULTS.redactSensitive), true),
    stealth: pick(boolean(source.stealth, 'stealth', DEFAULTS.stealth), true),
    autoRestart,
    restartDelayMs: pick(integer(source.restartDelayMs, 'restartDelayMs', DEFAULTS.restartDelayMs, 500, 30000), 2500),
    restartGuardMs: pick(integer(source.restartGuardMs, 'restartGuardMs', DEFAULTS.restartGuardMs, 10000, 600000), 120000),
  }

  return { config, issues }
}

/** Validate a raw Loader row config into a complete {@link BrowserConfig}. */
export function resolveConfig(raw: unknown): BrowserConfig {
  const { config, issues } = inspect(raw)
  if (issues.length > 0) {
    throw new Error(
      `browser-cdp config: ${issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`,
    )
  }
  return config
}

/** Standard Schema validator consumed by Cordis `resolveConfig`. */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'browser-cdp',
    validate(value: unknown): { value: BrowserConfig } | { issues: readonly ConfigIssue[] } {
      const { config, issues } = inspect(value)
      return issues.length > 0 ? { issues } : { value: config }
    },
  },
}
