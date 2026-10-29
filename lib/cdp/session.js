/** One attached CDP target session: domains, buffers, navigation and evaluation. */
import { ConsoleBuffer, RecordBuffer } from '../buffers.js';
import { ToolError, describeError, sleep, truncate } from '../util.js';
function record(value) {
    return typeof value === 'object' && value !== null ? value : undefined;
}
/** Owns a flattened session and serialises commands that mutate the page. */
export class CdpSession {
    targetId;
    pageRev = 0;
    loading = false;
    lastDialog;
    #connection;
    #config;
    #network;
    #console;
    #sessionId;
    #unsubscribe;
    #queue = Promise.resolve();
    #mainFrameId;
    #snapshotRev = -1;
    #initScripts = new Map();
    #disposed = false;
    #lost = false;
    constructor(connection, targetId, config) {
        this.#connection = connection;
        this.targetId = targetId;
        this.#config = config;
        this.#network = new RecordBuffer(config.maxNetworkEvents);
        this.#console = new ConsoleBuffer(config.maxConsoleEvents);
    }
    get attached() {
        return this.#sessionId !== undefined;
    }
    get disposed() {
        return this.#disposed;
    }
    /** True when Chromium dropped the session (for example after a guest recreation). */
    get lost() {
        return this.#lost;
    }
    /** Attach the flattened session and enable the domains tools rely on. */
    async attach() {
        if (this.#sessionId !== undefined)
            return;
        const result = await this.#connection.send('Target.attachToTarget', { targetId: this.targetId, flatten: true }, undefined, 10000);
        const sessionId = result.sessionId;
        if (sessionId === undefined)
            throw new ToolError('CDP did not return a session id', 'CDP_ERROR');
        this.#sessionId = sessionId;
        this.#lost = false;
        this.#unsubscribe = this.#connection.onEvent((method, params, incoming) => {
            if (incoming === sessionId)
                this.#onEvent(method, params);
        });
        await this.send('Page.enable');
        await this.send('Runtime.enable');
        await this.send('Network.enable');
        await this.send('DOM.enable');
        await this.send('Log.enable');
    }
    /** Send one command inside this session. */
    async send(method, params = {}) {
        const sessionId = this.#sessionId;
        if (sessionId === undefined)
            throw new ToolError('CDP session is not attached', 'CDP_UNAVAILABLE');
        try {
            return await this.#connection.send(method, params, sessionId, this.#config.commandTimeoutMs);
        }
        catch (error) {
            if (error instanceof ToolError && /Session with given id not found|No session with given id/i.test(error.message)) {
                this.#lost = true;
                throw new ToolError(`the browser tab was recreated while running ${method}; call browser_list_tabs and retry`, 'SESSION_LOST');
            }
            throw error;
        }
    }
    /** Serialise page-mutating work so input never interleaves with navigation. */
    run(operation) {
        const next = this.#queue.then(operation, operation);
        this.#queue = next.then(() => undefined, () => undefined);
        return next;
    }
    /** Evaluate one expression in the main world and return its JSON value. */
    async evaluate(expression, options = {}) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: options.awaitPromise ?? true,
            userGesture: true,
            includeCommandLineAPI: false,
        });
        if (result.exceptionDetails !== undefined) {
            const details = record(result.exceptionDetails);
            const exception = record(details?.exception);
            const message = exception?.description ?? details?.text ?? 'unknown error';
            throw new ToolError(`page evaluation failed: ${String(message)}`, 'PAGE_ERROR');
        }
        return record(result.result)?.value;
    }
    /** Register a script that runs on every new document. */
    async addInitScript(source, runImmediately = false) {
        const result = await this.send('Page.addScriptToEvaluateOnNewDocument', {
            source,
            runImmediately,
        });
        return result.identifier ?? '';
    }
    /** Remove a previously registered init script by identifier. */
    async removeInitScript(identifier) {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
    /** Install one stored script once per session, keyed by its stable store id. */
    async installInitScript(id, source) {
        if (this.#initScripts.has(id))
            return;
        const identifier = await this.addInitScript(source);
        if (identifier !== '')
            this.#initScripts.set(id, identifier);
    }
    /** Remove a stored script from this session, if present. */
    async uninstallInitScript(id) {
        const identifier = this.#initScripts.get(id);
        if (identifier === undefined)
            return;
        this.#initScripts.delete(id);
        await this.removeInitScript(identifier);
    }
    /** Stable ids currently installed by this session. */
    installedScriptIds() {
        return [...this.#initScripts.keys()];
    }
    /** Current document URL and title, tolerant of navigation in flight. */
    async pageInfo() {
        try {
            return await this.evaluate('({ url: location.href, title: document.title })');
        }
        catch {
            return { url: '', title: '' };
        }
    }
    /**
     * Wait until the page is idle.
     * @param timeoutMs - upper bound; returns false on timeout instead of throwing.
     */
    async settle(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!this.loading) {
                try {
                    if ((await this.evaluate('document.readyState')) === 'complete')
                        return true;
                }
                catch {
                    // The execution context is being replaced by a navigation.
                }
            }
            await sleep(100);
        }
        return false;
    }
    /** Wait for a navigation started by a click or key press. */
    async waitForLoad(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!this.loading) {
                try {
                    if ((await this.evaluate('document.readyState')) === 'complete')
                        return true;
                }
                catch {
                    // Retry until the context settles.
                }
            }
            await sleep(100);
        }
        return false;
    }
    /** Give an action a short window to start and finish a navigation. */
    async afterAction() {
        await sleep(150);
        if (this.loading)
            await this.waitForLoad(this.#config.navTimeoutMs);
        else
            await this.settle(1200);
    }
    /** Navigate the main frame and wait for readiness. */
    async navigate(url) {
        const result = await this.send('Page.navigate', { url });
        if (typeof result.errorText === 'string' && result.errorText !== '') {
            throw new ToolError(`navigation failed: ${result.errorText}`, 'NAV_FAILED');
        }
        await this.settle(this.#config.navTimeoutMs);
        return this.pageInfo();
    }
    /** Move through Chromium's native history by one entry. */
    async history(delta) {
        const history = await this.send('Page.getNavigationHistory');
        const entries = history.entries ?? [];
        const index = (history.currentIndex ?? -1) + delta;
        if (index < 0 || index >= entries.length) {
            throw new ToolError(delta < 0 ? 'no previous history entry' : 'no next history entry', 'NO_HISTORY');
        }
        const entryId = record(entries[index])?.id;
        if (typeof entryId !== 'number')
            throw new ToolError('history entry has no id', 'NO_HISTORY');
        await this.send('Page.navigateToHistoryEntry', { entryId });
        await this.settle(this.#config.navTimeoutMs);
        return this.pageInfo();
    }
    /**
     * Reload the current document.
     *
     * `Page.reload` recreates an Electron `<webview>` guest and therefore kills the CDP
     * session; a script-initiated reload keeps the same target and session.
     */
    async reload() {
        try {
            await this.evaluate('location.reload()');
        }
        catch {
            // The reload tears down the execution context; that is expected.
        }
        await sleep(200);
        await this.settle(this.#config.navTimeoutMs);
        return this.pageInfo();
    }
    /** Remember which document generation the latest ref snapshot belongs to. */
    recordSnapshot() {
        this.#snapshotRev = this.pageRev;
    }
    /** Reject ref-based actions after a navigation replaced the document. */
    requireSnapshot() {
        if (this.#snapshotRev !== this.pageRev) {
            throw new ToolError('the element snapshot is stale; call browser_snapshot again before using refs', 'SNAPSHOT_STALE');
        }
    }
    /** Network records observed since this session attached. */
    network(limit) {
        return this.#network.list(limit);
    }
    /** Console records observed since this session attached. */
    console(limit) {
        return this.#console.list(limit);
    }
    /** Read a response body still retained by the network cache. */
    async responseBody(requestId) {
        const result = await this.send('Network.getResponseBody', { requestId });
        return { body: result.body ?? '', base64Encoded: result.base64Encoded === true };
    }
    /** Every cookie visible to this tab's storage partition, including HttpOnly. */
    async cookies() {
        const result = await this.send('Network.getAllCookies');
        return result.cookies ?? [];
    }
    /** Set one cookie in this tab's storage partition. */
    async setCookie(cookie) {
        const result = await this.send('Network.setCookie', cookie);
        return result.success === true;
    }
    /** Read Web Storage as a plain object. */
    async storage(kind) {
        const store = kind === 'session' ? 'sessionStorage' : 'localStorage';
        return this.evaluate(`Object.fromEntries(Object.entries(${store}))`);
    }
    /** Snapshot Chromium performance counters. */
    async metrics() {
        await this.send('Performance.enable');
        const result = await this.send('Performance.getMetrics');
        const output = {};
        for (const metric of result.metrics ?? []) {
            if (typeof metric.name === 'string' && typeof metric.value === 'number')
                output[metric.name] = metric.value;
        }
        return output;
    }
    /** Detach the session without closing the page. */
    async dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        const sessionId = this.#sessionId;
        this.#sessionId = undefined;
        this.#network.clear();
        this.#console.clear();
        if (sessionId === undefined)
            return;
        try {
            await this.#connection.send('Target.detachFromTarget', { sessionId }, undefined, 5000);
        }
        catch {
            // The target may already be gone.
        }
    }
    #onEvent(method, params) {
        switch (method) {
            case 'Page.frameNavigated': {
                const frame = record(params.frame);
                if (frame !== undefined && frame.parentId === undefined) {
                    if (typeof frame.id === 'string')
                        this.#mainFrameId = frame.id;
                    this.pageRev += 1;
                    this.#snapshotRev = -1;
                }
                break;
            }
            case 'Page.frameStartedLoading': {
                if (this.#mainFrameId === undefined || params.frameId === this.#mainFrameId)
                    this.loading = true;
                break;
            }
            case 'Page.frameStoppedLoading': {
                if (this.#mainFrameId === undefined || params.frameId === this.#mainFrameId)
                    this.loading = false;
                break;
            }
            case 'Page.loadEventFired': {
                this.loading = false;
                break;
            }
            case 'Page.javascriptDialogOpening': {
                this.lastDialog = {
                    type: String(params.type ?? ''),
                    message: String(params.message ?? ''),
                    at: Date.now(),
                };
                break;
            }
            case 'Network.requestWillBeSent': {
                this.#networkRequest(params);
                break;
            }
            case 'Network.responseReceived': {
                this.#networkResponse(params);
                break;
            }
            case 'Network.loadingFinished': {
                this.#networkFinished(params);
                break;
            }
            case 'Network.loadingFailed': {
                this.#networkFailed(params);
                break;
            }
            case 'Runtime.consoleAPICalled': {
                this.#consoleCall(params);
                break;
            }
            case 'Log.entryAdded': {
                this.#logEntry(params);
                break;
            }
            default:
                break;
        }
    }
    #networkRequest(params) {
        const requestId = String(params.requestId ?? '');
        const request = record(params.request);
        if (requestId === '' || request === undefined)
            return;
        const url = String(request.url ?? '');
        const method = String(request.method ?? '');
        const resourceType = typeof params.type === 'string' ? params.type : undefined;
        this.#network.upsert(requestId, () => ({ requestId, url, method, resourceType, finished: false, startedAt: Date.now() }), (current) => ({ ...current, url: url === '' ? current.url : url }));
    }
    #networkResponse(params) {
        const requestId = String(params.requestId ?? '');
        const response = record(params.response);
        if (requestId === '' || response === undefined)
            return;
        this.#network.upsert(requestId, () => ({
            requestId,
            url: String(response.url ?? ''),
            method: '',
            status: Number(response.status ?? 0),
            mimeType: String(response.mimeType ?? ''),
            finished: false,
            startedAt: Date.now(),
        }), (current) => ({
            ...current,
            status: Number(response.status ?? current.status ?? 0),
            mimeType: String(response.mimeType ?? current.mimeType ?? ''),
        }));
    }
    #networkFinished(params) {
        const requestId = String(params.requestId ?? '');
        if (requestId === '')
            return;
        this.#network.upsert(requestId, () => ({ requestId, url: '', method: '', finished: true, startedAt: Date.now() }), (current) => ({
            ...current,
            finished: true,
            encodedDataLength: Number(params.encodedDataLength ?? current.encodedDataLength ?? 0),
        }));
    }
    #networkFailed(params) {
        const requestId = String(params.requestId ?? '');
        if (requestId === '')
            return;
        this.#network.upsert(requestId, () => ({ requestId, url: '', method: '', finished: true, startedAt: Date.now() }), (current) => ({ ...current, finished: true, failed: String(params.errorText ?? 'failed') }));
    }
    #consoleCall(params) {
        const level = String(params.type ?? 'log');
        const args = Array.isArray(params.args) ? params.args : [];
        const parts = [];
        for (const argument of args) {
            const value = record(argument);
            if (value === undefined)
                continue;
            if ('value' in value)
                parts.push(String(value.value));
            else if (typeof value.description === 'string')
                parts.push(value.description);
            else if (typeof value.type === 'string')
                parts.push(value.type);
        }
        this.#console.push({ level, text: truncate(parts.join(' '), 2000), at: Date.now() });
    }
    #logEntry(params) {
        const entry = record(params.entry);
        if (entry === undefined)
            return;
        this.#console.push({
            level: String(entry.level ?? 'info'),
            text: truncate(String(entry.text ?? ''), 2000),
            at: Date.now(),
        });
    }
}
/** Re-exported for callers that only need the error helper. */
export { describeError };
