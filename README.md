![CI](https://github.com/safumo/dsh-native-browser-bdg/actions/workflows/ci.yml/badge.svg)
[![npm](https://img.shields.io/npm/v/dsh-native-browser-bdg.svg)](https://www.npmjs.com/package/dsh-native-browser-bdg)

# DeepSeek 原生浏览器扩展

**安装名：** [`dsh-native-browser-bdg`](https://www.npmjs.com/package/dsh-native-browser-bdg)  
**仓库：** [`safumo/dsh-native-browser-bdg`](https://github.com/safumo/dsh-native-browser-bdg)

复用 **DeepSeek Harness 官方侧边栏浏览器**（应用内 `<webview>`），在 DSH 窗口里原生运行。

它**不是**外部 Chrome，**不是** Chrome 扩展，也**不需要** Playwright、ChromeDriver、native messaging
或额外的本地服务。自动化直接操作 DSH 右侧栏里已经打开的页面，**无需切屏**、无需切换窗口。

## 它是什么，不是什么

| 是 | 不是 |
|---|---|
| DSH 原生 bundle，注册 `browser_*` 工具 | 外部 Chrome / Edge 实例 |
| 复用官方 Sidebar 的 `<webview>` guest | Chrome Web Store 扩展 |
| 在 DSH 窗口内直接操作页面 | Playwright / Puppeteer / ChromeDriver |
| 需要时自动重启 DSH 以开启应用内调试端口 | 需要手动启动一个带调试端口的 Chrome |
| 页面、Cookie、存储、网络、截图都在 Sidebar 内 | 额外浏览器窗口或切屏操作 |

> 技术上，插件通过 Chromium 调试协议连接 DSH 已经创建的侧边栏 webview。
> 这是**应用内**的侧边栏浏览器，不是外部 Chrome，也不是浏览器扩展。

## 功能

- 导航、前进/后退、刷新
- ARIA 快照和 `e1…eN` ref，click / type / select / hover / scroll / press key / upload
- 文本、HTML、可访问性树读取
- 截图（视口/整页）、Console、网络请求与响应体、性能计数
- Cookie（含 HttpOnly）、`localStorage` / `sessionStorage`
- 一次性 JS 和 **持久用户脚本**（存放在 `$DSH_HOME`，插件/应用重启后重新注入）
- 可选 **stealth 层**：Chrome UA/Client Hints、`window.chrome`、iframe 覆盖
- 自动调试端点：应用未开启时弹窗，OK 后自动重启并连接

## 安装

### DSH 提示框（推荐）

在 DeepSeek Harness 中打开插件安装器，选择 **Enter the plugin's npm package name**，输入：

```
dsh-native-browser-bdg
```

或使用 CLI / pnpm：

```bash
dsh plugin add dsh-native-browser-bdg
# or
pnpm add dsh-native-browser-bdg
```

**npm 包名是 `dsh-native-browser-bdg`**；仓库名是 `safumo/dsh-native-browser-bdg`。
两者不同是正常的：npm 包名与仓库名可以不同，安装时只认 npm 包名。

> 必须先发布到 npm，提示框才能按包名安装。维护者见
> [发布到 npm](#发布到-npm)。

> **从旧版升级：** 早期版本使用 `dsh-browser-cdp` / `browser-cdp` 行。安装本包前
> 先移除/禁用旧 bundle，否则两个行会同时注册 `browser_*` 工具。

安装后重启一次 DeepSeek Harness；bundle patch 会插入 Host 行
`native-browser`。

### GitHub 安装（npm 发布前可用）

```json
{ "action": "install_bundle", "target": "github:safumo/dsh-native-browser-bdg#v1.0.0" }
```

或最新 main：

```json
{ "action": "install_bundle", "target": "github:safumo/dsh-native-browser-bdg" }
```

### 本地路径

```bash
git clone https://github.com/safumo/dsh-native-browser-bdg.git
cd dsh-native-browser-bdg
npm install
npm run build
```

```json
{ "action": "install_bundle", "target": "/absolute/path/to/dsh-native-browser-bdg" }
```

Windows PowerShell：

```json
{ "action": "install_bundle", "target": "C:\\\\Users\\\\<you>\\\\dsh-native-browser-bdg" }
```

如果 DSH 构建要求 `file:` spec，用 `file:C:/Users/<you>/dsh-native-browser-bdg`。

### 安装后

1. 重启 DSH。
2. 打开右侧栏页面，或调用 `browser_navigate`。
3. 执行 `browser_diagnose`。

如果应用启动时没有开启调试端点，插件会在短暂等待后弹窗：
**OK** 自动重启应用并连接，**Cancel** 停止本进程轮询。
也可以随时调用 `browser_enable_cdp`。

## 原生运行，无需切屏

- 不启动外部 Chrome：所有操作作用于 DSH 已经创建的 Sidebar `<webview>`。
- 不创建额外浏览器窗口：页面就在 DSH 右侧栏里，当前窗口内完成。
- 不需要浏览器扩展或 native host：没有 Chrome Web Store、没有 `chrome.debugger`。
- 不需要 Playwright/Puppeteer/ChromeDriver：直接连接应用内 Sidebar guest。
- 默认的 `browser_navigate` 只导航指定 target；如需多标签，使用 Sidebar 自身的标签/`window.open`。

首次安装后可能需要**重启一次 DSH** 来开启应用内调试端口；之后不再需要切屏或切换外部浏览器。

### 调试端点

Chromium 只在浏览器进程初始化时启动调试端口，所以已经在运行的应用不能原地开启。
启动时插件每 3 秒轮询一次：

- 找到端点即停止；
- 超过宽限期仍没有，且当前没有弹窗，显示一个 Cancel/OK 弹窗；
- **OK** 由独立 helper 退出应用，使用空闲端口重启，并等待 `/json/version`；
- **Cancel** 标记为 `cancelled` 并停止轮询；`browser_enable_cdp` 仍然可用。

helper 不硬编码安装路径：

- 应用可执行文件：`process.execPath`
- 主进程：`process.ppid`
- macOS：`osascript` 退出；Windows：`taskkill`
- 启动前删除 `ELECTRON_RUN_AS_NODE`，让 Electron 二进制以应用方式启动
- 端点只在 `/json/version` 响应后写入 `$DSH_HOME/browser-cdp.json`

日志：

- macOS/Linux：`~/.dsh/browser-cdp-restart.log`
- Windows：`%USERPROFILE%\.dsh\browser-cdp-restart.log`
- 可用 `DSH_HOME` 覆盖目录

### macOS 启动器（可选）

`scripts/dsh-native-browser.sh` 是 macOS 便利脚本，通过 bundle id `com.deepseek.dsh`
定位应用，不硬编码 `/Applications/...`：

```bash
scripts/dsh-native-browser.sh            # focus 已连接的应用，或启动未运行的应用
scripts/dsh-native-browser.sh --restart  # 重启一个未开启端点的运行中应用
scripts/dsh-native-browser.sh --prompt   # 重启前询问
```

Windows 不需要这个脚本；使用安装弹窗或 `browser_enable_cdp`。

## 工具

| 工具 | 用途 |
| --- | --- |
| `browser_diagnose` | 端点/target 报告与重启提示 |
| `browser_enable_cdp` | 端点缺失时重启应用并开启调试端口 |
| `browser_list_tabs` | Sidebar target 列表（`targetId`、标题、URL、lease） |
| `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 导航 |
| `browser_snapshot` | 可见交互元素与 `e1…eN` ref |
| `browser_click` / `browser_type` / `browser_select` / `browser_hover` / `browser_scroll` / `browser_press_key` | 输入 |
| `browser_read_page` | `text`、`html`、可访问性树 |
| `browser_screenshot` | 视口或整页截图，作为图片附件 |
| `browser_evaluate` | 主世界 JS，返回 JSON |
| `browser_inject_script` | 一次性 JS，或持久化到 `$DSH_HOME` |
| `browser_list_scripts` | 列出持久脚本和存储路径 |
| `browser_get_cookies` / `browser_set_cookie` | 标签页分区的 Cookie（含 HttpOnly） |
| `browser_get_storage` | `localStorage` / `sessionStorage` |
| `browser_network` / `browser_network_body` | 网络请求与保留的响应体 |
| `browser_console` | Console / Log |
| `browser_upload_file` | `DOM.setFileInputFiles` |
| `browser_metrics` | `Performance.getMetrics` |
| `browser_activate_tab` | 尽力激活 target |

典型流程：`browser_snapshot` → `browser_click` / `browser_type`。
任何主 frame 导航都会使 ref 失效，需要重新快照。

默认 target 是最近使用的标签页。分屏时请显式传 `targetId`，避免命令落到另一屏。

## 配置

bundle 行是 `native-browser`，默认值：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `endpoint` | 空 | 空表示自动发现运行中的应用 |
| `allowPageTargets` | `false` | 默认不驱动 DSH UI 页面；开启也只允许 `http(s)` |
| `maxNetworkEvents` | `1000` | 网络记录上限 |
| `maxConsoleEvents` | `500` | Console 记录上限 |
| `snapshotMaxNodes` | `300` | 快照节点上限 |
| `navTimeoutMs` | `15000` | 导航超时 |
| `commandTimeoutMs` | `30000` | 单条命令超时 |
| `maxTextChars` | `20000` | 文本结果上限 |
| `screenshotFormat` | `png` | `png` 或 `jpeg` |
| `redactSensitive` | `true` | 诊断信息脱敏 |
| `stealth` | `true` | Chrome UA/CH 与 `window.chrome` 补全 |
| `autoRestart` | `prompt` | `off` / `prompt` / `always` |
| `restartDelayMs` | `2500` | 退出应用前等待 |
| `restartGuardMs` | `120000` | 重启尝试最小间隔 |

## 持久用户脚本

`browser_inject_script { source, persist: true }` 写入：

- macOS：`~/.dsh/browser-cdp-scripts.json`
- Windows：`%USERPROFILE%\.dsh\browser-cdp-scripts.json`
- 或 `$DSH_HOME/browser-cdp-scripts.json`

插件会：

- 激活后 1.5 秒读取文件并 attach 当前所有标签页；
- 新标签页出现时自动应用；
- 插件/应用重启或 target 重建后重新安装；
- 用 `browser_list_scripts` 列出；
- 用 `browser_inject_script { remove: "<id>" }` 删除。

脚本对所有 Sidebar 页面生效，拥有页面主世界权限；文件是明文 JSON。
外部编辑后需要重启插件/应用才会重新读取。

示例：

```js
browser_inject_script {
  source: "document.body.insertAdjacentHTML('beforeend', '<div id=\"hello\">hello world</div>')",
  persist: true,
  id: "hello-banner"
}
```

## Stealth（可选）

`stealth: true`（默认）会去掉最常见的 Electron 特征：

- 将 Electron UA 替换为当前 Chromium 版本对应的桌面 Chrome UA；
- 补全 `userAgentData` 的 `Google Chrome` / `Chromium` brand 与 Client Hints；
- 覆盖 `Accept-Language` 和网络 UA；
- 在所有 frame（含 iframe）补 `chrome.app`、`chrome.csi`、`chrome.loadTimes`、`chrome.webstore`。

在 `bot.sannysoft.com` 上，从 Electron/`HEADCHR_IFRAME FAIL` 变为 Chrome 152，
`WebDriver missing`、`PHANTOM_UA`、`HEADCHR_UA`、`HEADCHR_CHROME_OBJ`、
`HEADCHR_IFRAME`、`CHR_DEBUG_TOOLS` 均通过。

限制：

- 在 session attach 之前已加载的页面，首个请求仍可能带 Electron UA；attach 后调用
  `browser_reload`；
- 新标签页的首个请求也可能在 attach 之前发出；彻底无感需要 main 进程
  `webContents.setUserAgent`；
- `chrome.csi` / `chrome.loadTimes` 是 JS shim，检查 `Function.prototype.toString`
  仍可能识别；
- 不伪造 `chrome.runtime`；
- 不保证通过 Cloudflare/Turnstile 或站点自定义风控；
- `cf_clearance` 与 UA 绑定，切换 UA 后应重新登录。

调试时可设 `stealth: false`。

## 分屏探针（客户端 half）

Host bundle 没有直接打开/拆分侧栏的 API：布局属于客户端
`ui-sidebar-right` / `ui-dockkit`。插件包含一个 **opt-in 客户端探针**：

```js
localStorage['dsh-browser-cdp.probe'] = 'split'
```

客户端重载后：

1. 等待 Session 挂载；
2. `ctx.sidebarRight.toggleExpanded()`；
3. `ctx.sidebarRight.split()`；
4. 如果得到新 pane，调用
   `ctx.sidebarRight.openTab('browser', { paneId, params: { url } })`。

结果写入 `localStorage['dsh-browser-cdp.probe.result']`。

前提：

- 客户端 boot graph 已包含本 bundle 的 `./client`（安装后重载/重启）；
- 侧栏少于两个 docked pane；`split()` 在预算已满、pane 为空/浮动、或两半放不下时返回
  `undefined`。

这是开发诊断，不是 Host 工具。要让 agent 工具直接分屏，需要 Host↔client 桥。

## Windows

- 使用官方 DeepSeek Harness 桌面版；预构建 GitHub/npm 安装不需要 Node/npm。
- 弹窗：PowerShell/WPF `MessageBox`（OK/Cancel）。
- 退出：`taskkill /PID`；20 秒未退出则 `/F`。会话保留，但未保存的 UI 状态可能丢失。
- 日志：`%USERPROFILE%\.dsh\browser-cdp-restart.log`。
- 调试端口仅监听 loopback，不需要防火墙入站规则。
- helper 被杀软/EDR 拦截时先看日志；DSH 与 helper 权限不一致也可能导致 `taskkill` 失败。
- `scripts/dsh-native-browser.sh` 仅 macOS；Windows 用 `browser_enable_cdp`。

### Windows 测试清单

1. 安装 DSH，确认侧边栏浏览器可用。
2. 用 npm 包名或本地路径安装。
3. 重启 DSH。
4. `browser_diagnose`。
5. 没有端点时点 OK，或 `browser_enable_cdp`。
6. `browser_navigate https://example.com`，再 `browser_snapshot`。
7. 验证 `browser_list_tabs`、截图、持久脚本。
8. 检查 `%USERPROFILE%\.dsh\browser-cdp-restart.log` 与 `browser-cdp.json`。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 浏览器调试未连接（`CDP: not available`） | 调用 `browser_enable_cdp`；查看重启日志 |
| 弹窗不出现 | `autoRestart: off`；插件未加载；客户端 boot 错误 |
| OK 后应用关闭但不重启 | 重启日志；杀软；手动带调试端口启动 |
| 端点过期 | 删除 `$DSH_HOME/browser-cdp.json` 并重启 |
| 工具作用到另一屏 | 显式传 `browser_list_tabs` 返回的 `targetId` |
| 分屏探针 `pane: null` | 已有两个 docked pane、pane 为空/浮动、或空间不足 |
| 持久脚本缺失 | `browser_list_scripts`；检查路径；外部编辑后重启 |

## 开发

```bash
npm install
npm run typecheck
npm run build
npm run check:lib      # build + 检查提交的 lib/ 是否最新
npm run pack:check     # npm pack --dry-run
```

目录：

```
src/                 Host：工具、浏览器调试 session、重启 helper、stealth
src/client/          可选客户端分屏探针
lib/                 已提交的构建产物（GitHub/npm 安装不需要 tsc）
cordis.patch.yml     bundle 行（native-browser）与桌面限定
locale/              UI 文案
scripts/dsh-native-browser.sh   macOS 可选启动器
```

CI 在 Ubuntu、Windows、macOS 上使用 Node 22 执行 `typecheck`、`build`、
`git diff --exit-code -- lib` 和 `npm pack --dry-run`。

## 发布到 npm

npm 包名是 `dsh-native-browser-bdg`：

```bash
npm login
npm publish
npm view dsh-native-browser-bdg version
```

`prepublishOnly` 会执行 `npm run build`，`lib/` 会先刷新；包是 unscoped，
`publishConfig.access` 为 `public`。

发布后 DSH 提示框即可接受 `dsh-native-browser-bdg`；
`plugin_manager install_bundle dsh-native-browser-bdg@1.0.0` 是等价的工具调用。

## 发布仓库

```bash
git remote -v          # origin 应为 safumo/dsh-native-browser-bdg
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

在 GitHub 创建 Release。用户也可以按 tag 安装：

```text
github:safumo/dsh-native-browser-bdg#v1.0.0
```

`lib/` 是已提交的构建产物，GitHub 安装不需要 Node/TypeScript。不要把 `lib/` 加入
`.gitignore`。

## 已知限制

- 已运行的应用不能原地开启调试端口，需要一次重启。
- 调试端口仅监听 loopback，但能控制整个应用 Chromium；不要暴露到网络。
- 跨域 iframe 不是一等 target，工具作用于主 frame。
- `Page.reload` 会重建 webview 并丢失 session；插件改用 `location.reload()`。
- `targetId` 会在 pane/tab 重建、拖拽后变化，需重新 `browser_list_tabs`。
- 极窄的 Sidebar 可能影响分屏和真实指针输入；用 `browser_evaluate` 兜底。
- Host API 不能直接创建 tab 或 split；见客户端探针。
- 任何 stealth 层都不保证通过 Cloudflare/Turnstile。

## 安全

- 调试端口、Cookie、持久脚本都属于本机敏感能力，不要共享 profile。
- `allowPageTargets` 默认关闭，避免驱动 DSH UI 页面。
- 持久脚本是明文；不要把密钥写进脚本。
- 漏洞请私下联系仓库维护者，不要在公开 issue 中贴敏感信息。

## License

MIT。见 [LICENSE](LICENSE)。
