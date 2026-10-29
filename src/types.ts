/** Shared types for the Browser CDP plugin. */

/** One CDP target that the registry is willing to expose. */
export interface CdpTargetInfo {
  readonly targetId: string
  readonly type: string
  readonly url: string
  readonly title: string
  readonly attached: boolean
  /** Lease id parsed from a Sidebar guest's `about:blank#<lease>` bootstrap URL. */
  readonly alias?: string
  lastActivityAt: number
}

/** A durable image reference returned by `ctx.attachments.saveImage`. */
export interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** Tool result blocks understood by the Client presentation layer. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageRef }

/** Execution environment handed to every tool. */
export interface ToolExec {
  readonly signal?: AbortSignal
}

/** Attachment service used to persist screenshots. */
export interface AttachmentService {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageRef>
}

/** Tool registry exposed by `ctx.tools`. */
export interface ToolRegistry {
  register(definition: ToolDefinition): unknown
}

/** Minimal Cordis context surface this plugin depends on. */
export interface PluginContext {
  readonly tools: ToolRegistry
  readonly attachments?: AttachmentService
  effect(callback: () => () => void, label?: string): void
}

/** A raw tool definition accepted by the registry (no `defineTool` dependency). */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: Record<string, unknown>, value: Record<string, unknown>): ContentBlock[]
  }
  readonly timeoutMs?: number
  readonly isConcurrencySafe?: (args: Record<string, unknown>) => boolean
  execute(args: Record<string, unknown>, exec: ToolExec): Promise<Record<string, unknown>>
}
