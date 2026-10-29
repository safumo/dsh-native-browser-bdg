/**
 * Wrap the tsc ESM client entry in the DSH client-module factory format.
 *
 * The browser loads each plugin's `client.js` as a classic script. DSH's
 * loader expects that script to register a closure factory:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => ({ ...exports }) })
 *
 * tsc emits plain ESM (`export const inject`, `export function apply`), which
 * is a SyntaxError in that context. This script rewrites the two exports and
 * emits `lib/client.js`; the intermediate `lib/client/index.js` is removed.
 */
import { readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const input = join(root, 'lib/client/index.js')
const output = join(root, 'lib/client.js')

let body = await readFile(input, 'utf8')
body = body.replace(/^export const inject =/m, 'const inject =')
body = body.replace(/^export function apply/m, 'function apply')
if (/^\s*export\s/m.test(body)) {
  throw new Error('client entry has an unsupported ESM export')
}

const banner = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(pkg.name)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} }; var exports = module.exports;',
].join('\n')
const footer = [
  '    module.exports = { inject: inject, apply: apply };',
  '    return module.exports;',
  '  }',
  '});',
].join('\n')

await writeFile(output, `${banner}\n${body}\n${footer}\n`)
await rm(input)
