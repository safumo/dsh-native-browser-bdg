/** Bounded, insertion-ordered event buffers for network and console records. */
/** Map-backed ring buffer that keeps the newest `capacity` records. */
export class RecordBuffer {
    capacity;
    #map = new Map();
    #order = [];
    constructor(capacity) {
        this.capacity = capacity;
    }
    upsert(id, create, update) {
        const current = this.#map.get(id);
        if (current !== undefined) {
            this.#map.set(id, update(current));
            return;
        }
        this.#map.set(id, create());
        this.#order.push(id);
        while (this.#order.length > this.capacity) {
            const oldest = this.#order.shift();
            if (oldest !== undefined)
                this.#map.delete(oldest);
        }
    }
    list(limit) {
        const slice = this.#order.slice(-limit);
        const result = [];
        for (const id of slice) {
            const record = this.#map.get(id);
            if (record !== undefined)
                result.push(record);
        }
        return result;
    }
    get(id) {
        return this.#map.get(id);
    }
    clear() {
        this.#map.clear();
        this.#order.length = 0;
    }
}
/** Bounded FIFO for console records. */
export class ConsoleBuffer {
    capacity;
    #items = [];
    constructor(capacity) {
        this.capacity = capacity;
    }
    push(record) {
        this.#items.push(record);
        if (this.#items.length > this.capacity)
            this.#items.splice(0, this.#items.length - this.capacity);
    }
    list(limit) {
        return this.#items.slice(-limit);
    }
    clear() {
        this.#items.length = 0;
    }
}
