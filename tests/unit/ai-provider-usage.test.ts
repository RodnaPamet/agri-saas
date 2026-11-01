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

    /**
     * #2669 — the two providers report prompt caching under OPPOSITE
     * conventions, and the cost model multiplies one field by one rate.
     */
    describe('prompt cache accounting (#2669)', () => {
        const claude = () => new ClaudeProvider({ apiKey: 'k', model: 'claude-opus-4-8' });
        const openai = () =>
            new OpenAiCompatibleProvider({
                backend: 'groq',
                baseURL: 'https://api.groq.com/openai/v1',
                apiKey: 'k',
                model: 'llama-3.3-70b-versatile',
            });

        it('THE EQUIVALENCE: one real situation, two conventions, one answer', async () => {
            // 1000 prompt tokens of which 800 were served from cache.
            //
            // Anthropic EXCLUDES the cached part from `input_tokens`, so it
            // sends 200. OpenAI INCLUDES it in `prompt_tokens`, so it sends
            // 1000 with an 800 subset. Both must arrive as the same AiUsage,
            // because `cost.ts` multiplies `promptTokens` by the full input
            // rate and `assertAiBudget` sums it against a plan limit — a field
            // that means "full-rate tokens" on one backend and "all prompt
            // tokens" on the other is wrong for one of them and errors on
            // neither.
            anthropicCreate.mockResolvedValue({
                content: [{ type: 'text', text: 'x' }],
                usage: {
                    input_tokens: 200,
                    output_tokens: 10,
                    cache_read_input_tokens: 800,
                    cache_creation_input_tokens: 0,
                },
                stop_reason: 'end_turn',
            });
            openaiCreate.mockResolvedValue({
                choices: [{ message: { content: 'x', tool_calls: [] } }],
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 10,
                    prompt_tokens_details: { cached_tokens: 800 },
                },
            });

            const a = await claude().complete({ messages: [{ role: 'user', content: 'hi' }] });
            const o = await openai().complete({ messages: [{ role: 'user', content: 'hi' }] });

            expect(a.usage!.promptTokens).toBe(200);
            expect(o.usage!.promptTokens).toBe(200);
            expect(a.usage!.cacheReadTokens).toBe(800);
            expect(o.usage!.cacheReadTokens).toBe(800);
            // And the full-rate total agrees, which is what gets priced.
            expect(a.usage!.totalTokens).toBe(o.usage!.totalTokens);
        });

        it('null means ASKED AND NO CACHE (0); absent means NOT REPORTED (undefined)', async () => {
            // The discriminator the whole issue is about: a hit rate averaged
            // over calls that never reported is a fiction, so the two cannot
            // collapse to the same value.
            anthropicCreate.mockResolvedValue({
                content: [{ type: 'text', text: 'x' }],
                usage: {
                    input_tokens: 50,
                    output_tokens: 5,
                    cache_read_input_tokens: null,
                    cache_creation_input_tokens: null,
                },
                stop_reason: 'end_turn',
            });
            const told = await claude().complete({ messages: [{ role: 'user', content: 'hi' }] });
            expect(told.usage!.cacheReadTokens).toBe(0);

            anthropicCreate.mockResolvedValue({
                content: [{ type: 'text', text: 'x' }],
                usage: { input_tokens: 50, output_tokens: 5 },
                stop_reason: 'end_turn',
            });
            const silent = await claude().complete({ messages: [{ role: 'user', content: 'hi' }] });
            expect(silent.usage!.cacheReadTokens).toBeUndefined();
        });

        it('a cache WRITE is reported, and only Anthropic has the concept', async () => {
            anthropicCreate.mockResolvedValue({
                content: [{ type: 'text', text: 'x' }],
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 1200,
                },
                stop_reason: 'end_turn',
            });
            const a = await claude().complete({ messages: [{ role: 'user', content: 'hi' }] });
            expect(a.usage!.cacheWriteTokens).toBe(1200);

            // These hosts do not charge for a write, so the field stays
            // undefined — "no such concept" is not "we measured zero".
            openaiCreate.mockResolvedValue({
                choices: [{ message: { content: 'x', tool_calls: [] } }],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 5,
                    prompt_tokens_details: { cached_tokens: 40 },
                },
            });
            const o = await openai().complete({ messages: [{ role: 'user', content: 'hi' }] });
            expect(o.usage!.cacheWriteTokens).toBeUndefined();
            expect(o.usage!.cacheReadTokens).toBe(40);
        });

        it('a host reporting a cached count ABOVE its own prompt total cannot go negative', async () => {
            // Defensive rather than observed: `Math.max(0, …)` is the kind of
            // clamp that is invisible until a host is inconsistent, and a
            // negative promptTokens would flow into a cost multiplication.
            openaiCreate.mockResolvedValue({
                choices: [{ message: { content: 'x', tool_calls: [] } }],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    prompt_tokens_details: { cached_tokens: 999 },
                },
            });
            const o = await openai().complete({ messages: [{ role: 'user', content: 'hi' }] });
            expect(o.usage!.promptTokens).toBe(0);
            expect(o.usage!.totalTokens).toBe(5);
        });
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
