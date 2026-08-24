/**
 * Swappable AI provider — unit tests (fully mocked, NO live network).
 *
 * Covers:
 *   (a) structured output round-trips (Zod schema → json_schema → parsed)
 *   (b) validate/repair fallback fires when json_schema is unsupported
 *       OR the first json_object response fails validation, then succeeds
 *   (c) tool calls round-trip (tools passed through, toolCalls returned)
 *   (d) health() reports modelAvailable from a mocked /models list, and
 *       ok:false (no throw) when the probe fails
 *   (e) the factory selects baseURL/model/apiKey from env (Ollama dev
 *       default vs an OpenRouter config) + backend inference
 *   (f) streaming assembles text from chunk deltas
 */
import { z } from 'zod';

// ─── Mock the openai SDK ───
//
// A single mutable handle the tests drive. `chat.completions.create`
// and `models.list` are jest.fn()s reset per test.
const mockCreate = jest.fn();
const mockModelsList = jest.fn();
const mockEmbeddingsCreate = jest.fn();
const constructorCalls: Array<{ baseURL?: string; apiKey?: string }> = [];

jest.mock('openai', () => {
    class MockOpenAI {
        chat: { completions: { create: jest.Mock } };
        models: { list: jest.Mock };
        embeddings: { create: jest.Mock };
        constructor(opts: { baseURL?: string; apiKey?: string }) {
            constructorCalls.push({ baseURL: opts.baseURL, apiKey: opts.apiKey });
            this.chat = { completions: { create: mockCreate } };
            this.models = { list: mockModelsList };
            this.embeddings = { create: mockEmbeddingsCreate };
        }
    }
    return { __esModule: true, default: MockOpenAI, OpenAI: MockOpenAI };
});

import {
    OpenAiCompatibleProvider,
    AiProviderError,
    CAPABILITIES,
} from '@/app-layer/ai/provider/openai-compatible-provider';
import type { AiToolDef } from '@/app-layer/ai/provider/types';

// Helper — a non-streaming chat completion response shape.
function chatResponse(content: string, toolCalls?: Array<{ id: string; name: string; args: string }>) {
    return {
        choices: [
            {
                message: {
                    content,
                    tool_calls: toolCalls?.map((t) => ({
                        id: t.id,
                        type: 'function',
                        function: { name: t.name, arguments: t.args },
                    })),
                },
            },
        ],
    };
}

// Helper — an async-iterable stream of delta chunks.
function streamChunks(chunks: Array<{ content?: string; toolCalls?: Array<{ index: number; id?: string; name?: string; args?: string }> }>) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const c of chunks) {
                yield {
                    choices: [
                        {
                            delta: {
                                content: c.content,
                                tool_calls: c.toolCalls?.map((t) => ({
                                    index: t.index,
                                    id: t.id,
                                    function: { name: t.name, arguments: t.args },
                                })),
                            },
                        },
                    ],
                };
            }
        },
    };
}

const Schema = z.object({
    title: z.string(),
    score: z.number(),
});

beforeEach(() => {
    mockCreate.mockReset();
    mockModelsList.mockReset();
    mockEmbeddingsCreate.mockReset();
    constructorCalls.length = 0;
});

// ─── (a) Structured output via json_schema (json-schema-capable backend) ───

describe('structured output — json_schema path', () => {
    it('round-trips a Zod schema → json_schema → parsed object', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'openrouter', // jsonSchema: true
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: 'k',
            model: 'm',
        });
        mockCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'A', score: 5 })));

        const result = await provider.complete({
            messages: [{ role: 'user', content: 'hi' }],
            schema: Schema,
            schemaName: 'thing',
        });

        expect(result.parsed).toEqual({ title: 'A', score: 5 });
        // Assert json_schema response_format was sent.
        const call = mockCreate.mock.calls[0][0];
        expect(call.response_format.type).toBe('json_schema');
        expect(call.response_format.json_schema.name).toBe('thing');
        expect(call.response_format.json_schema.strict).toBe(true);
        expect(call.response_format.json_schema.schema).toBeTruthy();
    });
});

// ─── (b) Validate / repair fallback ───

describe('validate/repair fallback', () => {
    it('falls back to json_object when the backend lacks json_schema support (ollama)', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama', // jsonSchema: false → json_object path directly
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        mockCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'B', score: 9 })));

        const result = await provider.complete({
            messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'go' }],
            schema: Schema,
        });

        expect(result.parsed).toEqual({ title: 'B', score: 9 });
        const call = mockCreate.mock.calls[0][0];
        expect(call.response_format.type).toBe('json_object');
        // Schema injected into the (existing) system message.
        const sys = call.messages.find((m: { role: string }) => m.role === 'system');
        expect(sys.content).toContain('JSON Schema');
    });

    it('repairs once when the first json_object response fails validation', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        // First response invalid (score is a string), repair response valid.
        mockCreate
            .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'C', score: 'oops' })))
            .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'C', score: 3 })));

        const result = await provider.complete({
            messages: [{ role: 'user', content: 'go' }],
            schema: Schema,
        });

        expect(result.parsed).toEqual({ title: 'C', score: 3 });
        expect(mockCreate).toHaveBeenCalledTimes(2);
        // The repair re-prompt feeds back the bad output + an error note.
        const repairCall = mockCreate.mock.calls[1][0];
        const lastUser = repairCall.messages[repairCall.messages.length - 1];
        expect(lastUser.role).toBe('user');
        expect(lastUser.content).toContain('corrected JSON');
    });

    it('falls back from json_schema → json_object when the schema response fails validation', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'openrouter', // jsonSchema: true (tries native first)
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: 'k',
            model: 'm',
        });
        mockCreate
            // native json_schema attempt → invalid
            .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'D' })))
            // json_object fallback → valid
            .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'D', score: 1 })));

        const result = await provider.complete({
            messages: [{ role: 'user', content: 'go' }],
            schema: Schema,
        });

        expect(result.parsed).toEqual({ title: 'D', score: 1 });
        expect(mockCreate.mock.calls[0][0].response_format.type).toBe('json_schema');
        expect(mockCreate.mock.calls[1][0].response_format.type).toBe('json_object');
    });

    it('throws a typed AiProviderError when still invalid after repair', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        mockCreate
            .mockResolvedValueOnce(chatResponse('not json at all'))
            .mockResolvedValueOnce(chatResponse('still not json'));

        await expect(
            provider.complete({ messages: [{ role: 'user', content: 'go' }], schema: Schema }),
        ).rejects.toBeInstanceOf(AiProviderError);
    });

    it('recovers when json_schema request is rejected by the backend (throws)', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'groq', // jsonSchema: true
            baseURL: 'https://api.groq.com/openai/v1',
            apiKey: 'k',
            model: 'm',
        });
        mockCreate
            .mockRejectedValueOnce(new Error('json_schema not supported by model'))
            .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: 'E', score: 2 })));

        const result = await provider.complete({
            messages: [{ role: 'user', content: 'go' }],
            schema: Schema,
        });
        expect(result.parsed).toEqual({ title: 'E', score: 2 });
    });
});

// ─── (c) Tool calls ───

describe('tool calling', () => {
    it('passes tools through and returns toolCalls', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        const tools: AiToolDef[] = [
            { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: {} } },
        ];
        mockCreate.mockResolvedValueOnce(
            chatResponse('', [{ id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}' }]),
        );

        const result = await provider.complete({
            messages: [{ role: 'user', content: 'weather?' }],
            tools,
        });

        // Tools forwarded in OpenAI shape.
        const call = mockCreate.mock.calls[0][0];
        expect(call.tools[0].type).toBe('function');
        expect(call.tools[0].function.name).toBe('get_weather');
        // Tool calls surfaced.
        expect(result.toolCalls).toEqual([
            { id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        ]);
    });
});

// ─── (d) health() ───

describe('health()', () => {
    function modelList(ids: string[]) {
        return {
            async *[Symbol.asyncIterator]() {
                for (const id of ids) yield { id };
            },
        };
    }

    it('reports modelAvailable=true when the configured model is listed', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        mockModelsList.mockResolvedValueOnce(modelList(['llama3:8b', 'qwen3:1.7b']));

        const h = await provider.health();
        expect(h.ok).toBe(true);
        expect(h.modelAvailable).toBe(true);
        expect(h.model).toBe('qwen3:1.7b');
    });

    it('reports modelAvailable=false when the model is missing', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        mockModelsList.mockResolvedValueOnce(modelList(['llama3:8b']));

        const h = await provider.health();
        expect(h.ok).toBe(true);
        expect(h.modelAvailable).toBe(false);
        expect(h.detail).toContain('not found');
    });

    it('returns ok:false and never throws when the probe fails', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        mockModelsList.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const h = await provider.health();
        expect(h.ok).toBe(false);
        expect(h.modelAvailable).toBe(false);
        expect(h.detail).toContain('ECONNREFUSED');
    });
});

// ─── (f) Streaming ───

describe('streaming', () => {
    it('assembles text from streamed chunk deltas', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        mockCreate.mockResolvedValueOnce(
            streamChunks([{ content: 'Hel' }, { content: 'lo ' }, { content: 'world' }]),
        );

        const result = await provider.complete({
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
        });

        expect(result.text).toBe('Hello world');
        expect(mockCreate.mock.calls[0][0].stream).toBe(true);
    });
});

// ─── Embeddings (feat/ai-rag) ───

describe('embed()', () => {
    it('embeds texts via the embeddings endpoint, order-preserved', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama', // embeddings: true
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
            embedModel: 'nomic-embed-text',
        });
        // Return out-of-order to prove sort-by-index lines up with inputs.
        mockEmbeddingsCreate.mockResolvedValueOnce({
            data: [
                { index: 1, embedding: [0.4, 0.5, 0.6] },
                { index: 0, embedding: [0.1, 0.2, 0.3] },
            ],
        });

        const result = await provider.embed({ texts: ['first', 'second'] });

        expect(result).toEqual([
            { text: 'first', vector: [0.1, 0.2, 0.3] },
            { text: 'second', vector: [0.4, 0.5, 0.6] },
        ]);
        const call = mockEmbeddingsCreate.mock.calls[0][0];
        expect(call.model).toBe('nomic-embed-text');
        expect(call.input).toEqual(['first', 'second']);
        // NAMES THE WIRE FORMAT. Omitted, the SDK silently sends
        // `encoding_format: "base64"` and base64-decodes the reply — and a
        // backend answering with plain float arrays then decodes to an EMPTY
        // vector with nothing raised. Measured against the real SDK in
        // tests/integration/openai-real-api.test.ts (#754); asserted here because
        // that test exercises the SDK and cannot see OUR call site.
        expect(call.encoding_format).toBe('float');
    });

    it('REFUSES an empty vector rather than returning a useless one', async () => {
        // The count guard alone is not enough: one empty vector per input is
        // the RIGHT COUNT, and `embedding as number[]` is a cast, so neither
        // the check nor the compiler objects. An empty embedding is not
        // degraded, it is silently meaningless — it would be stored and
        // similarity-searched as though it meant something.
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
            embedModel: 'nomic-embed-text',
        });
        mockEmbeddingsCreate.mockResolvedValueOnce({
            data: [{ index: 0, embedding: [] }],
        });

        await expect(provider.embed({ texts: ['first'] })).rejects.toThrow(/empty/i);
    });

    it('returns [] for empty input without calling the backend', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        const result = await provider.embed({ texts: [] });
        expect(result).toEqual([]);
        expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    });

    it('throws AiProviderError on a backend that lacks embeddings (groq)', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'groq', // embeddings: false
            baseURL: 'https://api.groq.com/openai/v1',
            apiKey: 'k',
            model: 'm',
        });
        await expect(provider.embed({ texts: ['x'] })).rejects.toBeInstanceOf(AiProviderError);
        expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    });

    it('throws on an embedding-count mismatch', async () => {
        const provider = new OpenAiCompatibleProvider({
            backend: 'ollama',
            baseURL: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            model: 'qwen3:1.7b',
        });
        mockEmbeddingsCreate.mockResolvedValueOnce({ data: [{ index: 0, embedding: [0.1] }] });
        await expect(provider.embed({ texts: ['a', 'b'] })).rejects.toBeInstanceOf(AiProviderError);
    });
});

// ─── Capability map sanity ───

describe('capability map', () => {
    it('marks ollama jsonSchema=false (conservative json_object path)', () => {
        expect(CAPABILITIES.ollama.jsonSchema).toBe(false);
        expect(CAPABILITIES.ollama.tools).toBe(true);
        expect(CAPABILITIES.ollama.streaming).toBe(true);
    });
    it('marks hosted backends jsonSchema=true', () => {
        expect(CAPABILITIES.openrouter.jsonSchema).toBe(true);
        expect(CAPABILITIES.groq.jsonSchema).toBe(true);
        expect(CAPABILITIES.together.jsonSchema).toBe(true);
    });
    it('marks embeddings on ollama/openrouter, off on groq/together/generic', () => {
        expect(CAPABILITIES.ollama.embeddings).toBe(true);
        expect(CAPABILITIES.openrouter.embeddings).toBe(true);
        expect(CAPABILITIES.groq.embeddings).toBe(false);
        expect(CAPABILITIES.together.embeddings).toBe(false);
        expect(CAPABILITIES['openai-compatible'].embeddings).toBe(false);
    });
});

// ─── (e) Factory selects from env ───

describe('getAiProvider factory + backend inference', () => {
    // Each case re-imports the factory under a freshly-mocked @/env so the
    // module-load read picks up the right config.
    function loadFactory(envOverrides: Record<string, string | undefined>) {
        jest.resetModules();
        jest.doMock('@/env', () => ({
            env: {
                AI_BACKEND: 'ollama',
                AI_BASE_URL: 'http://localhost:11434/v1',
                AI_API_KEY: 'ollama',
                AI_MODEL: 'qwen3:1.7b',
                ...envOverrides,
            },
        }));
        // openai mock is re-applied via the top-level jest.mock (hoisted).

        return require('@/app-layer/ai/provider/index');
    }

    afterEach(() => {
        jest.dontMock('@/env');
        jest.resetModules();
    });

    it('uses the Ollama dev defaults', () => {
        constructorCalls.length = 0;
        const { getAiProvider } = loadFactory({});
        const p = getAiProvider();
        expect(p.backend).toBe('ollama');
        expect(constructorCalls[0].baseURL).toBe('http://localhost:11434/v1');
        expect(constructorCalls[0].apiKey).toBe('ollama');
    });

    it('selects an OpenRouter config from env (inferred from base URL)', () => {
        constructorCalls.length = 0;
        const { getAiProvider } = loadFactory({
            AI_BASE_URL: 'https://openrouter.ai/api/v1',
            AI_API_KEY: 'or-key',
            AI_MODEL: 'anthropic/claude-3.5-sonnet',
        });
        const p = getAiProvider();
        expect(p.backend).toBe('openrouter');
        expect(constructorCalls[0].baseURL).toBe('https://openrouter.ai/api/v1');
        expect(constructorCalls[0].apiKey).toBe('or-key');
    });

    it('honours an explicit AI_BACKEND override', () => {
        const { getAiProvider } = loadFactory({ AI_BACKEND: 'groq', AI_BASE_URL: 'https://api.groq.com/openai/v1' });
        const p = getAiProvider();
        expect(p.backend).toBe('groq');
    });

    it('inferBackend maps known hosts', () => {
        const { inferBackend } = loadFactory({});
        expect(inferBackend('http://localhost:11434/v1')).toBe('ollama');
        expect(inferBackend('https://openrouter.ai/api/v1')).toBe('openrouter');
        expect(inferBackend('https://api.groq.com/openai/v1')).toBe('groq');
        expect(inferBackend('https://api.together.xyz/v1')).toBe('together');
        expect(inferBackend('https://unknown.example.com/v1')).toBe('openai-compatible');
    });
});

// ─── getEmbeddingProvider — resolved INDEPENDENTLY of AI_BACKEND ───
//
// (fix/rag-embedding-provider-split) Anthropic has no embeddings
// endpoint, so choosing AI_BACKEND='claude' for completions must never
// disable RAG embeddings. getEmbeddingProvider() is a SEPARATE seam
// that never returns ClaudeProvider and never reads AI_BACKEND.

describe('getEmbeddingProvider — independent of AI_BACKEND', () => {
    function loadFactory(envOverrides: Record<string, string | undefined>) {
        jest.resetModules();
        jest.doMock('@/env', () => ({
            env: {
                AI_BACKEND: 'ollama',
                AI_BASE_URL: 'http://localhost:11434/v1',
                AI_API_KEY: 'ollama',
                AI_MODEL: 'qwen3:1.7b',
                AI_EMBED_MODEL: 'nomic-embed-text',
                AI_EMBED_BACKEND: undefined,
                AI_EMBED_BASE_URL: undefined,
                AI_EMBED_API_KEY: undefined,
                ANTHROPIC_API_KEY: undefined,
                ...envOverrides,
            },
        }));
        return require('@/app-layer/ai/provider/index');
    }

    afterEach(() => {
        jest.dontMock('@/env');
        jest.resetModules();
    });

    it('still resolves an OpenAI-compatible embedding provider when AI_BACKEND=claude', () => {
        constructorCalls.length = 0;
        const { getEmbeddingProvider } = loadFactory({
            AI_BACKEND: 'claude',
            ANTHROPIC_API_KEY: 'sk-ant-test',
        });

        const embedProvider = getEmbeddingProvider();

        // NOT the ClaudeProvider — an OpenAiCompatibleProvider, so embed()
        // actually works instead of throwing. Proven two ways: the
        // backend tag, AND that construction went through the mocked
        // `openai` SDK (ClaudeProvider constructs `@anthropic-ai/sdk`,
        // which never touches `constructorCalls`).
        expect(embedProvider.backend).not.toBe('claude');
        expect(constructorCalls).toHaveLength(1);
        // Falls back to the completion path's base URL/key when no
        // AI_EMBED_* override is set.
        expect(constructorCalls[0].baseURL).toBe('http://localhost:11434/v1');
        expect(constructorCalls[0].apiKey).toBe('ollama');
    });

    it('AI_EMBED_BACKEND/BASE_URL/API_KEY point embeddings at a dedicated host, independent of AI_BACKEND=claude', () => {
        constructorCalls.length = 0;
        const { getEmbeddingProvider } = loadFactory({
            AI_BACKEND: 'claude',
            ANTHROPIC_API_KEY: 'sk-ant-test',
            AI_EMBED_BACKEND: 'openrouter',
            AI_EMBED_BASE_URL: 'https://openrouter.ai/api/v1',
            AI_EMBED_API_KEY: 'or-embed-key',
        });

        const embedProvider = getEmbeddingProvider();

        expect(embedProvider.backend).toBe('openrouter');
        expect(constructorCalls[0].baseURL).toBe('https://openrouter.ai/api/v1');
        expect(constructorCalls[0].apiKey).toBe('or-embed-key');
    });

    it('getAiProvider() (completions) and getEmbeddingProvider() disagree on backend when AI_BACKEND=claude', () => {
        const { getAiProvider, getEmbeddingProvider } = loadFactory({
            AI_BACKEND: 'claude',
            ANTHROPIC_API_KEY: 'sk-ant-test',
        });

        expect(getAiProvider().backend).toBe('claude');
        expect(getEmbeddingProvider().backend).not.toBe('claude');
    });

    it('falls back to the completion AI_BASE_URL/AI_API_KEY when embed-specific vars are unset (non-claude backend)', () => {
        constructorCalls.length = 0;
        const { getEmbeddingProvider } = loadFactory({
            AI_BASE_URL: 'https://openrouter.ai/api/v1',
            AI_API_KEY: 'or-key',
        });

        const embedProvider = getEmbeddingProvider();
        expect(embedProvider.backend).toBe('openrouter');
        expect(constructorCalls[0].baseURL).toBe('https://openrouter.ai/api/v1');
        expect(constructorCalls[0].apiKey).toBe('or-key');
    });
});
