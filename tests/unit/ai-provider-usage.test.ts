/**
 * Provider token-usage population — unit tests.
 *
 * Verifies both providers surface `usage` on AiCompletion: actual when the
 * SDK reports it, and an `estimated` char/4 fallback when it does not.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ── Mock the Anthropic SDK ──
const anthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
    return {
        __esModule: true,
        default: class Anthropic {
            messages = { create: anthropicCreate, stream: jest.fn() };
            models = { list: jest.fn() };
        },
    };
});

// ── Mock the OpenAI SDK ──
const openaiCreate = jest.fn();
jest.mock('openai', () => {
    return {
        __esModule: true,
        default: class OpenAI {
            chat = { completions: { create: openaiCreate } };
            embeddings = { create: jest.fn() };
            models = { list: jest.fn() };
        },
    };
});

import { ClaudeProvider } from '@/app-layer/ai/provider/claude-provider';
import { OpenAiCompatibleProvider } from '@/app-layer/ai/provider/openai-compatible-provider';

beforeEach(() => {
    anthropicCreate.mockReset();
    openaiCreate.mockReset();
});

describe('ClaudeProvider usage', () => {
    it('maps Anthropic input_tokens / output_tokens to AiUsage', async () => {
        anthropicCreate.mockResolvedValue({
            content: [{ type: 'text', text: 'hello' }],
            usage: { input_tokens: 42, output_tokens: 13 },
            stop_reason: 'end_turn',
        });
        const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-opus-4-8' });
        const out = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
        expect(out.usage).toEqual({ promptTokens: 42, completionTokens: 13, totalTokens: 55 });
        expect(out.usage!.estimated).toBeUndefined();
    });

    it('maps an assistant turn\'s toolCalls to tool_use BLOCKS — the outage', async () => {
        // The delivery half of the fix. The loop pushing an assistant turn and
        // the provider turning it into `tool_use` blocks fail SEPARATELY, so
        // both are asserted: this is what Anthropic actually receives.
        //
        // Without it the request carried a `tool_result` whose `tool_use` was
        // absent from the previous message, and the API refused every question
        // with a 400 — for every model, since nothing model-specific was
        // involved.
        anthropicCreate.mockResolvedValue({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: 'end_turn',
        });
        const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-opus-4-8' });
        await provider.complete({
            messages: [
                { role: 'user', content: 'Каква е цената на житото' },
                {
                    role: 'assistant',
                    content: 'Проверявам.',
                    toolCalls: [{ id: 'toolu_1', name: 'price_trends', arguments: '{"commodity":"wheat"}' }],
                },
                { role: 'tool', content: '{"rows":[]}', toolCallId: 'toolu_1' },
            ],
        });
        const sent = anthropicCreate.mock.calls[0][0] as {
            messages: Array<{ role: string; content: unknown }>;
        };
        const assistant = sent.messages.find((m) => m.role === 'assistant')!;
        expect(Array.isArray(assistant.content)).toBe(true);
        const blocks = assistant.content as Array<Record<string, unknown>>;
        // Text first, then the tool_use — and `input` is an OBJECT, parsed
        // from the model's raw JSON string.
        expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
        expect(blocks[1]).toMatchObject({
            type: 'tool_use',
            id: 'toolu_1',
            name: 'price_trends',
            input: { commodity: 'wheat' },
        });
        // And the tool_result that follows names that same id — the
        // correspondence the API checks.
        const toolMsg = sent.messages[sent.messages.length - 1];
        expect((toolMsg.content as Array<Record<string, unknown>>)[0]).toMatchObject({
            type: 'tool_result',
            tool_use_id: 'toolu_1',
        });
    });

    it('a malformed arguments string becomes an empty input, not a throw', async () => {
        // The model emits `arguments` as a raw string and can emit it broken.
        // The history has to stay well-formed either way: the tool already
        // refused that call on the way out, so losing the arguments from the
        // transcript beats losing the turn.
        anthropicCreate.mockResolvedValue({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: 'end_turn',
        });
        const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-opus-4-8' });
        for (const bad of ['{not json', '', 'null', '"a string"', '42']) {
            anthropicCreate.mockClear();
            await expect(
                provider.complete({
                    messages: [
                        { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'x', arguments: bad }] },
                    ],
                }),
            ).resolves.toBeDefined();
            const sent = anthropicCreate.mock.calls[0][0] as {
                messages: Array<{ content: Array<Record<string, unknown>> }>;
            };
            expect({ bad, input: sent.messages[0].content[0].input }).toEqual({ bad, input: {} });
        }
    });

    it('estimates usage (char/4, estimated:true) when the SDK omits it', async () => {
        anthropicCreate.mockResolvedValue({
            content: [{ type: 'text', text: 'abcdefgh' }], // 8 chars → 2 tokens
            usage: undefined,
            stop_reason: 'end_turn',
        });
        const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-opus-4-8' });
        const out = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
        expect(out.usage!.estimated).toBe(true);
        expect(out.usage!.completionTokens).toBe(2);
        expect(out.usage!.totalTokens).toBeGreaterThan(0);
    });
});

describe('OpenAiCompatibleProvider usage', () => {
    it('maps prompt_tokens / completion_tokens to AiUsage', async () => {
        openaiCreate.mockResolvedValue({
            choices: [{ message: { content: 'hello', tool_calls: [] } }],
            usage: { prompt_tokens: 30, completion_tokens: 20 },
        });
        const provider = new OpenAiCompatibleProvider({
            backend: 'groq',
            baseURL: 'https://api.groq.com/openai/v1',
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
        });
        const out = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
        expect(out.usage).toEqual({ promptTokens: 30, completionTokens: 20, totalTokens: 50 });
    });

    it('estimates usage when the host omits the usage object', async () => {
        openaiCreate.mockResolvedValue({
            choices: [{ message: { content: 'abcd', tool_calls: [] } }], // 4 chars → 1 token
            usage: undefined,
        });
        const provider = new OpenAiCompatibleProvider({
            backend: 'groq',
            baseURL: 'https://api.groq.com/openai/v1',
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
        });
        const out = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
        expect(out.usage!.estimated).toBe(true);
        expect(out.usage!.completionTokens).toBe(1);
    });
});
