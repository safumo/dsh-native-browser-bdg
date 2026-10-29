/** Element resolution and CDP input actions: click, type, select, scroll, upload. */

import type { CdpSession, PageInfo } from '../cdp/session.js'
import { ToolError, keyInfo, sleep } from '../util.js'

export interface ElementQuery {
  readonly ref?: string
  readonly selector?: string
  readonly text?: string
}

interface ElementBox {
  readonly ok: true
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly tag: string
  readonly label: string
}

interface ResolveFailure {
  readonly ok: false
  readonly reason: 'not-found' | 'not-visible' | 'error'
  readonly message?: string
}

/** Build the injected expression that resolves a query into viewport coordinates. */
function elementExpression(query: ElementQuery): string {
  const literal = JSON.stringify(query)
  return `(() => {
  const q = ${literal};
  let el = null;
  try {
    if (q.ref) {
      el = document.querySelector('[data-dsh-ref="' + String(q.ref).replace(/"/g, '') + '"]');
      if (!el) return { ok: false, reason: 'not-found', message: 'the ref is no longer in the document; take a new snapshot' };
    } else if (q.selector) {
      el = document.querySelector(q.selector);
    } else if (q.text) {
      const wanted = String(q.text).replace(/\\s+/g, ' ').trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,summary,[role]'));
      el = all.find((candidate) => {
        const label = candidate.getAttribute('aria-label') || candidate.innerText || candidate.value || candidate.placeholder || '';
        return String(label).replace(/\\s+/g, ' ').trim().toLowerCase().includes(wanted);
      }) || null;
    }
  } catch (error) {
    return { ok: false, reason: 'error', message: String((error && error.message) || error) };
  }
  if (!el) return { ok: false, reason: 'not-found' };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (error) { /* best effort */ }
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'not-visible' };
  return {
    ok: true,
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag: el.tagName.toLowerCase(),
    label: String(el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
  };
})()`
}

function failReason(failure: ResolveFailure): never {
  switch (failure.reason) {
    case 'not-found':
      throw new ToolError(
        failure.message ?? 'no element matched the query; call browser_snapshot and use a current ref, or pass a valid selector',
        'ELEMENT_NOT_FOUND',
      )
    case 'not-visible':
      throw new ToolError('the element exists but has no visible box; scroll it into view or use another target', 'ELEMENT_NOT_VISIBLE')
    default:
      throw new ToolError(`element lookup failed: ${failure.message ?? 'invalid selector'}`, 'INVALID_SELECTOR')
  }
}

/** Resolve one element to a clickable box. */
export async function resolveElement(session: CdpSession, query: ElementQuery): Promise<ElementBox> {
  if (query.ref === undefined && query.selector === undefined && query.text === undefined) {
    throw new ToolError('one of ref, selector or text is required', 'INVALID_ARGS')
  }
  if (query.ref !== undefined) session.requireSnapshot()
  const result = await session.evaluate<ElementBox | ResolveFailure>(elementExpression(query))
  if (result === null || result === undefined) throw new ToolError('element lookup returned no result', 'ELEMENT_NOT_FOUND')
  if (result.ok !== true) failReason(result)
  return result
}

async function clickAt(session: CdpSession, x: number, y: number): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/** Click an element and return the settled page. */
export async function clickElement(
  session: CdpSession,
  query: ElementQuery,
): Promise<{ page: PageInfo; label: string; tag: string }> {
  const box = await resolveElement(session, query)
  await clickAt(session, box.x, box.y)
  await session.afterAction()
  return { page: await session.pageInfo(), label: box.label, tag: box.tag }
}

/** Focus, type and optionally submit. */
export async function typeInto(
  session: CdpSession,
  query: ElementQuery,
  text: string,
  submit: boolean,
): Promise<{ page: PageInfo; value: string }> {
  const box = await resolveElement(session, query)
  await clickAt(session, box.x, box.y)
  // Round-trip so a focus/navigation caused by the click settles before typing.
  await sleep(60)
  try {
    await session.evaluate<string>('document.activeElement ? document.activeElement.tagName : ""')
    // Replace rather than append: select the current value so insertText overwrites it.
    await session.evaluate('(() => { const el = document.activeElement; if (el && typeof el.select === "function") el.select(); })()')
  } catch {
    // A click that navigated will surface its own error below.
  }
  await session.send('Input.insertText', { text })
  if (submit) await pressKey(session, 'Enter', 0)
  await session.afterAction()
  const value = await session
    .evaluate<string>(
      '(() => { const el = document.activeElement; return el && typeof el.value === "string" ? el.value : "" })()',
    )
    .catch(() => '')
  return { page: await session.pageInfo(), value }
}

/** Select one or more option values on a `<select>`. */
export async function selectOption(
  session: CdpSession,
  query: ElementQuery,
  values: readonly string[],
): Promise<{ page: PageInfo; selected: string[] }> {
  if (query.ref !== undefined) session.requireSnapshot()
  const literal = JSON.stringify(query)
  const result = await session.evaluate<
    { ok: true; selected: string[] } | { ok: false; reason: string; message?: string }
  >(`(() => {
  const q = ${literal};
  const values = ${JSON.stringify(values)};
  let el = null;
  try {
    if (q.ref) el = document.querySelector('[data-dsh-ref="' + String(q.ref).replace(/"/g, '') + '"]');
    else if (q.selector) el = document.querySelector(q.selector);
  } catch (error) {
    return { ok: false, reason: 'error', message: String((error && error.message) || error) };
  }
  if (!el) return { ok: false, reason: 'not-found' };
  if (el.tagName !== 'SELECT') return { ok: false, reason: 'not-select' };
  if (el.multiple) {
    for (const option of el.options) option.selected = values.includes(option.value);
  } else if (el.options.length > 0) {
    el.value = values[0];
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, selected: Array.from(el.selectedOptions).map((option) => option.value) };
})()`)
  if (result.ok !== true) {
    if (result.reason === 'not-select') throw new ToolError('the element is not a <select>', 'NOT_A_SELECT')
    failReason({ ok: false, reason: result.reason === 'error' ? 'error' : 'not-found', message: result.message })
  }
  return { page: await session.pageInfo(), selected: result.selected }
}

/** Move the pointer over an element. */
export async function hoverElement(session: CdpSession, query: ElementQuery): Promise<{ label: string }> {
  const box = await resolveElement(session, query)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  return { label: box.label }
}

/** Scroll the page by a delta, or a specific element into view. */
export async function scrollPage(
  session: CdpSession,
  query: ElementQuery | undefined,
  deltaY: number,
): Promise<{ scrollY: number }> {
  if (query !== undefined) {
    await resolveElement(session, query)
    await session.settle(1200)
    return { scrollY: await session.evaluate<number>('window.scrollY') }
  }

  const before = await session.evaluate<number>('window.scrollY')
  const center = await session.evaluate<{ x: number; y: number }>('({ x: innerWidth / 2, y: innerHeight / 2 })')
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: center.x,
    y: center.y,
    deltaX: 0,
    deltaY,
  })
  // The wheel is applied asynchronously; give it a few frames before falling back.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(60)
    if ((await session.evaluate<number>('window.scrollY')) !== before) break
  }
  let after = await session.evaluate<number>('window.scrollY')
  if (after === before && deltaY !== 0) {
    await session.evaluate(`window.scrollBy(0, ${Math.trunc(deltaY)})`)
    await sleep(60)
    after = await session.evaluate<number>('window.scrollY')
  }
  return { scrollY: after }
}

/** Dispatch one key press with optional modifier mask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
export async function pressKey(session: CdpSession, name: string, modifiers: number): Promise<void> {
  const info = keyInfo(name)
  const withCommand = (modifiers & 7) !== 0
  const text = withCommand ? undefined : info.text
  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    modifiers,
    autoRepeat: false,
    isKeypad: false,
  }
  await session.send('Input.dispatchKeyEvent', {
    type: text === undefined ? 'rawKeyDown' : 'keyDown',
    ...base,
    ...(text === undefined ? {} : { text, unmodifiedText: text }),
  })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** Set files on a file input through the DOM domain. */
export async function uploadFiles(
  session: CdpSession,
  query: ElementQuery,
  files: readonly string[],
): Promise<{ count: number }> {
  if (query.ref !== undefined) session.requireSnapshot()
  const selector =
    query.selector ??
    (query.ref !== undefined ? `input[data-dsh-ref="${query.ref.replace(/"/g, '')}"]` : undefined)
  if (selector === undefined) {
    throw new ToolError('upload requires a ref or selector that points at an <input type="file">', 'INVALID_ARGS')
  }
  const document = await session.send<{ root?: { nodeId?: number } }>('DOM.getDocument', { depth: -1, pierce: true })
  const rootId = document.root?.nodeId
  if (rootId === undefined) throw new ToolError('could not read the document root', 'DOM_ERROR')
  const found = await session.send<{ nodeId?: number }>('DOM.querySelector', { nodeId: rootId, selector })
  const nodeId = found.nodeId
  if (nodeId === undefined || nodeId === 0) throw new ToolError(`no element matched ${selector}`, 'ELEMENT_NOT_FOUND')
  await session.send('DOM.setFileInputFiles', { files, nodeId })
  return { count: files.length }
}
