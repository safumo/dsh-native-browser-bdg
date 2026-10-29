/** DOM snapshot with stable `ref` handles, the CDP-native replacement for locators. */
/**
 * Build the injected snapshot expression.
 * @param maxNodes - hard cap so a huge DOM cannot flood the model context.
 */
export function snapshotExpression(maxNodes) {
    return `(() => {
  const MAX = ${maxNodes};
  const SEL = 'a[href],button,input,select,textarea,summary,[role],[contenteditable=""],[contenteditable="true"]';
  for (const old of document.querySelectorAll('[data-dsh-ref]')) old.removeAttribute('data-dsh-ref');
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'file') return 'file';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return (tag || 'element').toLowerCase();
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\\s+/).map((id) => {
        const target = document.getElementById(id);
        return target ? (target.innerText || '') : '';
      }).join(' ');
      if (text.trim()) return text.trim();
    }
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    const title = el.getAttribute('title');
    if (title) return title.trim();
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 100);
    if (el.type === 'submit' || el.type === 'button') return String(el.value || '').slice(0, 100);
    return '';
  };
  const visible = (el) => {
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  };
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= MAX) break;
    if (!visible(el)) continue;
    const ref = 'e' + (out.length + 1);
    el.setAttribute('data-dsh-ref', ref);
    const type = String(el.getAttribute('type') || '').toLowerCase();
    out.push({
      ref: ref,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el),
      value: type === 'password' ? '' : (typeof el.value === 'string' ? el.value.slice(0, 200) : undefined),
      disabled: el.disabled === true,
      checked: type === 'checkbox' || type === 'radio' ? el.checked === true : undefined,
    });
  }
  return out;
})()`;
}
/** Render a snapshot as a compact, line-oriented tree for the model. */
export function formatSnapshot(nodes, maxChars) {
    if (nodes.length === 0)
        return 'no interactive elements were found in the main frame';
    const lines = [];
    let length = 0;
    for (const node of nodes) {
        const flags = [
            node.value !== undefined && node.value !== '' ? `value="${node.value.replace(/\s+/g, ' ').slice(0, 80)}"` : '',
            node.checked === true ? 'checked' : '',
            node.disabled === true ? 'disabled' : '',
        ].filter(Boolean);
        const line = `[${node.ref}] ${node.role}${node.name === '' ? '' : ` "${node.name.replace(/\s+/g, ' ').slice(0, 90)}"`}${flags.length > 0 ? ` ${flags.join(' ')}` : ''}`;
        if (length + line.length > maxChars) {
            lines.push('… snapshot truncated');
            break;
        }
        lines.push(line);
        length += line.length + 1;
    }
    return lines.join('\n');
}
