/** Plugin configuration: endpoint, target policy, buffer caps and timeouts. */
/** Empty endpoint means "discover the running app's DevTools port". */
export const DEFAULT_ENDPOINT = '';
const DEFAULTS = {
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
};
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];
function endpoint(value) {
    if (value === undefined || value === null || value === '')
        return { value: '' };
    if (typeof value !== 'string')
        return { issue: { message: 'endpoint must be a string', path: ['endpoint'] } };
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return { issue: { message: 'endpoint must be a valid URL such as http://127.0.0.1:9333', path: ['endpoint'] } };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { issue: { message: 'endpoint must use http or https', path: ['endpoint'] } };
    }
    if (!LOCAL_HOSTS.includes(url.hostname)) {
        return { issue: { message: 'endpoint must point at loopback (127.0.0.1/localhost)', path: ['endpoint'] } };
    }
    if (url.pathname !== '/' && url.pathname !== '') {
        return { issue: { message: 'endpoint must not carry a path', path: ['endpoint'] } };
    }
    return { value: url.origin };
}
function integer(value, name, fallback, min, max) {
    if (value === undefined || value === null)
        return { value: fallback };
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { issue: { message: `${name} must be a finite number`, path: [name] } };
    }
    const rounded = Math.trunc(value);
    if (rounded < min || rounded > max) {
        return { issue: { message: `${name} must be between ${min} and ${max}`, path: [name] } };
    }
    return { value: rounded };
}
function boolean(value, name, fallback) {
    if (value === undefined || value === null)
        return { value: fallback };
    if (typeof value !== 'boolean')
        return { issue: { message: `${name} must be a boolean`, path: [name] } };
    return { value };
}
function inspect(raw) {
    const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
    const issues = [];
    const pick = (result, fallback) => {
        if ('issue' in result) {
            issues.push(result.issue);
            return fallback;
        }
        return result.value;
    };
    let screenshotFormat = DEFAULTS.screenshotFormat;
    if (source.screenshotFormat !== undefined && source.screenshotFormat !== null) {
        if (source.screenshotFormat === 'png' || source.screenshotFormat === 'jpeg') {
            screenshotFormat = source.screenshotFormat;
        }
        else {
            issues.push({ message: 'screenshotFormat must be "png" or "jpeg"', path: ['screenshotFormat'] });
        }
    }
    let autoRestart = DEFAULTS.autoRestart;
    if (source.autoRestart !== undefined && source.autoRestart !== null) {
        if (source.autoRestart === 'off' || source.autoRestart === 'prompt' || source.autoRestart === 'always') {
            autoRestart = source.autoRestart;
        }
        else {
            issues.push({ message: 'autoRestart must be "off", "prompt" or "always"', path: ['autoRestart'] });
        }
    }
    const config = {
        endpoint: pick(endpoint(source.endpoint), DEFAULTS.endpoint),
        allowPageTargets: pick(boolean(source.allowPageTargets, 'allowPageTargets', DEFAULTS.allowPageTargets), false),
        maxNetworkEvents: pick(integer(source.maxNetworkEvents, 'maxNetworkEvents', DEFAULTS.maxNetworkEvents, 10, 10000), 1000),
        maxConsoleEvents: pick(integer(source.maxConsoleEvents, 'maxConsoleEvents', DEFAULTS.maxConsoleEvents, 10, 5000), 500),
        snapshotMaxNodes: pick(integer(source.snapshotMaxNodes, 'snapshotMaxNodes', DEFAULTS.snapshotMaxNodes, 10, 2000), 300),
        navTimeoutMs: pick(integer(source.navTimeoutMs, 'navTimeoutMs', DEFAULTS.navTimeoutMs, 1000, 120000), 15000),
        commandTimeoutMs: pick(integer(source.commandTimeoutMs, 'commandTimeoutMs', DEFAULTS.commandTimeoutMs, 1000, 120000), 30000),
        maxTextChars: pick(integer(source.maxTextChars, 'maxTextChars', DEFAULTS.maxTextChars, 1000, 200000), 20000),
        screenshotFormat,
        redactSensitive: pick(boolean(source.redactSensitive, 'redactSensitive', DEFAULTS.redactSensitive), true),
        stealth: pick(boolean(source.stealth, 'stealth', DEFAULTS.stealth), true),
        autoRestart,
        restartDelayMs: pick(integer(source.restartDelayMs, 'restartDelayMs', DEFAULTS.restartDelayMs, 500, 30000), 2500),
        restartGuardMs: pick(integer(source.restartGuardMs, 'restartGuardMs', DEFAULTS.restartGuardMs, 10000, 600000), 120000),
    };
    return { config, issues };
}
/** Validate a raw Loader row config into a complete {@link BrowserConfig}. */
export function resolveConfig(raw) {
    const { config, issues } = inspect(raw);
    if (issues.length > 0) {
        throw new Error(`browser-cdp config: ${issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`);
    }
    return config;
}
/** Standard Schema validator consumed by Cordis `resolveConfig`. */
export const Config = {
    '~standard': {
        version: 1,
        vendor: 'browser-cdp',
        validate(value) {
            const { config, issues } = inspect(value);
            return issues.length > 0 ? { issues } : { value: config };
        },
    },
};
