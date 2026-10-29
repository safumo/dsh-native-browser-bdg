window.__ModuleLoader__.load({
  id: "dsh-native-browser-bdg",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
/**
 * Client half: an opt-in probe that can split the right Sidebar and open a
 * browser tab in the new pane. It is inert unless
 * `localStorage['dsh-native-browser-bdg.probe'] === 'split'`.
 */
const inject = ['sidebarRight'];
const PROBE_KEY = 'dsh-native-browser-bdg.probe';
const RESULT_KEY = 'dsh-native-browser-bdg.probe.result';
const RETRY_MS = 500;
const MAX_ATTEMPTS = 40;
/**
 * Run the split probe once, after the client has mounted a Session.
 * @param ctx - client plugin context carrying `sidebarRight`.
 */
function apply(ctx) {
    if (typeof localStorage === 'undefined' || localStorage.getItem(PROBE_KEY) !== 'split')
        return;
    localStorage.removeItem(PROBE_KEY);
    let attempts = 0;
    let timer;
    const stop = () => {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };
    const result = (value) => {
        try {
            localStorage.setItem(RESULT_KEY, JSON.stringify(value));
        }
        catch {
            // The probe is diagnostic; storage failures are not fatal.
        }
    };
    timer = setInterval(() => {
        attempts += 1;
        if (attempts > MAX_ATTEMPTS) {
            stop();
            result({ ok: false, reason: 'timeout waiting for a mounted Session' });
            return;
        }
        if (ctx.sidebarRight.mounted.getSnapshot() === undefined)
            return;
        stop();
        ctx.sidebarRight.toggleExpanded();
        const pane = ctx.sidebarRight.split();
        result({ ok: pane !== undefined, expanded: ctx.sidebarRight.isExpanded(), pane: pane ?? null });
        if (pane !== undefined) {
            ctx.sidebarRight.openTab('browser', {
                paneId: pane,
                params: { url: 'https://example.com/?from=client-split-probe' },
            });
        }
    }, RETRY_MS);
    ctx.effect(() => stop, 'native-browser: split probe');
}

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  }
});
