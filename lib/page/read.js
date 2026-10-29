/** Page reading: visible text, raw HTML, or the Chromium accessibility tree. */
import { truncate } from '../util.js';
/** Read the current document in the requested representation. */
export async function readPage(session, mode, maxChars) {
    if (mode === 'text') {
        const text = await session.evaluate('document.body ? document.body.innerText : ""');
        return truncate(text, maxChars);
    }
    if (mode === 'html') {
        const html = await session.evaluate('document.documentElement ? document.documentElement.outerHTML : ""');
        return truncate(html, maxChars);
    }
    const tree = await session.send('Accessibility.getFullAXTree');
    const nodes = tree.nodes ?? [];
    const byId = new Map();
    for (const node of nodes)
        if (typeof node.nodeId === 'string')
            byId.set(node.nodeId, node);
    const depthOf = (node) => {
        let depth = 0;
        let parentId = node.parentId;
        const seen = new Set();
        while (typeof parentId === 'string' && !seen.has(parentId)) {
            seen.add(parentId);
            const parent = byId.get(parentId);
            if (parent === undefined)
                break;
            depth += 1;
            parentId = parent.parentId;
        }
        return Math.min(depth, 40);
    };
    const lines = [];
    let length = 0;
    for (const node of nodes) {
        if (node.ignored === true)
            continue;
        const role = node.role?.value;
        if (typeof role !== 'string' || role === 'none' || role === 'generic')
            continue;
        const name = node.name?.value;
        const value = node.value?.value;
        const suffix = [
            typeof name === 'string' && name !== '' ? `"${String(name).replace(/\s+/g, ' ').slice(0, 120)}"` : '',
            typeof value === 'string' && value !== '' ? `value="${String(value).replace(/\s+/g, ' ').slice(0, 120)}"` : '',
        ]
            .filter(Boolean)
            .join(' ');
        const line = `${'  '.repeat(depthOf(node))}${role}${suffix === '' ? '' : ` ${suffix}`}`;
        if (length + line.length > maxChars) {
            lines.push('… accessibility tree truncated');
            break;
        }
        lines.push(line);
        length += line.length + 1;
    }
    return lines.length === 0 ? 'the accessibility tree is empty' : lines.join('\n');
}
