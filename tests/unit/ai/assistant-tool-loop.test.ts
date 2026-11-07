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

/**
 * The stage-timing store is MOCKED, and that is load-bearing for this suite
 * rather than tidiness (#2803).
 *
 * `runToolLoop` awaits `recordStageTiming`, which INSERTS a row. This suite's
 * context is `tenantId: 't1'`, which exists in no database, so the insert went
 * to the per-worker test DB through the global client and failed an FK
 * constraint — and the store is best-effort by design, so it logged and
 * swallowed and nothing failed. Measured 32ms / 61ms / 541ms on three
 * consecutive turns, against assertions below whose budgets are tens of
 * milliseconds; a 541ms excursion is enough to invert "the round is not the
 * sum of its tools". The suite passed alone and failed roughly one run in two
 * under full-root parallelism, which is the signature of a real round trip to
 * Postgres on a connection a unit test never asked for.
 *
 * Nothing is lost by mocking it here: the store's own behaviour is covered by
 * `assistant-stage-timing-is-best-effort.test.ts` (including a positive
 * control) and by `tests/integration/assistant-stage-timing-rls.test.ts`.
 *
 * The general rule this cost us: a unit suite that reaches Postgres is a unit
 * suite whose timing belongs to the machine. An awaited best-effort write is
 * the dangerous shape, because its failure path is silent.
 */
const recordStageTiming = jest.fn<Promise<void>, unknown[]>();
jest.mock('@/app-layer/ai/assistant/stage-timing-store', () => ({
    recordStageTiming: (...a: unknown[]) => recordStageTiming(...a),
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

    /**
     * The control for the mock above, and the reason it is a test rather than
     * a comment: "the mock did not apply" is SILENT. If the module path is
     * renamed, or the store grows a second export and the factory stops
     * matching, jest hands back the REAL module, `runToolLoop` goes back to
     * inserting a row for a tenant that does not exist, and this suite returns
     * to flaking about one run in two — with every assertion below still
     * green. Asserting the double was CALLED is what makes that loud.
     *
     * It also pins that the loop still records a timing at all: a future
     * refactor that drops the `recordStageTiming` call would make the stage
     * figures stop being written in production, which no timing assertion
     * below would notice, because they all read the RETURNED value.
     */
    it('records a stage timing through the mocked store, never the database', async () => {
        const h = harness();
        const complete = jest.fn().mockResolvedValue({ text: 'Нищо спешно.' });
        await runToolLoop({ ctx, complete, send: h.send }, []);
        expect(recordStageTiming).toHaveBeenCalledTimes(1);
        // The tenant is the first argument — the FK that had no row.
        expect(recordStageTiming.mock.calls[0][0]).toBe('t1');
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
            Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: 'a'.repeat(900), status: 'OPEN' })),
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
            Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: 'a'.repeat(900), status: 'OPEN' })),
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

describe('one round runs its tools in PARALLEL, and folds them in order (#2670)', () => {
    /** Resolve after `ms` of REAL time, so overlap is observable. */
    const after = <T,>(ms: number, value: T): Promise<T> =>
        new Promise((resolve) => setTimeout(() => resolve(value), ms));

    it('two tools in one round OVERLAP — the round is not the sum of its tools', async () => {
        /*
         * OVERLAP is measured directly, which is what the test is named for.
         *
         * It used to be inferred from TOTAL DURATION: each tool slept 60ms, so
         * a sequential round took ≥120ms and a parallel one ≈60ms, and the
         * assertion was `elapsed < 100`. That bound is 40ms of headroom over a
         * 60ms baseline, measured on a machine doing nothing else — and CI
         * runs six jest shards with `--coverage` on one runner. It failed on
         * `Test (shard 5/6)` of run 42417250693 and passed locally in 64ms on
         * the same commit, which is the signature of a load-correlated bound
         * rather than a broken property.
         *
         * Raising the bound would buy time and keep the defect: an absolute
         * duration is the wrong instrument, because a loaded runner inflates
         * the parallel and the sequential world together. What separates them
         * is whether the SECOND tool starts before the FIRST one finishes —
         * and load delays both tools equally, so that comparison holds at any
         * speed. Same mutation it was written against (`for … await` makes the
         * second start after the first resolves), measured on the event rather
         * than through a proxy for it.
         *
         * Real timers deliberately: a fake-timer version would assert that
         * `Promise.all` was called, which is the implementation rather than
         * the property.
         */
        const marks: Array<{ tool: string; at: number; done: number }> = [];
        /** Sleep `ms` of REAL time, recording when this tool ran. */
        const timed = <T,>(tool: string, ms: number, value: T): Promise<T> => {
            const mark = { tool, at: Date.now(), done: 0 };
            marks.push(mark);
            return after(ms, value).then((v) => {
                mark.done = Date.now();
                return v;
            });
        };
        listTasks.mockImplementation(() => timed('list', 60, []));
        analyzeBlockRisk.mockImplementation(() => timed('risk', 60, { blocks: [] }));

        const h = harness();
        const complete = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValueOnce({ toolCalls: [call('list_farm_tasks'), call('analyze_block_risk', '{"locationId":"loc-1"}')] })
            .mockResolvedValueOnce({ text: 'готово' });

        const started = Date.now();
        const out = await runToolLoop({ ctx, send: h.send, complete } as never, []);
        const elapsed = Date.now() - started;

        expect(out.toolCallsMade).toBe(2);
        /*
         * CONTROL, and it is load-bearing. The first version of this test used
         * `list_tasks` — not a real tool — so `runTool` returned `{ ok: false }`
         * without calling either mock. Neither world slept, the timing bound
         * passed in both, and reverting the `Promise.all` left all 21 tests
         * green. A probe with the same reading in both worlds.
         *
         * Asserting the mocks RAN is what makes the bound below mean
         * something: a renamed tool now fails here rather than silently
         * disarming the measurement.
         */
        expect(listTasks).toHaveBeenCalledTimes(1);
        expect(analyzeBlockRisk).toHaveBeenCalledTimes(1);

        // Both tools ran, and in the order the model called them — without
        // this the comparison below could be between one mark and itself.
        expect(marks.map((m) => m.tool)).toEqual(['list', 'risk']);

        // THE PROPERTY: the second tool started before the first finished.
        // Scale-free — a loaded runner pushes both `at` and `done` out
        // together, so the inequality survives any amount of contention,
        // where an absolute bound does not.
        expect(marks[1].at).toBeLessThan(marks[0].done);

        // And the loop's own figure agrees: `toolPhaseMs` is the slowest tool
        // rather than the sum, so it must come in under the two tools' total
        // measured duration. Compared against what the tools ACTUALLY took on
        // this run rather than against a constant, for the same reason.
        const totalToolMs = marks.reduce((sum, m) => sum + (m.done - m.at), 0);
        expect(out.timing.toolPhaseMs).toBeLessThan(totalToolMs);

        // `elapsed` is read so the variable is not dead, and bounded loosely
        // rather than tightly: it is a sanity check that the round finished at
        // all, NOT the parallelism measurement. The two assertions above are.
        expect(elapsed).toBeLessThan(10_000);
    });

    it('the FOLD is in the model’s call order, not completion order', async () => {
        /*
         * The correctness half. The second tool finishes FIRST, so a fold in
         * completion order would reverse the `tool` messages and make
         * `proposal` first-wins instead of last-wins.
         *
         * `tool_result` event order is the observable, since the messages are
         * internal — and the events are what the phone renders.
         */
        listTasks.mockImplementation(() => after(80, []));
        analyzeBlockRisk.mockImplementation(() => after(10, { blocks: [] }));

        const h = harness();
        const complete = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValueOnce({ toolCalls: [call('list_farm_tasks'), call('analyze_block_risk', '{"locationId":"loc-1"}')] })
            .mockResolvedValueOnce({ text: 'готово' });

        await runToolLoop({ ctx, send: h.send, complete } as never, []);

        const results = h
            .events()
            .filter((e) => e.type === 'tool_result')
            .map((e) => e.name);
        expect(results).toEqual(['list_farm_tasks', 'analyze_block_risk']);
    });

    it('every tool_call is named BEFORE any result arrives', async () => {
        // Better for the phone than it was: it can name both tools it is
        // reading at once rather than one at a time. Still never a result
        // before its own call.
        listTasks.mockResolvedValue([]);
        analyzeBlockRisk.mockResolvedValue({ blocks: [] });

        const h = harness();
        const complete = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValueOnce({ toolCalls: [call('list_farm_tasks'), call('analyze_block_risk', '{"locationId":"loc-1"}')] })
            .mockResolvedValueOnce({ text: 'готово' });

        await runToolLoop({ ctx, send: h.send, complete } as never, []);

        const types = h.types();
        const lastCall = types.lastIndexOf('tool_call');
        const firstResult = types.indexOf('tool_result');
        expect(lastCall).toBeGreaterThanOrEqual(0);
        expect(firstResult).toBeGreaterThan(lastCall);
    });

    it('the BUDGET still bounds a round that asks for more than is left', async () => {
        /*
         * The bound moved from "break mid-loop" to "decide the admitted set
         * before anything runs", so it needs its own assertion. A round asking
         * for more calls than remain must run only the remainder and halt —
         * the same outcome as before, reached differently.
         */
        listTasks.mockResolvedValue([]);
        analyzeBlockRisk.mockResolvedValue({ blocks: [] });

        const h = harness();
        const many = Array.from({ length: MAX_TOOL_CALLS + 2 }, (_, i) =>
            call(i % 2 === 0 ? 'list_farm_tasks' : 'analyze_block_risk',
                i % 2 === 0 ? '{}' : '{"locationId":"loc-1"}'),
        ).map((c, i) => ({ ...c, id: `c-${i}` }));
        const complete = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValueOnce({ toolCalls: many })
            .mockResolvedValueOnce({ text: 'частично' });

        const out = await runToolLoop({ ctx, send: h.send, complete } as never, []);

        expect(out.toolCallsMade).toBe(MAX_TOOL_CALLS);
        expect(out.halt).toBe('ASSISTANT_TOOL_BUDGET');
        // The final tool-less call still happened, so the halt has an answer
        // to be incomplete about — this suite's founding assertion.
        expect(out.text).toBe('частично');
    });

    it('the reported stages add up to the total', async () => {
        // The figure #2670 needed and `AiUsageEvent` never stored. Without
        // this the three numbers could drift from the clock and nobody would
        // know which to trust.
        listTasks.mockResolvedValue([]);
        const h = harness();
        const complete = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValueOnce({ toolCalls: [call('list_farm_tasks')] })
            .mockResolvedValueOnce({ text: 'готово' });

        const out = await runToolLoop({ ctx, send: h.send, complete } as never, []);

        expect(out.timing.providerCalls).toBe(2);
        expect(out.timing.totalMs).toBeGreaterThanOrEqual(
            out.timing.providerMs + out.timing.toolPhaseMs,
        );
    });
});

describe('the PICKING rounds use their own call, the answer does not (#2670 item 2)', () => {
    it('tool rounds go to the picker; the FINAL tool-less call goes to `complete`', async () => {
        /*
         * The split is the whole change. One answered question is two provider
         * calls with different jobs — pick a tool (~160 completion tokens) and
         * write the answer (~500) — and only the first moves to a cheaper
         * model.
         *
         * Asserted by which FUNCTION each call lands on, not by a model name:
         * the model is `routing.ts`'s business, and a test naming it would go
         * stale the next time the route table moves.
         */
        listTasks.mockResolvedValue([]);
        const h = harness();
        const picker = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValue({ toolCalls: [call('list_farm_tasks')] });
        const answerer = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValue({ text: 'готово' });

        const out = await runToolLoop(
            { ctx, send: h.send, complete: answerer, completeForToolSelection: picker } as never,
            [],
        );

        // The picker ran the rounds — until the budget stopped it, since this
        // double always asks for another tool.
        expect(picker).toHaveBeenCalled();
        // The answerer ran exactly once: the final tool-less call.
        expect(answerer).toHaveBeenCalledTimes(1);
        expect(answerer.mock.calls[0]?.[1]).toBeUndefined();
        expect(out.text).toBe('готово');
    });

    it('the picker is given the TOOL DEFINITIONS; the answerer is not', async () => {
        // The reason the split is safe: the answering call has no tools, so a
        // cheaper picker cannot change what the answer is allowed to do.
        listTasks.mockResolvedValue([]);
        const h = harness();
        const picker = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValueOnce({ toolCalls: [call('list_farm_tasks')] })
            .mockResolvedValue({ text: '' });
        const answerer = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValue({ text: 'готово' });

        await runToolLoop(
            { ctx, send: h.send, complete: answerer, completeForToolSelection: picker } as never,
            [],
        );

        expect(picker.mock.calls[0]?.[1]).toBeDefined();
    });

    it('OMITTING the picker falls back to `complete` — the pre-#2670 behaviour', async () => {
        /*
         * `completeForToolSelection` is optional so the change stays additive
         * for every caller that drives this loop with one function. The
         * fallback must be the slow-but-correct direction, never a silently
         * different model.
         */
        listTasks.mockResolvedValue([]);
        const h = harness();
        const only = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValueOnce({ toolCalls: [call('list_farm_tasks')] })
            .mockResolvedValueOnce({ text: 'готово' });

        const out = await runToolLoop({ ctx, send: h.send, complete: only } as never, []);

        expect(only).toHaveBeenCalledTimes(2);
        expect(out.text).toBe('готово');
    });

    it('`toolSelectMs` is reported separately, so the lever has a figure that moves', async () => {
        /*
         * #2670's item 3 exists so item 2 can be judged. Without the split,
         * moving the picking round to a cheaper model would change
         * `providerMs` and nobody could say which half moved.
         *
         * `providerMs` still totals every call, so the two reconcile:
         * `providerMs - toolSelectMs` is the answer call.
         */
        listTasks.mockResolvedValue([]);
        const h = harness();
        const picker = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValueOnce({ toolCalls: [call('list_farm_tasks')] })
            .mockResolvedValue({ text: '' });
        const answerer = jest
            .fn<Promise<{ text?: string; toolCalls?: unknown[] }>, unknown[]>()
            .mockResolvedValue({ text: 'готово' });

        const out = await runToolLoop(
            { ctx, send: h.send, complete: answerer, completeForToolSelection: picker } as never,
            [],
        );

        expect(out.timing.toolSelectMs).toBeGreaterThanOrEqual(0);
        expect(out.timing.providerMs).toBeGreaterThanOrEqual(out.timing.toolSelectMs);
    });
});

describe('a PICKER must never write the answer (#2751)', () => {
    it('THE DEFECT, pinned: a picking round that returns prose answers the turn', async () => {
        /*
         * This test documents the trap rather than a fix, and it is why the
         * route no longer passes `completeForToolSelection`.
         *
         * The final tool-less `complete` call is guarded by
         * `if (text === null)`, which runs only when the tool phase was cut
         * short. On the NORMAL path a picking round returns no tool calls and
         * its prose becomes the answer — so pointing the pickers at a cheaper
         * model moved the farmer's answer onto it, which #2745's body said it
         * had not.
         *
         * Asserted as the CURRENT behaviour, so #2751's eventual fix has a
         * line to flip rather than a surprise to find. When the loop is fixed
         * so a picker can only pick, this expectation inverts.
         */
        listTasks.mockResolvedValue([]);
        const h = harness();
        const seen: string[] = [];
        const picker = jest.fn(async () => {
            seen.push('picker');
            return seen.filter((w) => w === 'picker').length === 1
                ? { toolCalls: [call('list_farm_tasks')] }
                : { text: 'BY THE PICKER' };
        });
        const answerer = jest.fn(async () => {
            seen.push('answerer');
            return { text: 'BY THE ANSWERER' };
        });

        const out = await runToolLoop(
            { ctx, send: h.send, complete: answerer, completeForToolSelection: picker } as never,
            [],
        );

        expect(seen).toEqual(['picker', 'picker']);
        expect(out.text).toBe('BY THE PICKER');
        expect(answerer).not.toHaveBeenCalled();
    });

    it('and why the two budget tests did not catch it', async () => {
        /*
         * The reason #2745 shipped with a false premise. Its mutation proof
         * moved two PRE-EXISTING tests, and I read that as the premise being
         * independently held — but both are CUT-SHORT tests, and the answerer
         * runs only on that path. They confirmed the claim on the one branch
         * where it is true.
         *
         * Here the picker never stops asking, so the budget ends the phase and
         * the answerer DOES write the answer. Same doubles, opposite outcome,
         * from the control flow alone.
         */
        listTasks.mockResolvedValue([]);
        const h = harness();
        const picker = jest.fn(async () => ({ toolCalls: [call('list_farm_tasks')] }));
        const answerer = jest.fn(async () => ({ text: 'BY THE ANSWERER' }));

        const out = await runToolLoop(
            { ctx, send: h.send, complete: answerer, completeForToolSelection: picker } as never,
            [],
        );

        expect(out.halt).toBe('ASSISTANT_TOOL_BUDGET');
        expect(out.text).toBe('BY THE ANSWERER');
        expect(answerer).toHaveBeenCalledTimes(1);
    });
});
