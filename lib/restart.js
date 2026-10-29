/** Detect a missing CDP endpoint and relaunch the desktop app with remote debugging. */
import { ToolError } from './util.js';
const runtime = globalThis.process;
/** The cross-platform helper that quits, relaunches and verifies CDP. */
const HELPER_SOURCE = [
    "'use strict'",
    "const { execFile, spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const http = require('node:http')",
    "const net = require('node:net')",
    "const path = require('node:path')",
    '',
    "const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))",
    'const log = (message) => { try { fs.appendFileSync(plan.logFile, "[" + new Date().toISOString() + "] " + message + "\\n") } catch {} }',
    'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
    'const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }',
    'const freePort = () => new Promise((resolve, reject) => {',
    '  const server = net.createServer()',
    '  server.unref()',
    "  server.on('error', reject)",
    "  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })",
    '})',
    'const cdpUp = (port) => new Promise((resolve) => {',
    "  const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (response) => { response.resume(); resolve(response.statusCode === 200) })",
    '  request.on("error", () => resolve(false))',
    '  request.on("timeout", () => { request.destroy(); resolve(false) })',
    '})',
    'const run = (file, args) => new Promise((resolve) => { execFile(file, args, { timeout: 15000 }, () => resolve()) })',
    '',
    'async function quitApp() {',
    "  if (process.platform === 'darwin' && plan.appName) {",
    '    await run("osascript", ["-e", \'quit app "\' + String(plan.appName).replace(/"/g, "") + \'"\'])',
    "  } else if (process.platform === 'win32') {",
    '    await run("taskkill", ["/PID", String(plan.appPid)])',
    '  } else {',
    '    try { process.kill(plan.appPid, "SIGTERM") } catch {}',
    '  }',
    '  const deadline = Date.now() + 20000',
    '  while (alive(plan.appPid) && Date.now() < deadline) await sleep(250)',
    '  if (alive(plan.appPid)) {',
    "    if (process.platform === 'win32') {",
    '      await run("taskkill", ["/PID", String(plan.appPid), "/F"])',
    '    } else {',
    '      try { process.kill(plan.appPid, "SIGKILL") } catch {}',
    '    }',
    '    await sleep(500)',
    '  }',
    '  return !alive(plan.appPid)',
    '}',
    '',
    'async function launch(port) {',
    '  const env = { ...process.env }',
    '  delete env.ELECTRON_RUN_AS_NODE',
    '  const child = spawn(plan.appExe, ["--remote-debugging-port=" + port], {',
    "    detached: true, stdio: 'ignore', env, cwd: path.dirname(plan.appExe),",
    '  })',
    '  child.unref()',
    '  return child',
    '}',
    '',
    'async function main() {',
    '  log("restart requested (" + (plan.reason || "manual") + ") exe=" + plan.appExe + " pid=" + plan.appPid)',
    '  await sleep(plan.delayMs || 0)',
    '  if (!(await quitApp())) { log("app did not quit; aborting"); process.exit(3) }',
    '  await sleep(1000)',
    '  for (let attempt = 0; attempt < 2; attempt += 1) {',
    '    const port = await freePort()',
    '    fs.writeFileSync(plan.endpointFile, JSON.stringify({ endpoint: "http://127.0.0.1:" + port, state: "starting", at: Date.now() }) + "\\n")',
    '    const child = await launch(port)',
    '    log("launched " + plan.appExe + " --remote-debugging-port=" + port + " pid=" + child.pid)',
    '    const deadline = Date.now() + 30000',
    '    while (Date.now() < deadline) {',
    '      if (await cdpUp(port)) {',
    '        fs.writeFileSync(plan.endpointFile, JSON.stringify({ endpoint: "http://127.0.0.1:" + port, state: "ready", appPid: child.pid, at: Date.now() }) + "\\n")',
    '        log("CDP ready on port " + port)',
    '        process.exit(0)',
    '      }',
    '      if (child.pid && !alive(child.pid)) { log("launched app exited early"); break }',
    '      await sleep(250)',
    '    }',
    '    try { if (child.pid) process.kill(child.pid, "SIGTERM") } catch {}',
    '    await sleep(500)',
    '  }',
    '  log("restart failed: no CDP endpoint")',
    '  process.exit(4)',
    '}',
    '',
    'main().catch((error) => { log("helper failed: " + (error && error.stack ? error.stack : error)); process.exit(5) })',
].join('\n');
/** The generated CommonJS helper source (exposed for diagnostics and tests). */
export function buildRestartHelperSource() {
    return HELPER_SOURCE;
}
function childProcess() {
    return runtime?.getBuiltinModule?.('node:child_process');
}
function fileSystem() {
    return runtime?.getBuiltinModule?.('node:fs');
}
function homeDirectory() {
    return runtime?.env.HOME ?? runtime?.env.USERPROFILE ?? '';
}
function dshHome() {
    const explicit = runtime?.env.DSH_HOME;
    if (explicit !== undefined && explicit !== '')
        return explicit;
    const home = homeDirectory();
    return home === '' ? '.' : `${home}/.dsh`;
}
function stampPath() {
    return `${dshHome()}/browser-cdp-restart.stamp`;
}
function basename(value) {
    const parts = value.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? value;
}
/**
 * Whether a restart attempt happened inside the guard window.
 * @param guardMs - minimum spacing between automatic attempts.
 */
export function restartGuardActive(guardMs) {
    try {
        const raw = fileSystem()?.readFileSync(stampPath(), 'utf8');
        if (raw === undefined)
            return false;
        const at = Number(raw.trim());
        return Number.isFinite(at) && at > 0 && Date.now() - at < guardMs;
    }
    catch {
        return false;
    }
}
/** Resolve the running app from process.execPath and its parent PID. */
export function resolveRestartTarget() {
    const appExe = runtime?.execPath;
    const appPid = runtime?.ppid;
    if (appExe === undefined || appExe === '') {
        throw new ToolError('cannot resolve the desktop executable from process.execPath', 'RESTART_UNAVAILABLE');
    }
    if (appPid === undefined || appPid <= 0) {
        throw new ToolError('cannot resolve the desktop main process from process.ppid', 'RESTART_UNAVAILABLE');
    }
    const bundleMatch = /^(.*?\.app)[\\/]Contents[\\/]MacOS[\\/]/i.exec(appExe);
    const appBundle = bundleMatch?.[1];
    const appName = appBundle !== undefined
        ? basename(appBundle).replace(/\.app$/i, '')
        : basename(appExe).replace(/\.exe$/i, '');
    return { appExe, appPid, appName, ...(appBundle === undefined ? {} : { appBundle }) };
}
/**
 * Spawn the Node helper detached. It quits the app, relaunches it with a free
 * CDP port, and publishes the endpoint only after `/json/version` responds.
 * @param config - resolved plugin configuration.
 * @param reason - diagnostic label (`poll-prompt`, `tool`, ...).
 */
export function spawnRestart(config, reason) {
    if (restartGuardActive(config.restartGuardMs)) {
        throw new ToolError('a CDP restart was attempted recently; refusing to restart again to avoid a loop', 'RESTART_THROTTLED');
    }
    const cp = childProcess();
    const fs = fileSystem();
    if (cp === undefined || fs === undefined) {
        throw new ToolError('this runtime cannot spawn a restart helper', 'RESTART_UNAVAILABLE');
    }
    const target = resolveRestartTarget();
    const home = dshHome();
    const helperPath = `${home}/browser-cdp-restart-helper.cjs`;
    const planPath = `${home}/browser-cdp-restart-plan.json`;
    const logFile = `${home}/browser-cdp-restart.log`;
    const endpointFile = `${home}/browser-cdp.json`;
    fs.writeFileSync(helperPath, HELPER_SOURCE);
    fs.writeFileSync(planPath, `${JSON.stringify({
        appExe: target.appExe,
        appPid: target.appPid,
        appName: target.appName,
        appBundle: target.appBundle,
        logFile,
        endpointFile,
        delayMs: config.restartDelayMs,
        reason,
    })}\n`);
    const child = cp.spawn(target.appExe, [helperPath, planPath], {
        detached: true,
        stdio: 'ignore',
        env: { ...runtime?.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    try {
        fs.writeFileSync(stampPath(), String(Date.now()));
    }
    catch {
        // The guard is best effort.
    }
    return { pid: child.pid, helper: helperPath, plan: planPath };
}
/** Run one native dialog; `restart` means OK/Yes, `later` means Cancel. */
function runDialog(cp, command, args, decide) {
    return new Promise((resolve) => {
        let stdout = '';
        let settled = false;
        let child;
        let timer;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            resolve(value);
        };
        try {
            child = cp.spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
            child.stdout?.on('data', (chunk) => {
                stdout += String(chunk);
            });
            child.on('error', () => finish('unavailable'));
            child.on('close', (code) => finish(decide(stdout, code)));
            timer = setTimeout(() => {
                try {
                    child?.kill?.();
                }
                catch {
                    // Already gone.
                }
                finish('later');
            }, 60000);
        }
        catch {
            finish('unavailable');
        }
    });
}
/**
 * Ask the user once, on the host platform.
 * @returns `restart` when confirmed, `later` when declined, `unavailable` without a dialog.
 */
export function promptRestart(config) {
    void config;
    const cp = childProcess();
    if (cp === undefined)
        return Promise.resolve('unavailable');
    const message = '当前启动未开启浏览器调试（CDP），插件无法控制侧栏浏览器。是否重启 DeepSeek Harness 以开启？会话记录会保留。';
    const platform = runtime?.platform ?? '';
    if (platform === 'darwin') {
        const script = `display dialog "${message}" buttons {"Cancel", "OK"} default button "Cancel" with icon caution`;
        return runDialog(cp, '/usr/bin/osascript', ['-e', script], (stdout) => stdout.includes('button returned:OK') ? 'restart' : 'later');
    }
    if (platform === 'win32') {
        const script = [
            'Add-Type -AssemblyName PresentationFramework',
            `$r = [System.Windows.MessageBox]::Show("${message}", "DeepSeek Harness", "OKCancel", "Warning")`,
            'if ($r -eq "OK") { exit 0 } else { exit 1 }',
        ].join('; ');
        return runDialog(cp, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (_stdout, code) => code === 0 ? 'restart' : 'later');
    }
    return runDialog(cp, 'zenity', ['--question', `--text=${message}`, '--ok-label=OK', '--cancel-label=Cancel'], (_stdout, code) => (code === 0 ? 'restart' : 'later'));
}
