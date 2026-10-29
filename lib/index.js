/** Browser CDP Control — Host half. Registers the `browser_*` tool family. */
import { Config, resolveConfig } from './config.js';
import { discoverEndpoint } from './discovery.js';
import { promptRestart, restartGuardActive, spawnRestart } from './restart.js';
import { BrowserService } from './service.js';
import { createTools } from './tools/index.js';
export { Config };
/** Services this plugin needs; `tools` gates activation, `attachments` enables screenshots. */
export const inject = ['tools', 'attachments'];
const POLL_INTERVAL_MS = 3000;
const INITIAL_DELAY_MS = 3000;
/** Do not prompt during the first seconds, while DevToolsActivePort may still be written. */
const STARTUP_GRACE_MS = 6000;
const AUTO_RESTART_STATE = Symbol.for('dsh.browser-cdp.auto-restart-state');
/** Process-scoped state shared across plugin reloads; a new app process starts at `ask`. */
function autoRestartState() {
    const store = globalThis;
    let state = store[AUTO_RESTART_STATE];
    if (state === undefined) {
        state = { decision: 'ask', prompting: false, timer: undefined, startedAt: Date.now() };
        store[AUTO_RESTART_STATE] = state;
    }
    return state;
}
/**
 * Poll for a CDP endpoint. While the state says `ask` and no dialog is open,
 * offer the restart once per tick; Cancel stops the poll for this process.
 * @param ctx - plugin context whose effect owns the timer.
 * @param config - resolved plugin configuration.
 */
function startAutoRestart(ctx, config) {
    const state = autoRestartState();
    if (state.decision !== 'ask')
        return;
    let disposed = false;
    const stop = (decision) => {
        state.decision = decision;
        if (state.timer !== undefined) {
            clearTimeout(state.timer);
            state.timer = undefined;
        }
    };
    const schedule = (delay) => {
        if (disposed || state.decision !== 'ask')
            return;
        if (state.timer !== undefined)
            clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            void tick();
        }, delay);
    };
    const tick = async () => {
        state.timer = undefined;
        if (disposed || state.decision !== 'ask' || state.prompting)
            return;
        try {
            await discoverEndpoint(config);
            stop('done');
            return;
        }
        catch {
            // No endpoint; keep waiting through the startup grace period.
        }
        if (Date.now() - state.startedAt < STARTUP_GRACE_MS) {
            schedule(POLL_INTERVAL_MS);
            return;
        }
        if (restartGuardActive(config.restartGuardMs)) {
            schedule(POLL_INTERVAL_MS);
            return;
        }
        if (config.autoRestart === 'always') {
            try {
                spawnRestart(config, 'poll-always');
                stop('done');
            }
            catch (error) {
                console.error('browser-cdp: automatic restart failed', error);
                stop('cancelled');
            }
            return;
        }
        if (state.prompting)
            return;
        state.prompting = true;
        try {
            const choice = await promptRestart(config);
            if (choice === 'restart') {
                try {
                    spawnRestart({ ...config, restartDelayMs: 500 }, 'poll-prompt');
                    stop('done');
                }
                catch (error) {
                    console.error('browser-cdp: prompted restart failed', error);
                    stop('cancelled');
                }
            }
            else {
                // Cancel, timeout or osascript unavailable: do not ask again in this process.
                stop('cancelled');
            }
        }
        finally {
            state.prompting = false;
        }
    };
    schedule(INITIAL_DELAY_MS);
    ctx.effect(() => () => {
        disposed = true;
        if (state.timer !== undefined) {
            clearTimeout(state.timer);
            state.timer = undefined;
        }
    }, 'browser-cdp: auto restart poll');
}
/** The plugin only works inside the Electron desktop host, never in a plain Web page. */
function isDesktopHost() {
    const node = globalThis.process;
    return typeof node?.versions?.electron === 'string' && node.versions.electron !== '';
}
/**
 * Register the browser tools against the mounted tool registry.
 * @param ctx - plugin context carrying `tools` and `attachments`.
 * @param config - resolved Loader row configuration.
 */
export function apply(ctx, config = {}) {
    if (!isDesktopHost()) {
        console.info('browser-cdp: desktop-only plugin; disabled in this runtime');
        return;
    }
    const resolved = resolveConfig(config);
    const service = new BrowserService(resolved);
    for (const tool of createTools(service, ctx, resolved))
        ctx.tools.register(tool);
    ctx.effect(() => () => {
        void service.dispose();
    }, 'browser-cdp: service');
    // Re-apply userscripts saved under $DSH_HOME after a plugin/app restart.
    ctx.effect(() => {
        let cancelled = false;
        const timer = setTimeout(() => {
            if (!cancelled)
                void service.restoreScripts().catch(() => undefined);
        }, 1500);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, 'browser-cdp: restore persistent scripts');
    if (resolved.autoRestart !== 'off')
        startAutoRestart(ctx, resolved);
}
