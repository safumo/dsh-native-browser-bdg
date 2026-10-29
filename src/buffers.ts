/** Bounded, insertion-ordered event buffers for network and console records. */

export interface NetworkRecord {
  readonly requestId: string
  url: string
  method: string
  resourceType?: string
  status?: number
  mimeType?: string
  encodedDataLength?: number
  failed?: string
  finished: boolean
  readonly startedAt: number
}

export interface ConsoleRecord {
  readonly level: string
  readonly text: string
  readonly at: number
}

/** Map-backed ring buffer that keeps the newest `capacity` records. */
export class RecordBuffer<T extends { readonly requestId: string }> {
  readonly #map = new Map<string, T>()
  readonly #order: string[] = []

  constructor(private readonly capacity: number) {}

  upsert(id: string, create: () => T, update: (current: T) => T): void {
    const current = this.#map.get(id)
    if (current !== undefined) {
      this.#map.set(id, update(current))
      return
    }
    this.#map.set(id, create())
    this.#order.push(id)
    while (this.#order.length > this.capacity) {
      const oldest = this.#order.shift()
      if (oldest !== undefined) this.#map.delete(oldest)
    }
  }

  list(limit: number): T[] {
    const slice = this.#order.slice(-limit)
    const result: T[] = []
    for (const id of slice) {
      const record = this.#map.get(id)
      if (record !== undefined) result.push(record)
    }
    return result
  }

  get(id: string): T | undefined {
    return this.#map.get(id)
  }

  clear(): void {
    this.#map.clear()
    this.#order.length = 0
  }
}

/** Bounded FIFO for console records. */
export class ConsoleBuffer {
  readonly #items: ConsoleRecord[] = []

  constructor(private readonly capacity: number) {}

  push(record: ConsoleRecord): void {
    this.#items.push(record)
    if (this.#items.length > this.capacity) this.#items.splice(0, this.#items.length - this.capacity)
  }

  list(limit: number): ConsoleRecord[] {
    return this.#items.slice(-limit)
  }

  clear(): void {
    this.#items.length = 0
  }
}
