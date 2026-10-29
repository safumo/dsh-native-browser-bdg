/** Normalise the Electron fingerprint that sites commonly flag as automation. */
const runtime = globalThis.process;
/** Add the chrome.* surface that a normal desktop Chrome page exposes. */
const CHROME_PATCH = [
    '(() => {',
    '  try {',
    '    const define = (target, key, value) => {',
    '      try { Object.defineProperty(target, key, { value, configurable: true, enumerable: false, writable: true }); }',
    '      catch { try { target[key] = value; } catch {} }',
    '    };',
    '    if (!window.chrome) define(window, "chrome", {});',
    '    const chrome = window.chrome;',
    '    if (!chrome.app) define(chrome, "app", {',
    '      getDetails: function getDetails() { return null; },',
    '      getIsInstalled: function getIsInstalled() { return false; },',
    '      installState: function installState() { return "not_installed"; },',
    '      runningState: function runningState() { return "cannot_run"; }',
    '    });',
    '    if (!chrome.csi) define(chrome, "csi", function csi() {',
    '      const t = performance.timing || {};',
    '      const start = t.navigationStart || 0;',
    '      return { startE: start, onloadT: t.domContentLoadedEventEnd || 0, pageT: Date.now() - (start || Date.now()), tran: 15 };',
    '    });',
    '    if (!chrome.loadTimes) define(chrome, "loadTimes", function loadTimes() {',
    '      const t = performance.timing || {};',
    '      const s = 1000;',
    '      return {',
    '        requestTime: (t.navigationStart || 0) / s,',
    '        startLoadTime: (t.navigationStart || 0) / s,',
    '        commitLoadTime: (t.responseStart || 0) / s,',
    '        finishDocumentLoadTime: (t.domContentLoadedEventEnd || 0) / s,',
    '        finishLoadTime: (t.loadEventEnd || 0) / s,',
    '        firstPaintTime: (t.responseStart || 0) / s,',
    '        firstPaintAfterLoadTime: 0,',
    '        navigationType: "Other",',
    '        wasFetchedViaSpdy: true,',
    '        wasNpnNegotiated: true,',
    '        npnNegotiatedProtocol: "h2",',
    '        wasAlternateProtocolAvailable: false,',
    '        connectionInfo: "h2"',
    '      };',
    '    });',
    '    if (!chrome.webstore) define(chrome, "webstore", { install: function install() {} });',
    '  } catch {}',
    '})()',
].join('\n');
function platformParts() {
    const platform = runtime?.platform ?? '';
    if (platform === 'darwin') {
        return {
            name: 'macOS',
            ua: 'Macintosh; Intel Mac OS X 10_15_7',
            navigatorPlatform: 'MacIntel',
            architecture: 'arm',
        };
    }
    if (platform === 'win32') {
        return {
            name: 'Windows',
            ua: 'Windows NT 10.0; Win64; x64',
            navigatorPlatform: 'Win32',
            architecture: 'x86',
        };
    }
    return {
        name: 'Linux',
        ua: 'X11; Linux x86_64',
        navigatorPlatform: 'Linux x86_64',
        architecture: 'x86',
    };
}
function acceptLanguage(languages) {
    // Chrome copies this value into navigator.languages verbatim, so no q-values.
    return languages.join(',');
}
/**
 * Replace the Electron UA/Client Hints with a desktop Chrome identity and add
 * the missing chrome.* helpers. Applied once per attached session; a reload is
 * needed before the override is visible to the current document.
 * @param session - attached page session.
 * @param config - resolved plugin configuration.
 */
export async function applyStealth(session, config) {
    if (!config.stealth)
        return;
    let rawUserAgent = '';
    try {
        rawUserAgent = await session.evaluate('navigator.userAgent');
    }
    catch {
        return;
    }
    const version = /Chrome\/([\d.]+)/.exec(rawUserAgent)?.[1] ?? '152.0.0.0';
    const major = version.split('.')[0] ?? '152';
    let high = {};
    try {
        high = await session.evaluate([
            '(async () => {',
            '  const d = navigator.userAgentData;',
            "  const h = d ? await d.getHighEntropyValues(['architecture','bitness','model','platformVersion']) : {};",
            '  return { languages: navigator.languages, platform: navigator.platform, ...h };',
            '})()',
        ].join('\n'));
    }
    catch {
        high = {};
    }
    const parts = platformParts();
    const languages = Array.isArray(high.languages) && high.languages.length > 0 ? high.languages : ['en-US', 'en'];
    const platformVersion = typeof high.platformVersion === 'string' && high.platformVersion !== ''
        ? high.platformVersion
        : parts.name === 'macOS'
            ? '15.0.0'
            : parts.name === 'Windows'
                ? '10.0.0'
                : '6.0.0';
    const architecture = typeof high.architecture === 'string' && high.architecture !== '' ? high.architecture : parts.architecture;
    const bitness = typeof high.bitness === 'string' && high.bitness !== '' ? high.bitness : '64';
    const navigatorPlatform = typeof high.platform === 'string' && high.platform !== '' ? high.platform : parts.navigatorPlatform;
    const userAgent = `Mozilla/5.0 (${parts.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    const language = acceptLanguage(languages);
    const userAgentMetadata = {
        brands: [
            { brand: 'Not?A_Brand', version: '24' },
            { brand: 'Chromium', version: major },
            { brand: 'Google Chrome', version: major },
        ],
        fullVersionList: [
            { brand: 'Not?A_Brand', version: '24.0.0.0' },
            { brand: 'Chromium', version },
            { brand: 'Google Chrome', version },
        ],
        fullVersion: version,
        platform: parts.name,
        platformVersion,
        architecture,
        model: typeof high.model === 'string' ? high.model : '',
        mobile: false,
        bitness,
        wow64: false,
    };
    const override = {
        userAgent,
        acceptLanguage: language,
        platform: navigatorPlatform,
        userAgentMetadata,
    };
    try {
        await session.send('Emulation.setUserAgentOverride', override);
    }
    catch (error) {
        console.warn('browser-cdp: could not override the JS user agent', error);
    }
    try {
        await session.send('Network.setUserAgentOverride', override);
    }
    catch (error) {
        console.warn('browser-cdp: could not override the network user agent', error);
    }
    try {
        await session.addInitScript(CHROME_PATCH, true);
    }
    catch {
        await session.addInitScript(CHROME_PATCH).catch(() => undefined);
    }
}
