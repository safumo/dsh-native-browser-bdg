/** Text-result tool factory shared by every browser tool. */
const TEXT_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
        text: { type: 'string' },
    },
};
/** Build one tool that renders a single text block. */
export function textTool(spec) {
    return {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        timeoutMs: spec.timeoutMs ?? 30000,
        isConcurrencySafe: () => spec.concurrencySafe === true,
        output: {
            schema: TEXT_OUTPUT,
            render: (_args, value) => [{ type: 'text', text: String(value.text ?? '') }],
        },
        async execute(args, exec) {
            return { text: await spec.run(args, exec) };
        },
    };
}
