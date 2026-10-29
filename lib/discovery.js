/** Finds the running desktop app's DevTools endpoint without user configuration. */
import { ToolError, describeError } from './util.js';
const runtime = globalThis.process;
function readText(path) {
    try {
        const fs = runtime?.getBuiltinModule?.('node:fs');
        if (fs === undefined)
            return undefined;
        return fs.readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
}
function homeDirectory() {
    return runtime?.env.HOME ?? runtime?.env.USERPROFILE ?? '';
}
function dshHome() {
    const explicit = runtime?.env.DSH_HOME;
    if (explicit !== undefined && explicit !== '')
        return explicit;
    const home = homeDirectory();
    return home === '' ? '' : `${home}/.dsh`;
}
/** Electron stores `DevToolsActivePort` beside the app's user data. */
function userDataDirectories() {
    const home = homeDirectory();
    const appData = runtime?.env.APPDATA ?? '';
    const platform = runtime?.platform ?? '';
    // DSH keeps app.name as @deepseek-ai/dsh-desktop, so Electron's userData is scoped.
    const names = ['@deepseek-ai/dsh-desktop', 'dsh-desktop', 'DeepSeek Harness'];
    const directories = [];
    for (const name of names) {
        if (platform === 'darwin')
            directories.push(`${home}/Library/Application Support/${name}`);
        else if (platform === 'win32')
            directories.push(`${appData}\\${name}`);
        else if (home !== '')
            directories.push(`${home}/.config/${name}`);
    }
    return directories.filter((directory) => directory !== '');
}
async function probe(endpoint, timeoutMs = 800) {
    try {
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
        return response.ok;
    }
    catch {
        return false;
    }
}
function endpointOfPort(raw) {
    return /^\d+$/.test(raw) ? `http://127.0.0.1:${raw}` : undefined;
}
/**
 * Resolve the CDP endpoint for the running app.
 *
 * Order: explicit config, a launcher-published file, Chromium's
 * `DevToolsActivePort`, then the conventional ports.
 */
export async function discoverEndpoint(config) {
    if (config.endpoint !== '')
        return { endpoint: config.endpoint, source: 'config' };
    const publishedPath = `${dshHome()}/browser-cdp.json`;
    const published = readText(publishedPath);
    if (published !== undefined) {
        try {
            const parsed = JSON.parse(published);
            const endpoint = typeof parsed.endpoint === 'string'
                ? parsed.endpoint
                : typeof parsed.port === 'number'
                    ? `http://127.0.0.1:${parsed.port}`
                    : undefined;
            if (endpoint !== undefined && (await probe(endpoint))) {
                return { endpoint, source: `file:${publishedPath}` };
            }
        }
        catch {
            // Ignore malformed launcher files and keep looking.
        }
    }
    for (const directory of userDataDirectories()) {
        const portFile = `${directory}/DevToolsActivePort`;
        const contents = readText(portFile);
        if (contents === undefined)
            continue;
        const port = contents.split(/\r?\n/)[0]?.trim() ?? '';
        const endpoint = endpointOfPort(port);
        if (endpoint === undefined)
            continue;
        if (await probe(endpoint))
            return { endpoint, source: `DevToolsActivePort:${portFile}` };
    }
    for (const port of [9333, 9222]) {
        const endpoint = `http://127.0.0.1:${port}`;
        if (await probe(endpoint))
            return { endpoint, source: `probe:${port}` };
    }
    throw new ToolError([
        'no Chrome DevTools endpoint was found for the desktop app.',
        '',
        'The app is running without remote debugging. Ask the agent to call',
        'browser_enable_cdp, or use the bundled launcher:',
        '',
        `  ${launcherPath()} --restart`,
        '',
        'With autoRestart: "prompt" (default) the plugin asks at startup; with',
        '"always" it restarts silently. Verify with:',
        '',
        '  lsof -nP -iTCP -sTCP:LISTEN | grep "DeepSeek"',
    ].join('\n'), 'CDP_UNAVAILABLE');
}
/** Absolute path of the launcher shipped beside this plugin. */
export function launcherPath() {
    try {
        return decodeURIComponent(new URL('../scripts/dsh-cdp.sh', import.meta.url).pathname);
    }
    catch {
        return 'scripts/dsh-cdp.sh';
    }
}
/** Short one-line reason for diagnostics. */
export function discoveryFailure(error) {
    return describeError(error);
}
