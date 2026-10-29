/** Text-result tool factory shared by every browser tool. */

import type { ContentBlock, ToolDefinition, ToolExec } from '../types.js'

export interface TextToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly timeoutMs?: number
  readonly concurrencySafe?: boolean
  run(args: Record<string, unknown>, exec: ToolExec): Promise<string>
}

const TEXT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string' },
  },
}

/** Build one tool that renders a single text block. */
export function textTool(spec: TextToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    timeoutMs: spec.timeoutMs ?? 30000,
    isConcurrencySafe: () => spec.concurrencySafe === true,
    output: {
      schema: TEXT_OUTPUT,
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: String(value.text ?? '') }],
    },
    async execute(args, exec): Promise<Record<string, unknown>> {
      return { text: await spec.run(args, exec) }
    },
  }
}
