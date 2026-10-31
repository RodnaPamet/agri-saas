/**
 * The bounded tool loop — #2578.
 *
 * The assertion that shapes the rest: when a budget runs out, a FINAL
 * tool-less model call still happens, so the halt has an answer to be
 * incomplete about. A halt with nothing above it is the
 * `ASSISTANT_PROVIDER_UNAVAILABLE` problem — telling somebody their
 * non-existent answer is partial.
 */
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

const ctx = { userId: 'u1', tenantId: 't1', role: 'EDITOR', permissions: {}, appPermissions: {} } as never;

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
