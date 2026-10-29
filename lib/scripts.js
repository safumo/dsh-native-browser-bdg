/** Persistent userscripts stored under $DSH_HOME and re-injected on restart. */
const runtime = globalThis.process;
function fileSystem() {
    return runtime?.getBuiltinModule?.('node:fs');
}
function homeDirectory() {
    return runtime?.env.HOME ?? runtime?.env.USERPROFILE ?? '';
}
/** DSH home: `$DSH_HOME`, else `~/.dsh` (`%USERPROFILE%\.dsh` on Windows). */
export function dshHome() {
    const explicit = runtime?.env.DSH_HOME;
    if (explicit !== undefined && explicit !== '')
        return explicit;
    const home = homeDirectory();
    return home === '' ? '.' : `${home}/.dsh`;
}
function generateId() {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
function validEntry(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const entry = value;
    return (typeof entry.id === 'string' &&
        entry.id !== '' &&
        typeof entry.source === 'string' &&
        typeof entry.createdAt === 'number' &&
        typeof entry.updatedAt === 'number');
}
/** JSON-backed store of scripts that survive app/plugin restarts. */
export class ScriptStore {
    path;
    #scripts;
    constructor(path = `${dshHome()}/browser-cdp-scripts.json`) {
        this.path = path;
        this.#scripts = this.#read();
    }
    /** Stored scripts in insertion order. */
    list() {
        return [...this.#scripts];
    }
    get(id) {
        return this.#scripts.find((script) => script.id === id);
    }
    /**
     * Add a script or replace the source of an existing id.
     * @param source - JavaScript injected into every new document.
     * @param id - optional stable identifier; generated when omitted.
     */
    add(source, id) {
        if (source.trim() === '')
            throw new Error('script source must not be empty');
        const now = Date.now();
        const existing = id === undefined ? undefined : this.get(id);
        if (existing !== undefined) {
            const updated = { ...existing, source, updatedAt: now };
            this.#scripts = this.#scripts.map((script) => (script.id === updated.id ? updated : script));
            this.#write();
            return updated;
        }
        const script = {
            id: id === undefined || id === '' ? generateId() : id,
            source,
            createdAt: now,
            updatedAt: now,
        };
        if (this.get(script.id) !== undefined)
            throw new Error(`script id ${script.id} already exists`);
        this.#scripts = [...this.#scripts, script];
        this.#write();
        return script;
    }
    /** Remove one script; returns whether it existed. */
    remove(id) {
        const before = this.#scripts.length;
        this.#scripts = this.#scripts.filter((script) => script.id !== id);
        if (this.#scripts.length === before)
            return false;
        this.#write();
        return true;
    }
    #read() {
        const fs = fileSystem();
        if (fs === undefined)
            return [];
        try {
            const parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
            const entries = Array.isArray(parsed.scripts) ? parsed.scripts : [];
            return entries.filter(validEntry).map((entry) => ({
                id: entry.id,
                source: entry.source,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
            }));
        }
        catch {
            return [];
        }
    }
    #write() {
        const fs = fileSystem();
        if (fs === undefined)
            throw new Error('this runtime cannot write the script store');
        const payload = `${JSON.stringify({ version: 1, scripts: this.#scripts }, null, 2)}\n`;
        const directory = this.path.split(/[\\/]/).slice(0, -1).join('/');
        if (directory !== '') {
            try {
                fs.mkdirSync?.(directory, { recursive: true });
            }
            catch {
                // The directory usually already exists.
            }
        }
        if (fs.renameSync !== undefined) {
            const temporary = `${this.path}.tmp`;
            try {
                fs.writeFileSync(temporary, payload);
                fs.renameSync(temporary, this.path);
                return;
            }
            catch {
                // Windows can refuse the rename while another process holds the file.
            }
        }
        fs.writeFileSync(this.path, payload);
    }
}
