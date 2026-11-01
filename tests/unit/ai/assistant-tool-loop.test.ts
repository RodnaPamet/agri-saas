/**
 * The bounded tool loop — #2578.
 *
 * The assertion that shapes the rest: when a budget runs out, a FINAL
 * tool-less model call still happens, so the halt has an answer to be
 * incomplete about. A halt with nothing above it is the
 * `ASSISTANT_PROVIDER_UNAVAILABLE` problem — telling somebody their
 * non-existent answer is partial.
 */
const analyzeBlockRisk = jest.fn<Promise<Record<string, unknown>>, unknown[]>();
jest.mock('@/app-layer/usecases/parcel-risk', () => ({
    analyzeBlockRisk: (...a: unknown[]) => analyzeBlockRisk(...a),
}));

const listTasks = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('@/app-layer/usecases/task', () => ({
    listTasks: (...a: unknown[]) => listTasks(...a),
}));

import {
    emitHalt,
    MAX_TOOL_CALLS,
    runToolLoop,
    TOOL_PHASE_BUDGET_MS,
} from '@/app-layer/ai/assistant/tool-loop';
import { makeRequestContext } from '../../helpers/make-context';

/**
 * A REAL context — `runTool` asserts the read policy centrally now, and
 * `assertCanRead` reads `ctx.permissions.canRead`. The stub here had
 * `permissions: {}`, so four of these tests were exercising a context that
 * CANNOT read and passing only because every usecase was mocked.
 */
const ctx = makeRequestContext('EDITOR', { userId: 'u1', tenantId: 't1' });

const harness = () => {
    const sent: string[] = [];
    return {
        sent,
        send: (c: string) => sent.push(c),
        types: () => sent.map((c) => (JSON.parse(c.replace(/^data: /, '').trim()) as { type: string }).type),
        events: () => sent.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as Record<string, unknown>),
    };
};

const call = (name: string, args = '{}') => ({ id: `c-${name}`, name, arguments: args });

describe('the assistant tool loop (#2578)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        listTasks.mockResolvedValue([{ id: 't1', title: 'Пръскане', status: 'OPEN' }]);
    });

    it('no tool calls: one answer, no halt, no tool events', async () => {
        const h = harness();
        const complete = jest.fn().mockResolvedValue({ text: 'Нищо спешно.' });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        expect(r).toMatchObject({ text: 'Нищо спешно.', halt: null, toolCallsMade: 0 });
        expect(h.types()).toEqual([]);
        expect(complete).toHaveBeenCalledTimes(1);
    });

    it('names the tool BEFORE the result, then answers', async () => {
        const h = harness();
        const complete = jest
            .fn()
            .mockResolvedValueOnce({ text: '', toolCalls: [call('list_farm_tasks')] })
            .mockResolvedValueOnce({ text: 'Имате една задача.' });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        expect(h.types()).toEqual(['tool_call', 'tool_result']);
        expect(h.events()[0]).toEqual({ type: 'tool_call', name: 'list_farm_tasks' });
        expect(h.events()[1]).toMatchObject({ name: 'list_farm_tasks', ok: true, truncated: false });
        expect(r).toMatchObject({ text: 'Имате една задача.', halt: null, toolCallsMade: 1 });
    });

    it('the CAP halts with TOOL_BUDGET — and still makes a final tool-less call', async () => {
        const h = harness();
        // Always asks for a tool, so only the cap can stop it.
        const complete = jest.fn().mockResolvedValue({ text: '', toolCalls: [call('list_farm_tasks')] });
        complete.mockResolvedValueOnce({ text: '', toolCalls: [call('list_farm_tasks')] });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        expect(r.halt).toBe('ASSISTANT_TOOL_BUDGET');
        expect(r.toolCallsMade).toBe(MAX_TOOL_CALLS);
        // The decisive part: the LAST call passed no tools, so the model could
        // answer from what it had.
        const lastTools = complete.mock.calls[complete.mock.calls.length - 1][1];
        expect(lastTools).toBeUndefined();
    });

    it('the TIME budget halts with TIME_BUDGET, and also answers', async () => {
        const h = harness();
        let t = 0;
        // Injected clock: the first round is inside the budget, the second is
        // past it. Without the seam this test would wait 25 seconds.
        const now = () => {
            t += TOOL_PHASE_BUDGET_MS + 1;
            return t;
        };
        const complete = jest
            .fn()
            .mockResolvedValue({ text: 'Частичен отговор.', toolCalls: [call('list_farm_tasks')] });
        const r = await runToolLoop({ ctx, complete, send: h.send, now }, []);
        expect(r.halt).toBe('ASSISTANT_TIME_BUDGET');
        expect(r.text).toBe('Частичен отговор.');
        expect(complete.mock.calls[complete.mock.calls.length - 1][1]).toBeUndefined();
    });

    it('a PARTIAL result halts with PARTIAL_DATA — the prose is not relied on (#2639)', async () => {
        // `analyze_block_risk` returns `analysed`/`total` and its description
        // asks the model to say them. A description is a request and the prose
        // is the model's, and agrent-ios made the observation that settles it:
        // the phone renders nothing from the payload, so the answer prose is
        // the ONLY place the pair can be lost. So the disclosure is a HALT,
        // which accompanies the answer rather than replacing it.
        const h = harness();
        analyzeBlockRisk.mockResolvedValue({
            locationName: 'Голямо поле', analysed: 24, total: 30, worst: 'good',
            counts: { unknown: 0, good: 24, watch: 0, stress: 0 },
            configured: true, parcels: [], generatedAt: '2026-11-01T00:00:00.000Z',
        });
        const complete = jest
            .fn()
            .mockResolvedValueOnce({ text: '', toolCalls: [call('analyze_block_risk', '{"locationId":"loc-1"}')] })
            // The model answers without the numbers — the exact case.
            .mockResolvedValueOnce({ text: 'Нищо не е под стрес.' });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        expect(r.partialAny).toBe(true);
        expect(r.halt).toBe('ASSISTANT_PARTIAL_DATA');
        // The answer still reaches the person; the halt says it is incomplete.
        expect(r.text).toBe('Нищо не е под стрес.');
    });

    it('a COMPLETE result halts with nothing', async () => {
        // The control. Without it the assertion above is satisfied by a flag
        // that is always set, which would halt on every block-risk question.
        const h = harness();
        analyzeBlockRisk.mockResolvedValue({
            locationName: 'Голямо поле', analysed: 30, total: 30, worst: 'good',
            counts: { unknown: 0, good: 30, watch: 0, stress: 0 },
            configured: true, parcels: [], generatedAt: '2026-11-01T00:00:00.000Z',
        });
        const complete = jest
            .fn()
            .mockResolvedValueOnce({ text: '', toolCalls: [call('analyze_block_risk', '{"locationId":"loc-1"}')] })
            .mockResolvedValueOnce({ text: 'Нищо не е под стрес.' });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        expect({ partialAny: r.partialAny, halt: r.halt }).toEqual({ partialAny: false, halt: null });
    });

    it('PRECEDENCE: truncation beats partial, and partial is still on the result', async () => {
        // Both are true here. TRUNCATED wins because it is the narrower
        // statement about THIS turn — the model did not see all of what was
        // gathered — while partial data would be partial however much was
        // read. `partialAny` stays set so nothing is silent.
        const h = harness();
        analyzeBlockRisk.mockResolvedValue({
            locationName: 'Голямо поле', analysed: 1, total: 99, worst: 'stress',
            counts: { unknown: 0, good: 0, watch: 0, stress: 1 },
            configured: true,
            // Long enough to exceed TOOL_RESULT_MAX_CHARS.
            // The projection keeps only 12 `attention` rows, so 400 short
            // ones do NOT exceed the cap — my own bound was doing its job and
            // the first version of this fixture could not make the result
            // truncated at all. Twelve very long names do.
            parcels: Array.from({ length: 12 }, (_, i) => ({
                name: `П-${i}-${'x'.repeat(1200)}`, overall: 'stress',
                vegetation: 'stress', moisture: 'stress', acquiredDate: '2026-10-30',
            })),
            generatedAt: '2026-11-01T00:00:00.000Z',
        });
        const complete = jest
            .fn()
            .mockResolvedValueOnce({ text: '', toolCalls: [call('analyze_block_risk', '{"locationId":"loc-1"}')] })
            .mockResolvedValueOnce({ text: 'Част от парцелите.' });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        expect({ truncatedAny: r.truncatedAny, partialAny: r.partialAny, halt: r.halt }).toEqual({
            truncatedAny: true,
            partialAny: true,
            halt: 'ASSISTANT_TRUNCATED_RESULT',
        });
    });

    it('pushes the assistant TOOL_USE turn before the tool result — the outage', async () => {
        // The bug that broke every question the moment the flag went on.
        //
        // The loop pushed a `role: 'tool'` message per result and NEVER the
        // assistant turn that made the calls, so the history reached Anthropic
        // as `[question] [tool_result]` and was refused:
        //
        //   messages.0.content.2: unexpected `tool_use_id` found in
        //   `tool_result` blocks … Each `tool_result` block must have a
        //   corresponding `tool_use` block in the previous message.
        //
        // A 400 on a malformed request, so it failed for EVERY model and was
        // not environmental. The shape was previously inexpressible:
        // `AiMessage.content` is a string, so there was nowhere to put the
        // calls.
        const h = harness();
        const complete = jest
            .fn()
            .mockResolvedValueOnce({ text: 'Проверявам.', toolCalls: [call('list_farm_tasks')] })
            .mockResolvedValueOnce({ text: 'Имате една задача.' });
        await runToolLoop({ ctx, complete, send: h.send }, []);

        // The history handed to the SECOND call is the one that matters.
        const history = complete.mock.calls[1][0] as Array<Record<string, unknown>>;
        const toolIdx = history.findIndex((m) => m.role === 'tool');
        expect(toolIdx).toBeGreaterThan(0);
        const before = history[toolIdx - 1];
        expect(before.role).toBe('assistant');
        // Carrying the call whose id the result answers — that correspondence
        // IS the thing the API checks.
        expect((before.toolCalls as Array<{ id: string }>).map((c) => c.id)).toEqual([
            (history[toolIdx] as { toolCallId: string }).toolCallId,
        ]);
    });

    it('puts ALL of one round\'s calls on a SINGLE assistant turn', async () => {
        // They belong to one assistant turn. Splitting them would place a
        // `tool_result` after a message holding a DIFFERENT call's `tool_use`,
        // which is the same refusal one step further on.
        const h = harness();
        const complete = jest
            .fn()
            .mockResolvedValueOnce({
                text: '',
                toolCalls: [call('list_farm_tasks'), call('list_blocks')],
            })
            .mockResolvedValueOnce({ text: 'Готово.' });
        await runToolLoop({ ctx, complete, send: h.send }, []);
        const history = complete.mock.calls[1][0] as Array<Record<string, unknown>>;
        const assistants = history.filter((m) => m.role === 'assistant' && m.toolCalls);
        expect(assistants).toHaveLength(1);
        expect((assistants[0].toolCalls as unknown[]).length).toBe(2);
        // And every tool result's id corresponds to one of them.
        const ids = new Set((assistants[0].toolCalls as Array<{ id: string }>).map((c) => c.id));
        for (const m of history.filter((x) => x.role === 'tool')) {
            expect(ids.has((m as { toolCallId: string }).toolCallId)).toBe(true);
        }
    });

    it('a PARTIAL fact survives a higher-precedence halt (#2639)', async () => {
        // The principle this file's own docblock states for truncation:
        // "Truncation is additionally always reported on `done.truncatedAny`,
        // so it is never silent even when a higher-precedence halt wins."
        //
        // `partialAny` needs the same treatment, and I had not given it any —
        // the loop computed it and the `done` event did not carry it. A turn
        // that was partial AND out of time reports TIME, and the partial half
        // would have vanished. Caught by reading the stream union, not by a
        // test, which is why this one exists.
        const h = harness();
        // The clock must stay INSIDE the budget until the tool has run, then
        // pass it — otherwise the loop halts before any tool executes and
        // nothing is partial, which is how this test first failed.
        let reads = 0;
        const now = () => {
            reads += 1;
            return reads <= 2 ? 0 : TOOL_PHASE_BUDGET_MS + 1;
        };
        analyzeBlockRisk.mockResolvedValue({
            locationName: 'Голямо поле', analysed: 3, total: 40, worst: 'stress',
            counts: { unknown: 0, good: 2, watch: 0, stress: 1 },
            configured: true, parcels: [], generatedAt: '2026-11-01T00:00:00.000Z',
        });
        const complete = jest.fn().mockResolvedValue({
            text: 'Частичен отговор.',
            toolCalls: [call('analyze_block_risk', '{"locationId":"loc-1"}')],
        });
        const r = await runToolLoop({ ctx, complete, send: h.send, now }, []);
        // The HALT is the higher-precedence one…
        expect(r.halt).toBe('ASSISTANT_TIME_BUDGET');
        // …and the partial fact is still reported, which is what the route
        // puts on `done.partialAny`.
        expect(r.partialAny).toBe(true);
    });

    it('a truncated result sets truncatedAny and halts with TRUNCATED_RESULT', async () => {
        const h = harness();
        listTasks.mockResolvedValue(
            Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, title: 'a'.repeat(40), status: 'OPEN' })),
        );
        const complete = jest
            .fn()
            .mockResolvedValueOnce({ text: '', toolCalls: [call('list_farm_tasks')] })
            .mockResolvedValueOnce({ text: 'Част от задачите.' });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        expect(r.truncatedAny).toBe(true);
        expect(r.halt).toBe('ASSISTANT_TRUNCATED_RESULT');
        expect(h.events()[1]).toMatchObject({ truncated: true });
    });

    it('PRECEDENCE: a time halt beats a truncation halt, and truncation is still on done', async () => {
        // Two halts would ask a person to reconcile two reasons for one stop.
        const h = harness();
        listTasks.mockResolvedValue(
            Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, title: 'a'.repeat(40), status: 'OPEN' })),
        );
        let calls = 0;
        // TWO calls inside the budget, not one: the loop reads the clock once
        // for `started` and again for round 0's check. Returning the overrun
        // on the second call tripped the budget BEFORE any tool ran, so
        // nothing was truncated and this test failed for the opposite of its
        // subject. The stub has to let round 0 execute.
        const now = () => {
            calls++;
            return calls <= 2 ? 0 : TOOL_PHASE_BUDGET_MS + 1;
        };
        const complete = jest.fn().mockResolvedValue({ text: 'x', toolCalls: [call('list_farm_tasks')] });
        const r = await runToolLoop({ ctx, complete, send: h.send, now }, []);
        expect(r.halt).toBe('ASSISTANT_TIME_BUDGET');
        // Not lost — the caller puts it on `done`.
        expect(r.truncatedAny).toBe(true);
        expect(r.toolCallsMade).toBeGreaterThanOrEqual(1);
    });

    it('a FAILED tool is reported to the model, and the turn still answers', async () => {
        const h = harness();
        const complete = jest
            .fn()
            .mockResolvedValueOnce({ text: '', toolCalls: [call('no_such_tool')] })
            .mockResolvedValueOnce({ text: 'Не виждам тези данни.' });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        expect(h.events()[1]).toMatchObject({ ok: false });
        expect(r).toMatchObject({ text: 'Не виждам тези данни.', halt: null });
        // The failure went into the conversation rather than ending the turn.
        const second = complete.mock.calls[1][0] as Array<{ role: string; content: string }>;
        expect(second.some((m) => m.role === 'tool' && m.content.includes('No such tool'))).toBe(true);
    });

    it('merges links across tool calls, de-duplicated', async () => {
        listTasks
            .mockResolvedValueOnce([{ id: 'a1', title: 'Пръскане', status: 'OPEN' }])
            .mockResolvedValueOnce([
                { id: 'a1', title: 'Пръскане', status: 'OPEN' },
                { id: 'a2', title: 'Торене', status: 'OPEN' },
            ]);
        const h = harness();
        const complete = jest
            .fn()
            .mockResolvedValueOnce({ text: '', toolCalls: [call('list_farm_tasks')] })
            .mockResolvedValueOnce({ text: '', toolCalls: [call('list_farm_tasks')] })
            .mockResolvedValueOnce({ text: 'Две задачи.' });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        // `a1` came back twice and appears once — de-duplicated by ROUTE.
        expect(r.links.map((l) => l.route)).toEqual(['/farm-tasks/a1', '/farm-tasks/a2']);
    });

    it('a turn with no tool calls offers no links', async () => {
        const h = harness();
        const complete = jest.fn().mockResolvedValue({ text: 'Нищо спешно.' });
        const r = await runToolLoop({ ctx, complete, send: h.send }, []);
        expect(r.links).toEqual([]);
    });

    it('emitHalt sends nothing when there is no halt', async () => {
        const h = harness();
        await emitHalt(h.send, null);
        expect(h.sent).toEqual([]);
        await emitHalt(h.send, 'ASSISTANT_TOOL_BUDGET');
        expect(h.types()).toEqual(['halt']);
        expect(h.events()[0]).toMatchObject({ code: 'ASSISTANT_TOOL_BUDGET' });
        expect(String(h.events()[0].message)).toMatch(/[Ѐ-ӿ]/);
    });
});
