/**
 * The message history the tool loop builds is ACCEPTED by the provider.
 *
 * This is the seam the #2654 outage went through. `assistant-tool-loop.test.ts`
 * mocks `complete` and asserts halts, links, truncation and precedence — all
 * about what the loop RETURNS. Nothing asserted what it HANDS OVER, so a
 * history that no provider would accept passed every test and failed every
 * real question the moment the flag went on.
 *
 * Anthropic's rule is the one that broke:
 *
 *     Each `tool_result` block must have a corresponding `tool_use` block in
 *     the previous message.
 *
 * So this file runs the REAL loop, feeds its history through the REAL
 * `ClaudeProvider` against a mocked SDK, and asserts that invariant on what
 * the SDK actually receives. It is deliberately not a second copy of the
 * loop's own assertions: the two suites fail for different reasons, and the
 * outage proved that passing one says nothing about the other.
 *
 * Why not just call the API? Because this must run in CI with no key and no
 * network. The invariant is structural, so it is checkable offline — and the
 * value is in checking the COMPOSITION, not either half.
 */
const anthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
    __esModule: true,
    default: class Anthropic {
        messages = { create: anthropicCreate, stream: jest.fn() };
        models = { list: jest.fn() };
    },
}));

const openaiCreate = jest.fn();
jest.mock('openai', () => ({
    __esModule: true,
    default: class OpenAI {
        chat = { completions: { create: openaiCreate } };
        embeddings = { create: jest.fn() };
        models = { list: jest.fn() };
    },
}));

const listTasks = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('@/app-layer/usecases/task', () => ({
    listTasks: (...a: unknown[]) => listTasks(...a),
}));
const analyzeBlockRisk = jest.fn<Promise<Record<string, unknown>>, unknown[]>();
jest.mock('@/app-layer/usecases/parcel-risk', () => ({
    analyzeBlockRisk: (...a: unknown[]) => analyzeBlockRisk(...a),
}));

import { ClaudeProvider } from '@/app-layer/ai/provider/claude-provider';
import { OpenAiCompatibleProvider } from '@/app-layer/ai/provider/openai-compatible-provider';
import { runToolLoop } from '@/app-layer/ai/assistant/tool-loop';
import type { AiMessage } from '@/app-layer/ai/provider/types';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { userId: 'u1', tenantId: 't1' });

/** Anthropic's rule, as a predicate over what the SDK was handed. */
function violations(sent: Array<{ role: string; content: unknown }>): string[] {
    const bad: string[] = [];
    for (let i = 0; i < sent.length; i += 1) {
        const content = sent[i].content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Array<Record<string, unknown>>) {
            if (block.type !== 'tool_result') continue;
            const id = block.tool_use_id;
            const prev = i > 0 ? sent[i - 1] : null;
            const prevBlocks = Array.isArray(prev?.content)
                ? (prev!.content as Array<Record<string, unknown>>)
                : [];
            const ok = prevBlocks.some((b) => b.type === 'tool_use' && b.id === id);
            if (!ok) bad.push(`messages.${i}: tool_result ${String(id)} has no tool_use in messages.${i - 1}`);
        }
    }
    return bad;
}

/**
 * OpenAI's equivalent rule, as a predicate over what ITS SDK was handed.
 *
 *     A message with role `tool` must be a response to a preceding message
 *     with `tool_calls`.
 *
 * It is NOT the same check as Anthropic's, which is why it is written out
 * rather than shared. Anthropic merges one round's results into a single user
 * message whose blocks must match the IMMEDIATELY preceding turn; OpenAI
 * takes one `tool` message per result, so several may follow one assistant
 * turn and the search has to walk back over its siblings.
 */
function openaiViolations(
    sent: Array<{ role: string; content?: unknown; tool_calls?: unknown }>,
): string[] {
    const bad: string[] = [];
    for (let i = 0; i < sent.length; i += 1) {
        if (sent[i].role !== 'tool') continue;
        const id = (sent[i] as { tool_call_id?: string }).tool_call_id;
        // Walk back over this round's other `tool` messages to the turn that
        // made the calls.
        let j = i - 1;
        while (j >= 0 && sent[j].role === 'tool') j -= 1;
        const owner = j >= 0 ? sent[j] : null;
        const calls = Array.isArray(owner?.tool_calls)
            ? (owner!.tool_calls as Array<{ id?: string }>)
            : [];
        if (owner?.role !== 'assistant' || !calls.some((c) => c.id === id)) {
            bad.push(`messages.${i}: tool ${String(id)} answers no tool_calls`);
        }
    }
    return bad;
}

describe('the loop builds a history the provider accepts (#2654)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        anthropicCreate.mockResolvedValue({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: 'end_turn',
        });
        listTasks.mockResolvedValue([{ id: 't1', title: 'Пръскане', status: 'OPEN' }]);
        analyzeBlockRisk.mockResolvedValue({
            locationName: 'Поле', analysed: 2, total: 2, worst: 'good',
            counts: { unknown: 0, good: 2, watch: 0, stress: 0 },
            configured: true, parcels: [], generatedAt: '2026-11-01T00:00:00.000Z',
        });
    });

    /** The loop, then the provider, then the invariant. */
    async function historyAsSent(rounds: Array<{ text: string; tools: string[][] }>) {
        let call = 0;
        // The parameters are DECLARED so `mock.calls[n][0]` is typed: an
        // untyped `jest.fn(async () => …)` gives `mock.calls` an empty tuple
        // and indexing it is a TS2493 that tests cannot catch.
        const complete = jest.fn(async (_messages: AiMessage[], _tools?: unknown) => {
            const r = rounds[Math.min(call++, rounds.length - 1)];
            return r.tools.length === 0
                ? { text: r.text }
                : {
                      text: r.text,
                      toolCalls: r.tools.map(([name, args], k) => ({
                          id: `toolu_${call}_${k}`,
                          name,
                          arguments: args,
                      })),
                  };
        });
        const loop = await runToolLoop(
            { ctx, complete: complete as never, send: () => {} },
            [{ role: 'user', content: 'Какво има днес' } as AiMessage],
        );
        // The history as the LAST model call saw it — the one that must be valid.
        const history = complete.mock.calls[complete.mock.calls.length - 1][0];
        anthropicCreate.mockClear();
        const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-opus-4-8' });
        await provider.complete({ messages: history });
        const sent = (anthropicCreate.mock.calls[0][0] as {
            messages: Array<{ role: string; content: unknown }>;
        }).messages;
        // The SAME history, through the OTHER provider. One loop builds one
        // history and EVERY configured provider has to accept it — routing
        // fails over, so a claude-only guarantee is not the property.
        openaiCreate.mockClear();
        openaiCreate.mockResolvedValue({
            choices: [{ message: { content: 'ok', tool_calls: [] } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
        const openai = new OpenAiCompatibleProvider({
            backend: 'groq',
            baseURL: 'https://api.groq.com/openai/v1',
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
        });
        await openai.complete({ messages: history });
        const sentOpenai = (openaiCreate.mock.calls[0][0] as {
            messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>;
        }).messages;
        return { sent, sentOpenai, loop };
    }

    it('one tool call in one round', async () => {
        const { sent, sentOpenai } = await historyAsSent([
            { text: 'Проверявам.', tools: [['list_farm_tasks', '{}']] },
            { text: 'Готово.', tools: [] },
        ]);
        // A control: the history must actually CONTAIN a tool_result, or the
        // invariant below passes over nothing.
        const results = sent.flatMap((m) =>
            Array.isArray(m.content)
                ? (m.content as Array<Record<string, unknown>>).filter((b) => b.type === 'tool_result')
                : [],
        );
        expect(results.length).toBeGreaterThan(0);
        expect(violations(sent)).toEqual([]);
        // A control on the other leg too: the OpenAI history must actually
        // carry `tool` messages, or its predicate passes over nothing.
        expect(sentOpenai.filter((m) => m.role === 'tool').length).toBeGreaterThan(0);
        expect(openaiViolations(sentOpenai)).toEqual([]);
    });

    it('TWO tool calls in one round — the split-turn case', async () => {
        const { sent, sentOpenai } = await historyAsSent([
            {
                text: '',
                tools: [['list_farm_tasks', '{}'], ['analyze_block_risk', '{"locationId":"loc-1"}']],
            },
            { text: 'Готово.', tools: [] },
        ]);
        const results = sent.flatMap((m) =>
            Array.isArray(m.content)
                ? (m.content as Array<Record<string, unknown>>).filter((b) => b.type === 'tool_result')
                : [],
        );
        expect(results.length).toBe(2);
        expect(violations(sent)).toEqual([]);
        // A control on the other leg too: the OpenAI history must actually
        // carry `tool` messages, or its predicate passes over nothing.
        expect(sentOpenai.filter((m) => m.role === 'tool').length).toBeGreaterThan(0);
        expect(openaiViolations(sentOpenai)).toEqual([]);
    });

    it('SEVERAL rounds', async () => {
        const { sent, sentOpenai } = await historyAsSent([
            { text: '', tools: [['list_farm_tasks', '{}']] },
            { text: '', tools: [['analyze_block_risk', '{"locationId":"loc-1"}']] },
            { text: 'Готово.', tools: [] },
        ]);
        expect(violations(sent)).toEqual([]);
        // A control on the other leg too: the OpenAI history must actually
        // carry `tool` messages, or its predicate passes over nothing.
        expect(sentOpenai.filter((m) => m.role === 'tool').length).toBeGreaterThan(0);
        expect(openaiViolations(sentOpenai)).toEqual([]);
    });

    it('a tool that REFUSED still leaves a well-formed history', async () => {
        // A refused tool still produces a `tool_result` — the model has to be
        // told it failed — so its `tool_use` must be there too.
        const { sent, sentOpenai } = await historyAsSent([
            { text: '', tools: [['analyze_block_risk', '{"locationId":"!!! not an id"}']] },
            { text: 'Не можах.', tools: [] },
        ]);
        const results = sent.flatMap((m) =>
            Array.isArray(m.content)
                ? (m.content as Array<Record<string, unknown>>).filter((b) => b.type === 'tool_result')
                : [],
        );
        expect(results.length).toBe(1);
        expect(violations(sent)).toEqual([]);
        // A control on the other leg too: the OpenAI history must actually
        // carry `tool` messages, or its predicate passes over nothing.
        expect(sentOpenai.filter((m) => m.role === 'tool').length).toBeGreaterThan(0);
        expect(openaiViolations(sentOpenai)).toEqual([]);
    });

    it('SELF-TEST: the OpenAI predicate detects its own orphan', async () => {
        // The OpenAI rule has its own shape, so it needs its own self-test —
        // a predicate that cannot fail is the class of mistake the outage
        // belongs to, once per predicate.
        expect(
            openaiViolations([
                { role: 'user', content: 'Каква е цената' },
                { role: 'tool', content: '{}', tool_call_id: 'call_orphan' } as never,
            ]),
        ).toEqual(['messages.1: tool call_orphan answers no tool_calls']);
        // And it must NOT fire on a well-formed pair, or every case above is
        // passing for the wrong reason.
        expect(
            openaiViolations([
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }],
                },
                { role: 'tool', content: '{}', tool_call_id: 'call_1' } as never,
            ]),
        ).toEqual([]);
    });

    it('SELF-TEST: the predicate detects the outage it was written for', async () => {
        // Without this the four assertions above could all be passing over a
        // predicate that cannot fail — which is the whole class of mistake the
        // outage belongs to.
        const broken = [
            { role: 'user', content: 'Каква е цената' },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: '{}' }],
            },
        ];
        expect(violations(broken)).toEqual([
            'messages.1: tool_result toolu_orphan has no tool_use in messages.0',
        ]);
    });
});
