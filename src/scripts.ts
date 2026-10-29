/** Persistent userscripts stored under $DSH_HOME and re-injected on restart. */

interface NodeRuntime {
  readonly env: Record<string, string | undefined>
  getBuiltinModule?(id: string): unknown
}

interface FsModule {
  readFileSync(path: string, encoding: string): string
  writeFileSync(path: string, data: string): void
  renameSync?(from: string, to: string): void
  mkdirSync?(path: string, options: { recursive: boolean }): void
}

const runtime = (globalThis as unknown as { process?: NodeRuntime }).process

function fileSystem(): FsModule | undefined {
  return runtime?.getBuiltinModule?.('node:fs') as FsModule | undefined
}

function homeDirectory(): string {
  return runtime?.env.HOME ?? runtime?.env.USERPROFILE ?? ''
}

/** DSH home: `$DSH_HOME`, else `~/.dsh` (`%USERPROFILE%\.dsh` on Windows). */
export function dshHome(): string {
  const explicit = runtime?.env.DSH_HOME
  if (explicit !== undefined && explicit !== '') return explicit
  const home = homeDirectory()
  return home === '' ? '.' : `${home}/.dsh`
}

export interface StoredScript {
  readonly id: string
  readonly source: string
  readonly createdAt: number
  readonly updatedAt: number
}

interface StoreFile {
  readonly version?: number
  readonly scripts?: unknown
}

function generateId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function validEntry(value: unknown): value is StoredScript {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    entry.id !== '' &&
    typeof entry.source === 'string' &&
    typeof entry.createdAt === 'number' &&
    typeof entry.updatedAt === 'number'
  )
}

/** JSON-backed store of scripts that survive app/plugin restarts. */
export class ScriptStore {
  readonly path: string
  #scripts: StoredScript[]

  constructor(path = `${dshHome()}/browser-cdp-scripts.json`) {
    this.path = path
    this.#scripts = this.#read()
  }

  /** Stored scripts in insertion order. */
  list(): StoredScript[] {
    return [...this.#scripts]
  }

  get(id: string): StoredScript | undefined {
    return this.#scripts.find((script) => script.id === id)
  }

  /**
   * Add a script or replace the source of an existing id.
   * @param source - JavaScript injected into every new document.
   * @param id - optional stable identifier; generated when omitted.
   */
  add(source: string, id?: string): StoredScript {
    if (source.trim() === '') throw new Error('script source must not be empty')
    const now = Date.now()
    const existing = id === undefined ? undefined : this.get(id)
    if (existing !== undefined) {
      const updated: StoredScript = { ...existing, source, updatedAt: now }
      this.#scripts = this.#scripts.map((script) => (script.id === updated.id ? updated : script))
      this.#write()
      return updated
    }
    const script: StoredScript = {
      id: id === undefined || id === '' ? generateId() : id,
      source,
      createdAt: now,
      updatedAt: now,
    }
    if (this.get(script.id) !== undefined) throw new Error(`script id ${script.id} already exists`)
    this.#scripts = [...this.#scripts, script]
    this.#write()
    return script
  }

  /** Remove one script; returns whether it existed. */
  remove(id: string): boolean {
    const before = this.#scripts.length
    this.#scripts = this.#scripts.filter((script) => script.id !== id)
    if (this.#scripts.length === before) return false
    this.#write()
    return true
  }

  #read(): StoredScript[] {
    const fs = fileSystem()
    if (fs === undefined) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, 'utf8')) as StoreFile
      const entries = Array.isArray(parsed.scripts) ? parsed.scripts : []
      return entries.filter(validEntry).map((entry) => ({
        id: entry.id,
        source: entry.source,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }))
    } catch {
      return []
    }
  }

  #write(): void {
    const fs = fileSystem()
    if (fs === undefined) throw new Error('this runtime cannot write the script store')
    const payload = `${JSON.stringify({ version: 1, scripts: this.#scripts }, null, 2)}\n`
    const directory = this.path.split(/[\\/]/).slice(0, -1).join('/')
    if (directory !== '') {
      try {
        fs.mkdirSync?.(directory, { recursive: true })
      } catch {
        // The directory usually already exists.
      }
    }
    if (fs.renameSync !== undefined) {
      const temporary = `${this.path}.tmp`
      try {
        fs.writeFileSync(temporary, payload)
        fs.renameSync(temporary, this.path)
        return
      } catch {
        // Windows can refuse the rename while another process holds the file.
      }
    }
    fs.writeFileSync(this.path, payload)
  }
}
