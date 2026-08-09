/**
 * Native Claude provider — unit tests (fully mocked, NO live network).
 *
 * Mocks `@anthropic-ai/sdk` and exercises ClaudeProvider against the
 * same AiProvider contract the OpenAI-compat provider satisfies:
 *   (a) structured output via a forced tool-use block → Zod-validated
 *   (b) validate/repair fallback fires when the first tool input is
 *       invalid, then succeeds; throws AiProviderError if still bad
 *   (c) tools round-trip (passed through; toolCalls returned)
 *   (d) streaming assembles text + tool-input deltas
 *   (e) system-prompt mapping (system → top-level system param, cached)
 *   (f) embed() throws (no Anthropic embeddings endpoint)
 *   (g) health() reports modelAvailable + never throws
 */
import { z } from 'zod';

// ─── Mock the Anthropic SDK ───
const mockMessagesCreate = jest.fn();
const mockMessagesStream = jest.fn();
const mockModelsList = jest.fn();
const constructorCalls: Array<{ apiKey?: string; baseURL?: string }> = [];

jest.mock('@anthropic-ai/sdk', () => {
    class MockAnthropic {
        messages: { create: jest.Mock; stream: jest.Mock };
        models: { list: jest.Mock };
        constructor(opts: { apiKey?: string; baseURL?: string }) {
            constructorCalls.push({ apiKey: opts.apiKey, baseURL: opts.baseURL });
            this.messages = { create: mockMessagesCreate, stream: mockMessagesStream };
            this.models = { list: mockModelsList };
        }
    }
    return { __esModule: true, default: MockAnthropic, Anthropic: MockAnthropic };
});

import { ClaudeProvider, DEFAULT_CLAUDE_MODEL } from '@/app-layer/ai/provider/claude-provider';
import { AiProviderError } from '@/app-layer/ai/provider/openai-compatible-provider';
import type { AiToolDef } from '@/app-layer/ai/provider/types';

// Helper — a non-streaming Anthropic message response.
function messageResponse(blocks: Anthropic_ContentBlock[], stopReason = 'end_turn') {
    return { content: blocks, stop_reason: stopReason };
}
type Anthropic_ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown };

// Helper — an async-iterable Anthropic event stream.
function eventStream(events: unknown[]) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
        },
    };
}

const Schema = z.object({ title: z.string(), score: z.number() });

beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockMessagesStream.mockReset();
    mockModelsList.mockReset();
    constructorCalls.length = 0;
});

function provider() {
    return new ClaudeProvider({ apiKey: 'sk-test', model: 'claude-opus-4-8' });
}

// ─── (a) Structured output via forced tool-use ───

describe('structured output — forced tool-use', () => {
    it('round-trips a Zod schema → tool input → parsed object', async () => {
        mockMessagesCreate.mockResolvedValueOnce(
            messageResponse([{ type: 'tool_use', id: 't1', name: 'thing', input: { title: 'A', score: 5 } }]),
        );

        const result = await provider().complete({
            messages: [{ role: 'user', content: 'hi' }],
            schema: Schema,
            schemaName: 'thing',
        });

        expect(result.parsed).toEqual({ title: 'A', score: 5 });
        const call = mockMessagesCreate.mock.calls[0][0];
        // The forced tool was sent with tool_choice pinning it.
        expect(call.tools[0].name).toBe('thing');
        expect(call.tool_choice).toEqual({ type: 'tool', name: 'thing' });
        expect(call.tools[0].input_schema).toBeTruthy();
    });

    it('repairs once when the first tool input fails validation', async () => {
        mockMessagesCreate
            .mockResolvedValueOnce(
                messageResponse([{ type: 'tool_use', id: 't1', name: 'respond', input: { title: 'B', score: 'nope' } }]),
            )
            .mockResolvedValueOnce(
                messageResponse([{ type: 'tool_use', id: 't2', name: 'respond', input: { title: 'B', score: 9 } }]),
            );

        const result = await provider().complete({
            messages: [{ role: 'user', content: 'go' }],
            schema: Schema,
        });

        expect(result.parsed).toEqual({ title: 'B', score: 9 });
        expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
        // Repair re-prompt feeds back the bad output + a correction note.
        const repairCall = mockMessagesCreate.mock.calls[1][0];
        const lastUser = repairCall.messages[repairCall.messages.length - 1];
        expect(lastUser.role).toBe('user');
        expect(lastUser.content).toContain('corrected');
    });

    it('throws AiProviderError when still invalid after repair', async () => {
        mockMessagesCreate
            .mockResolvedValueOnce(messageResponse([{ type: 'tool_use', id: 't1', name: 'respond', input: { x: 1 } }]))
            .mockResolvedValueOnce(messageResponse([{ type: 'tool_use', id: 't2', name: 'respond', input: { y: 2 } }]));

        await expect(
            provider().complete({ messages: [{ role: 'user', content: 'go' }], schema: Schema }),
        ).rejects.toBeInstanceOf(AiProviderError);
    });

    it('throws when the model returns no tool_use block', async () => {
        mockMessagesCreate.mockResolvedValueOnce(messageResponse([{ type: 'text', text: 'no tool' }]));
        await expect(
            provider().complete({ messages: [{ role: 'user', content: 'go' }], schema: Schema }),
        ).rejects.toBeInstanceOf(AiProviderError);
    });
});

// ─── (b) Tools round-trip ───

describe('tool calling', () => {
    it('passes tools through and surfaces toolCalls', async () => {
        const tools: AiToolDef[] = [
            { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: {} } },
        ];
        mockMessagesCreate.mockResolvedValueOnce(
            messageResponse([{ type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'Paris' } }]),
        );

        const result = await provider().complete({
            messages: [{ role: 'user', content: 'weather?' }],
            tools,
        });

        const call = mockMessagesCreate.mock.calls[0][0];
        expect(call.tools[0].name).toBe('get_weather');
        expect(call.tools[0].input_schema).toEqual({ type: 'object', properties: {} });
        expect(result.toolCalls).toEqual([
            { id: 'c1', name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) },
        ]);
    });
});

// ─── (c) Streaming ───

describe('streaming', () => {
    it('assembles text from streamed content_block_delta events', async () => {
        mockMessagesStream.mockReturnValueOnce(
            eventStream([
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo ' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
            ]),
        );

        const result = await provider().complete({
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
        });

        expect(result.text).toBe('Hello world');
        expect(mockMessagesStream).toHaveBeenCalledTimes(1);
        expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it('assembles streamed tool-input deltas into a toolCall', async () => {
        mockMessagesStream.mockReturnValueOnce(
            eventStream([
                { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc', name: 'do_it' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } },
            ]),
        );

        const result = await provider().complete({
            messages: [{ role: 'user', content: 'go' }],
            stream: true,
        });

        expect(result.toolCalls).toEqual([{ id: 'tc', name: 'do_it', arguments: '{"a":1}' }]);
    });
});

// ─── (d) System-prompt mapping ───

describe('system-prompt mapping', () => {
    it('maps system messages to the top-level system param with cache_practice', async () => {
        mockMessagesCreate.mockResolvedValueOnce(messageResponse([{ type: 'text', text: 'ok' }]));

        await provider().complete({
            messages: [
                { role: 'system', content: 'be precise' },
                { role: 'system', content: 'use SI units' },
                { role: 'user', content: 'go' },
            ],
        });

        const call = mockMessagesCreate.mock.calls[0][0];
        // System concatenated into one cached text block; NOT in messages.
        expect(call.system[0].type).toBe('text');
        expect(call.system[0].text).toContain('be precise');
        expect(call.system[0].text).toContain('use SI units');
        expect(call.system[0].cache_practice).toEqual({ type: 'ephemeral' });
        expect(call.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true);
        expect(call.messages[0]).toEqual({ role: 'user', content: 'go' });
    });

    it('maps a tool message to a tool_result block on a user turn', async () => {
        mockMessagesCreate.mockResolvedValueOnce(messageResponse([{ type: 'text', text: 'ok' }]));

        await provider().complete({
            messages: [
                { role: 'user', content: 'q' },
                { role: 'assistant', content: 'calling tool' },
                { role: 'tool', content: 'result body', toolCallId: 'call_42' },
            ],
        });

        const call = mockMessagesCreate.mock.calls[0][0];
        const last = call.messages[call.messages.length - 1];
        expect(last.role).toBe('user');
        expect(last.content[0]).toEqual({
            type: 'tool_result',
            tool_use_id: 'call_42',
            content: 'result body',
        });
    });
});

// ─── (e) embed() throws ───

describe('embed()', () => {
    it('throws AiProviderError — Anthropic has no embeddings endpoint', async () => {
        await expect(provider().embed({ texts: ['x'] })).rejects.toBeInstanceOf(AiProviderError);
    });
});

// ─── (f) health() ───

describe('health()', () => {
    function modelList(ids: string[]) {
        return {
            async *[Symbol.asyncIterator]() {
                for (const id of ids) yield { id };
            },
        };
    }

    it('reports modelAvailable=true when the model is listed', async () => {
        mockModelsList.mockResolvedValueOnce(modelList(['claude-haiku-4-5', 'claude-opus-4-8']));
        const h = await provider().health();
        expect(h.ok).toBe(true);
        expect(h.modelAvailable).toBe(true);
        expect(h.model).toBe('claude-opus-4-8');
    });

    it('reports modelAvailable=false when the model is missing', async () => {
        mockModelsList.mockResolvedValueOnce(modelList(['claude-haiku-4-5']));
        const h = await provider().health();
        expect(h.ok).toBe(true);
        expect(h.modelAvailable).toBe(false);
        expect(h.detail).toContain('not found');
    });

    it('returns ok:false and never throws when the probe fails', async () => {
        mockModelsList.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const h = await provider().health();
        expect(h.ok).toBe(false);
        expect(h.modelAvailable).toBe(false);
        expect(h.detail).toContain('ECONNREFUSED');
    });
});

// ─── (g) defaults + backend ───

describe('config', () => {
    it('uses the Opus default model when none is supplied', () => {
        const p = new ClaudeProvider({ apiKey: 'sk' });
        expect(p.backend).toBe('claude');
        expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-4-8');
    });

    it('passes apiKey + baseURL to the SDK constructor', () => {
        new ClaudeProvider({ apiKey: 'sk-x', baseURL: 'https://proxy.example/v1' });
        expect(constructorCalls[0].apiKey).toBe('sk-x');
        expect(constructorCalls[0].baseURL).toBe('https://proxy.example/v1');
    });
});
