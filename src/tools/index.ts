/** The `browser_*` tool surface: navigation, inspection, input, storage and media. */

import type { BrowserConfig } from '../config.js'
import { discoverEndpoint } from '../discovery.js'
import { restartGuardActive, spawnRestart } from '../restart.js'
import { clickElement, hoverElement, pressKey, scrollPage, selectOption, typeInto, uploadFiles, type ElementQuery } from '../page/actions.js'
import { readPage, type ReadMode } from '../page/read.js'
import { formatSnapshot, snapshotExpression, type SnapshotNode } from '../page/snapshot.js'
import type { BrowserService } from '../service.js'
import type { ContentBlock, ImageRef, PluginContext, ToolDefinition } from '../types.js'
import { boolArg, decodeBase64, numberArg, parseModifiers, stringArg, ToolError, truncate } from '../util.js'
import { textTool } from './helpers.js'

const TARGET_ID = {
  type: 'string',
  description: 'Target handle from browser_list_tabs. Defaults to the most recently used Sidebar tab.',
}
const REF = {
  type: 'string',
  description: 'Element ref from the latest browser_snapshot, for example "e3".',
}
const SELECTOR = {
  type: 'string',
  description: 'CSS selector, used when a ref is not available.',
}
const ELEMENT_TEXT = {
  type: 'string',
  description: 'Case-insensitive accessible text used to find the element.',
}

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

/** Build every tool bound to one service instance. */
export function createTools(service: BrowserService, ctx: PluginContext, config: BrowserConfig): ToolDefinition[] {
  const targetIdOf = (args: Record<string, unknown>): string | undefined => {
    const value = args.targetId
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }

  const elementQuery = (args: Record<string, unknown>): ElementQuery => {
    const query: { ref?: string; selector?: string; text?: string } = {}
    if (typeof args.ref === 'string' && args.ref !== '') query.ref = args.ref
    if (typeof args.selector === 'string' && args.selector !== '') query.selector = args.selector
    if (typeof args.text === 'string' && args.text !== '') query.text = args.text
    if (query.ref === undefined && query.selector === undefined && query.text === undefined) {
      throw new ToolError('one of ref, selector or text is required', 'INVALID_ARGS')
    }
    return query
  }

  return [
    textTool({
      name: 'browser_diagnose',
      description:
        'Check the Chrome DevTools Protocol endpoint and list the controllable Sidebar browser tabs. ' +
        'Call this first when any other browser_* tool reports CDP_UNAVAILABLE or TARGET_NOT_FOUND.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      concurrencySafe: true,
      run: async () => service.diagnose(),
    }),

    textTool({
      name: 'browser_list_tabs',
      description:
        'List the Sidebar browser tabs the agent can control, most recently used first. ' +
        'Pass a returned targetId to any other browser_* tool; without one, tools act on the first tab.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      concurrencySafe: true,
      run: async () => {
        const tabs = await service.listTabs()
        if (tabs.length === 0) {
          return 'no controllable tabs. Open a page in the right Sidebar Browser, then retry.'
        }
        const lines = [`${tabs.length} controllable tab(s), most recently used first:`]
        tabs.forEach((tab, index) => {
          lines.push(`${index === 0 ? '*' : ' '} ${tab.targetId}  ${tab.title === '' ? '(untitled)' : tab.title}`)
          lines.push(`   ${tab.url}`)
          if (tab.alias !== undefined) lines.push(`   lease: ${tab.alias}`)
        })
        return lines.join('\n')
      },
    }),

    textTool({
      name: 'browser_navigate',
      description:
        'Navigate one Sidebar browser tab to an HTTP(S) URL and wait for the document to settle. ' +
        'Only http and https are accepted; the app origin and local files are rejected.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to load.' },
          targetId: TARGET_ID,
        },
      },
      run: async (args) => {
        const url = httpUrl(stringArg(args.url, 'url'))
        const { session } = await service.session(targetIdOf(args))
        const page = await session.run(() => session.navigate(url))
        return `navigated\nurl: ${page.url}\ntitle: ${page.title}`
      },
    }),

    textTool({
      name: 'browser_back',
      description: 'Go back one entry in the target tab native Chromium history.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { targetId: TARGET_ID },
      },
      run: async (args) => {
        const { session } = await service.session(targetIdOf(args))
        const page = await session.run(() => session.history(-1))
        return `back\nurl: ${page.url}\ntitle: ${page.title}`
      },
    }),

    textTool({
      name: 'browser_forward',
      description: 'Go forward one entry in the target tab native Chromium history.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { targetId: TARGET_ID },
      },
      run: async (args) => {
        const { session } = await service.session(targetIdOf(args))
        const page = await session.run(() => session.history(1))
        return `forward\nurl: ${page.url}\ntitle: ${page.title}`
      },
    }),

    textTool({
      name: 'browser_reload',
      description: 'Reload the current document in the target tab.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { targetId: TARGET_ID },
      },
      run: async (args) => {
        const { session } = await sessionFor(service, targetIdOf(args))
        const page = await session.run(() => session.reload())
        return `reloaded\nurl: ${page.url}\ntitle: ${page.title}`
      },
    }),

    textTool({
      name: 'browser_snapshot',
      description:
        'Return a ref-annotated list of visible interactive elements in the main frame. ' +
        'Call this after every navigation and before clicking or typing: refs are valid only until the next navigation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: TARGET_ID,
          maxNodes: { type: 'integer', description: 'Maximum elements to return.' },
        },
      },
      run: async (args) => {
        const maxNodes = numberArg(args.maxNodes, 'maxNodes', config.snapshotMaxNodes, 10, 2000)
        const { session } = await service.session(targetIdOf(args))
        const nodes = await session.run(async () => {
          const result = await session.evaluate<SnapshotNode[]>(snapshotExpression(maxNodes))
          session.recordSnapshot()
          return result
        })
        const page = await session.pageInfo()
        return [
          `url: ${page.url}`,
          `title: ${page.title}`,
          `${nodes.length} interactive element(s):`,
          formatSnapshot(nodes, config.maxTextChars),
        ].join('\n')
      },
    }),

    textTool({
      name: 'browser_click',
      description:
        'Click a visible element by ref, selector or accessible text. Use browser_snapshot first to obtain a ref. ' +
        'Waits briefly for any navigation the click starts.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { targetId: TARGET_ID, ref: REF, selector: SELECTOR, text: ELEMENT_TEXT },
      },
      run: async (args) => {
        const query = elementQuery(args)
        const { session } = await service.session(targetIdOf(args))
        const result = await session.run(() => clickElement(session, query))
        return [
          `clicked ${result.tag}${result.label === '' ? '' : ` "${result.label}"`}`,
          `url: ${result.page.url}`,
          `title: ${result.page.title}`,
        ].join('\n')
      },
    }),

    textTool({
      name: 'browser_type',
      description:
        'Focus an input by ref or selector, replace its content with the given value, and optionally press Enter. ' +
        'Use browser_snapshot first to obtain a ref.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: {
          targetId: TARGET_ID,
          ref: REF,
          selector: SELECTOR,
          value: { type: 'string', description: 'Text to insert; an empty string clears the field.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
        },
      },
      run: async (args) => {
        const query: { ref?: string; selector?: string; text?: string } = {}
        if (typeof args.ref === 'string' && args.ref !== '') query.ref = args.ref
        if (typeof args.selector === 'string' && args.selector !== '') query.selector = args.selector
        if (query.ref === undefined && query.selector === undefined) {
          throw new ToolError('browser_type requires a ref or selector', 'INVALID_ARGS')
        }
        if (typeof args.value !== 'string') throw new ToolError('value must be a string', 'INVALID_ARGS')
        const { session } = await service.session(targetIdOf(args))
        const result = await session.run(() => typeInto(session, query, args.value as string, boolArg(args.submit, false)))
        return [`typed into the field`, `value: ${result.value}`, `url: ${result.page.url}`, `title: ${result.page.title}`].join(
          '\n',
        )
      },
    }),

    textTool({
      name: 'browser_press_key',
      description:
        'Dispatch one keyboard key to the focused element (Enter, Tab, Escape, ArrowDown, PageDown, F5, a single character, ...). ' +
        'Click the element first to focus it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['key'],
        properties: {
          targetId: TARGET_ID,
          key: { type: 'string', description: 'Key name such as Enter, Tab, Escape, ArrowDown, or a single character.' },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['Alt', 'Ctrl', 'Meta', 'Shift'] },
            description: 'Modifier keys held during the press.',
          },
        },
      },
      run: async (args) => {
        const key = stringArg(args.key, 'key')
        const modifiers = parseModifiers(args.modifiers)
        const { session } = await service.session(targetIdOf(args))
        await session.run(async () => {
          await pressKey(session, key, modifiers)
          await session.afterAction()
        })
        return `pressed ${key}${modifiers === 0 ? '' : ` with modifiers ${modifiers}`}`
      },
    }),

    textTool({
      name: 'browser_select',
      description: 'Select one or more option values on a <select> element identified by ref or selector.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['values'],
        properties: {
          targetId: TARGET_ID,
          ref: REF,
          selector: SELECTOR,
          values: { type: 'array', items: { type: 'string' }, description: 'Option values to select.' },
        },
      },
      run: async (args) => {
        const query: { ref?: string; selector?: string; text?: string } = {}
        if (typeof args.ref === 'string' && args.ref !== '') query.ref = args.ref
        if (typeof args.selector === 'string' && args.selector !== '') query.selector = args.selector
        if (query.ref === undefined && query.selector === undefined) {
          throw new ToolError('browser_select requires a ref or selector', 'INVALID_ARGS')
        }
        const values = Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string') : []
        if (values.length === 0) throw new ToolError('values must contain at least one string', 'INVALID_ARGS')
        const { session } = await service.session(targetIdOf(args))
        const result = await session.run(() => selectOption(session, query, values))
        return [`selected: ${result.selected.join(', ')}`, `url: ${result.page.url}`, `title: ${result.page.title}`].join('\n')
      },
    }),

    textTool({
      name: 'browser_hover',
      description: 'Move the pointer over an element identified by ref, selector or accessible text.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { targetId: TARGET_ID, ref: REF, selector: SELECTOR, text: ELEMENT_TEXT },
      },
      run: async (args) => {
        const query = elementQuery(args)
        const { session } = await service.session(targetIdOf(args))
        const result = await session.run(() => hoverElement(session, query))
        return `hovered "${result.label}"`
      },
    }),

    textTool({
      name: 'browser_scroll',
      description: 'Scroll the page by a vertical delta, or scroll a specific element into view.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: TARGET_ID,
          ref: REF,
          selector: SELECTOR,
          deltaY: { type: 'integer', description: 'Pixels to scroll; positive scrolls down.' },
        },
      },
      run: async (args) => {
        const deltaY = numberArg(args.deltaY, 'deltaY', 600, -20000, 20000)
        const query: { ref?: string; selector?: string; text?: string } = {}
        if (typeof args.ref === 'string' && args.ref !== '') query.ref = args.ref
        if (typeof args.selector === 'string' && args.selector !== '') query.selector = args.selector
        const { session } = await service.session(targetIdOf(args))
        const result = await session.run(() =>
          scrollPage(session, query.ref === undefined && query.selector === undefined ? undefined : query, deltaY),
        )
        return `scrollY: ${result.scrollY}`
      },
    }),

    {
      name: 'browser_screenshot',
      description:
        'Capture a PNG/JPEG screenshot of the target tab and attach it to the conversation. ' +
        'Use fullPage to capture the whole scrollable document instead of the viewport.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: TARGET_ID,
          fullPage: { type: 'boolean', description: 'Capture the whole document instead of the viewport.' },
        },
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string' },
            image: IMAGE_SCHEMA,
          },
        },
        render: (_args, value): ContentBlock[] => {
          const blocks: ContentBlock[] = [{ type: 'text', text: String(value.text ?? '') }]
          if (typeof value.image === 'object' && value.image !== null) {
            blocks.push({ type: 'image', attachment: value.image as ImageRef })
          }
          return blocks
        },
      },
      async execute(args): Promise<Record<string, unknown>> {
        const attachments = ctx.attachments
        if (attachments === undefined) throw new ToolError('the attachment service is required for screenshots', 'NO_ATTACHMENTS')
        const fullPage = boolArg(args.fullPage, false)
        const { session, target } = await service.session(targetIdOf(args))
        const format = config.screenshotFormat
        const shot = await session.run(async () => {
          if (!fullPage) {
            return session.send<{ data?: string }>('Page.captureScreenshot', {
              format,
              ...(format === 'jpeg' ? { quality: 82 } : {}),
            })
          }
          const metrics = await session.send<{ cssContentSize?: { width?: number; height?: number } }>('Page.getLayoutMetrics')
          const width = Math.max(1, Math.ceil(metrics.cssContentSize?.width ?? 0))
          const height = Math.max(1, Math.ceil(metrics.cssContentSize?.height ?? 0))
          return session.send<{ data?: string }>('Page.captureScreenshot', {
            format,
            ...(format === 'jpeg' ? { quality: 82 } : {}),
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height, scale: 1 },
          })
        })
        if (shot.data === undefined || shot.data === '') throw new ToolError('the page produced no screenshot data', 'SCREENSHOT_FAILED')
        const bytes = decodeBase64(shot.data)
        const extension = format === 'jpeg' ? 'jpg' : 'png'
        const name = `browser-${target.targetId.slice(0, 8)}-${Date.now()}.${extension}`
        const image = await attachments.saveImage({ data: bytes, mediaType: `image/${format}`, name })
        const page = await session.pageInfo()
        return {
          text: [
            `screenshot ${image.width}x${image.height} (${image.bytes} bytes)`,
            `url: ${page.url}`,
            `title: ${page.title}`,
          ].join('\n'),
          image,
        }
      },
    },

    textTool({
      name: 'browser_evaluate',
      description:
        'Evaluate a JavaScript expression in the page main world and return its JSON value. ' +
        'Use for page-specific queries the snapshot cannot express; the expression runs with the page privileges.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['expression'],
        properties: {
          targetId: TARGET_ID,
          expression: { type: 'string', description: 'JavaScript expression evaluated in the main frame.' },
          awaitPromise: { type: 'boolean', description: 'Await a returned promise (default true).' },
        },
      },
      run: async (args) => {
        const expression = stringArg(args.expression, 'expression')
        const { session } = await service.session(targetIdOf(args))
        const value = await session.run(() =>
          session.evaluate<unknown>(expression, { awaitPromise: boolArg(args.awaitPromise, true) }),
        )
        const text =
          value === undefined
            ? 'undefined'
            : typeof value === 'string'
              ? value
              : (JSON.stringify(value, null, 2) ?? String(value))
        return truncate(text, config.maxTextChars)
      },
    }),

    textTool({
      name: 'browser_inject_script',
      description:
        'Inject JavaScript into the page main world. By default it runs once immediately. ' +
        'With persist=true it is saved under $DSH_HOME/browser-cdp-scripts.json and re-injected into ' +
        'every new document, including after a plugin or app restart. Remove a persisted script by id.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: TARGET_ID,
          source: { type: 'string', description: 'JavaScript source to execute, or to persist.' },
          persist: { type: 'boolean', description: 'Save the source and run it on every new document.' },
          id: { type: 'string', description: 'Stable id for a persisted script; generated when omitted.' },
          remove: { type: 'string', description: 'Id of a persisted script to delete and uninstall.' },
        },
      },
      run: async (args) => {
        if (typeof args.remove === 'string' && args.remove !== '') {
          const removed = await service.removeScript(args.remove)
          return removed
            ? `removed persisted script ${args.remove}`
            : `no persisted script with id ${args.remove}`
        }
        const source = stringArg(args.source, 'source')
        if (boolArg(args.persist, false)) {
          // Attach the current tab first so the new script is installed immediately.
          await service.session(targetIdOf(args))
          const id = typeof args.id === 'string' && args.id !== '' ? args.id : undefined
          const script = await service.persistScript(source, id)
          return [
            `persistent script: ${script.id}`,
            `store: ${service.listScripts().path}`,
            'It runs on every new document and is restored after a plugin/app restart.',
            `Remove with: browser_inject_script { remove: "${script.id}" }`,
          ].join('\n')
        }
        const { session } = await service.session(targetIdOf(args))
        const value = await session.run(() => session.evaluate<unknown>(source))
        return value === undefined ? 'script executed' : `script executed: ${JSON.stringify(value)}`
      },
    }),

    textTool({
      name: 'browser_list_scripts',
      description:
        'List JavaScript snippets persisted in $DSH_HOME/browser-cdp-scripts.json. ' +
        'They are re-injected into every new document and restored when the plugin restarts.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => {
        const { path, scripts } = service.listScripts()
        if (scripts.length === 0) return `no persistent scripts\nstore: ${path}`
        const lines = [`persistent scripts: ${scripts.length}`, `store: ${path}`, '']
        for (const script of scripts) {
          const preview = script.source.replace(/\s+/g, ' ').slice(0, 120)
          lines.push(`- ${script.id}  updated ${new Date(script.updatedAt).toISOString()}`)
          lines.push(`  ${preview}${script.source.length > 120 ? '…' : ''}`)
        }
        return lines.join('\n')
      },
    }),

    textTool({
      name: 'browser_read_page',
      description:
        'Read the current document as visible text, raw HTML, or a compact accessibility tree. ' +
        'Prefer "aria" for structure and "text" for prose.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: TARGET_ID,
          mode: { type: 'string', enum: ['text', 'html', 'aria'], description: 'Representation to read.' },
        },
      },
      run: async (args) => {
        const mode: ReadMode = args.mode === 'html' || args.mode === 'aria' ? args.mode : 'text'
        const { session } = await service.session(targetIdOf(args))
        return session.run(() => readPage(session, mode, config.maxTextChars))
      },
    }),

    textTool({
      name: 'browser_console',
      description: 'Return recent console and log messages captured from the target tab since it attached.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: TARGET_ID,
          limit: { type: 'integer', description: 'Maximum messages to return (default 100).' },
          level: { type: 'string', description: 'Only return this level, for example error or warning.' },
        },
      },
      concurrencySafe: true,
      run: async (args) => {
        const limit = numberArg(args.limit, 'limit', 100, 1, config.maxConsoleEvents)
        const level = typeof args.level === 'string' ? args.level.toLowerCase() : undefined
        const { session } = await service.session(targetIdOf(args))
        let records = session.console(limit)
        if (level !== undefined) records = records.filter((record) => record.level.toLowerCase() === level)
        if (records.length === 0) return 'no console messages captured'
        return records
          .map((record) => `[${new Date(record.at).toISOString().slice(11, 23)}] ${record.level}: ${record.text}`)
          .join('\n')
      },
    }),

    textTool({
      name: 'browser_network',
      description:
        'Return recent network requests captured from the target tab: method, status, type, size and URL. ' +
        'Use browser_network_body with a requestId for the response body.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: TARGET_ID,
          limit: { type: 'integer', description: 'Maximum requests to return (default 100).' },
          filter: { type: 'string', description: 'Only return URLs containing this substring.' },
        },
      },
      concurrencySafe: true,
      run: async (args) => {
        const limit = numberArg(args.limit, 'limit', 100, 1, config.maxNetworkEvents)
        const filter = typeof args.filter === 'string' && args.filter !== '' ? args.filter.toLowerCase() : undefined
        const { session } = await service.session(targetIdOf(args))
        let records = session.network(limit)
        if (filter !== undefined) records = records.filter((record) => record.url.toLowerCase().includes(filter))
        if (records.length === 0) return 'no network requests captured'
        return records
          .map((record) => {
            const status = record.failed !== undefined ? `FAILED(${record.failed})` : String(record.status ?? '…')
            const size = record.encodedDataLength === undefined ? '' : ` ${formatBytes(record.encodedDataLength)}`
            return `${record.method || '?'} ${status} ${record.resourceType ?? ''}${size} ${record.url}\n  id: ${record.requestId}`
          })
          .join('\n')
      },
    }),

    textTool({
      name: 'browser_network_body',
      description: 'Return the response body for one captured request when Chromium still retains it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['requestId'],
        properties: {
          targetId: TARGET_ID,
          requestId: { type: 'string', description: 'requestId from browser_network.' },
        },
      },
      run: async (args) => {
        const requestId = stringArg(args.requestId, 'requestId')
        const { session } = await service.session(targetIdOf(args))
        const result = await session.responseBody(requestId)
        if (result.base64Encoded) return `base64 body (${result.body.length} chars):\n${truncate(result.body, config.maxTextChars)}`
        return truncate(result.body, config.maxTextChars)
      },
    }),

    textTool({
      name: 'browser_get_cookies',
      description:
        'Read cookies visible to the target tab storage partition, including HttpOnly cookies. ' +
        'Optionally filter by one or more URLs.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: TARGET_ID,
          urls: { type: 'array', items: { type: 'string' }, description: 'Only cookies that would be sent to these URLs.' },
        },
      },
      run: async (args) => {
        const urls = Array.isArray(args.urls)
          ? args.urls.filter((value): value is string => typeof value === 'string' && value !== '')
          : []
        const { session } = await service.session(targetIdOf(args))
        let cookies = await session.cookies()
        if (urls.length > 0) cookies = cookies.filter((cookie) => urls.some((url) => domainMatches(url, cookie.domain)))
        if (cookies.length === 0) return 'no cookies'
        return cookies
          .map((cookie) => {
            const flags = [cookie.httpOnly === true ? 'HttpOnly' : '', cookie.secure === true ? 'Secure' : '']
              .filter(Boolean)
              .join(' ')
            return `${cookie.name}=${truncate(cookie.value, 200)}; domain=${cookie.domain}; path=${cookie.path}${flags === '' ? '' : `; ${flags}`}${cookie.sameSite === undefined ? '' : `; SameSite=${cookie.sameSite}`}`
          })
          .join('\n')
      },
    }),

    textTool({
      name: 'browser_set_cookie',
      description:
        'Set one cookie in the target tab storage partition. Supply url, or domain (optionally with path), plus name and value.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value'],
        properties: {
          targetId: TARGET_ID,
          name: { type: 'string' },
          value: { type: 'string' },
          url: { type: 'string', description: 'Origin URL that determines the default domain and path.' },
          domain: { type: 'string', description: 'Cookie domain when url is omitted.' },
          path: { type: 'string', description: 'Cookie path (default "/").' },
          httpOnly: { type: 'boolean' },
          secure: { type: 'boolean' },
          sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
          expires: { type: 'number', description: 'Unix expiry in seconds; omit for a session cookie.' },
        },
      },
      run: async (args) => {
        const name = stringArg(args.name, 'name')
        if (typeof args.value !== 'string') throw new ToolError('value must be a string', 'INVALID_ARGS')
        const cookie: Record<string, unknown> = { name, value: args.value, path: stringArg(args.path, 'path', '/') }
        if (typeof args.url === 'string' && args.url !== '') cookie.url = httpUrl(args.url)
        else cookie.domain = stringArg(args.domain, 'domain')
        if (typeof args.httpOnly === 'boolean') cookie.httpOnly = args.httpOnly
        if (typeof args.secure === 'boolean') cookie.secure = args.secure
        if (args.sameSite === 'Strict' || args.sameSite === 'Lax' || args.sameSite === 'None') cookie.sameSite = args.sameSite
        if (typeof args.expires === 'number' && Number.isFinite(args.expires)) cookie.expires = Math.trunc(args.expires)
        const { session } = await service.session(targetIdOf(args))
        const ok = await session.setCookie(cookie)
        return ok ? `cookie set: ${name}` : `cookie rejected by Chromium: ${name}`
      },
    }),

    textTool({
      name: 'browser_get_storage',
      description: 'Return localStorage or sessionStorage of the target tab as JSON.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: TARGET_ID,
          type: { type: 'string', enum: ['local', 'session'], description: 'Which Web Storage to read.' },
        },
      },
      run: async (args) => {
        const kind = args.type === 'session' ? 'session' : 'local'
        const { session } = await service.session(targetIdOf(args))
        const values = await session.storage(kind)
        return truncate(JSON.stringify(values, null, 2), config.maxTextChars)
      },
    }),

    textTool({
      name: 'browser_upload_file',
      description:
        'Set files on an <input type="file"> identified by ref or selector. Paths must be absolute and readable by the app.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['files'],
        properties: {
          targetId: TARGET_ID,
          ref: REF,
          selector: SELECTOR,
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths.' },
        },
      },
      run: async (args) => {
        const files = Array.isArray(args.files)
          ? args.files.filter((value): value is string => typeof value === 'string' && value !== '')
          : []
        if (files.length === 0) throw new ToolError('files must contain at least one path', 'INVALID_ARGS')
        const query: { ref?: string; selector?: string; text?: string } = {}
        if (typeof args.ref === 'string' && args.ref !== '') query.ref = args.ref
        if (typeof args.selector === 'string' && args.selector !== '') query.selector = args.selector
        if (query.ref === undefined && query.selector === undefined) {
          throw new ToolError('browser_upload_file requires a ref or selector', 'INVALID_ARGS')
        }
        const { session } = await service.session(targetIdOf(args))
        const result = await session.run(() => uploadFiles(session, query, files))
        return `attached ${result.count} file(s)`
      },
    }),

    textTool({
      name: 'browser_metrics',
      description: 'Return Chromium performance counters for the target tab (nodes, documents, JS heap, layout count).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { targetId: TARGET_ID },
      },
      concurrencySafe: true,
      run: async (args) => {
        const { session } = await service.session(targetIdOf(args))
        const metrics = await session.metrics()
        return Object.entries(metrics)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, value]) => `${name}: ${value}`)
          .join('\n')
      },
    }),

    textTool({
      name: 'browser_enable_cdp',
      description:
        'Detect whether the desktop app is running with the Chrome DevTools Protocol. If it is not, restart the app with ' +
        '--remote-debugging-port=0; the app closes and reopens and the Session history is preserved. ' +
        'Call this after browser_diagnose reports that CDP is unavailable.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delayMs: {
            type: 'integer',
            description: 'How long to wait before the app quits, so this result can be delivered (default 2500 ms).',
          },
        },
      },
      timeoutMs: 15000,
      run: async (args) => {
        try {
          const found = await discoverEndpoint(config)
          return `CDP is already available at ${found.endpoint} (${found.source}).`
        } catch {
          // Not running with CDP; fall through to the restart path.
        }
        if (restartGuardActive(config.restartGuardMs)) {
          return [
            'A CDP restart was attempted in the last few minutes; refusing to restart again to avoid a loop.',
            'Wait for the app to settle, then call browser_diagnose.',
          ].join('\n')
        }
        const delayMs = numberArg(args.delayMs, 'delayMs', config.restartDelayMs, 1000, 30000)
        const result = spawnRestart({ ...config, restartDelayMs: delayMs }, 'tool')
        return [
          `DeepSeek Harness will restart with CDP in ${Math.round(delayMs / 1000)}s.`,
          'The app closes and reopens; the Session history is preserved.',
          'After it reopens, call browser_diagnose and retry the browser action.',
          ...(result.pid === undefined ? [] : [`helper pid: ${result.pid}`]),
        ].join('\n')
      },
    }),

    textTool({
      name: 'browser_activate_tab',
      description: 'Ask Chromium to activate the target tab. Best effort: Sidebar visibility is owned by the app window.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['targetId'],
        properties: { targetId: TARGET_ID },
      },
      run: async (args) => {
        const targetId = stringArg(args.targetId, 'targetId')
        await service.activateTarget(targetId)
        return `activated ${targetId}`
      },
    }),
  ]
}

async function sessionFor(service: BrowserService, targetId?: string) {
  return service.session(targetId)
}

function httpUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ToolError(`not a valid URL: ${value}`, 'INVALID_ARGS')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('only http and https URLs are supported', 'INVALID_URL')
  }
  return url.href
}

function domainMatches(rawUrl: string, cookieDomain: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    const domain = cookieDomain.replace(/^\./, '').toLowerCase()
    return host === domain || host.endsWith(`.${domain}`)
  } catch {
    return false
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
