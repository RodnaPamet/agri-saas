/**
 * The assistant's tools — #2578.
 *
 * Arguments come from the MODEL, so the assertions that matter are the
 * refusals: a hallucinated tool, malformed JSON, an argument the schema does
 * not admit, and a policy refusal from the usecase. None of them may throw,
 * because a throw ends a stream that has already sent a 200 and the model
 * cannot learn from a dead socket.
 */
const listTasks = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('@/app-layer/usecases/task', () => ({
    listTasks: (...a: unknown[]) => listTasks(...a),
}));

import {
    ASSISTANT_TOOLS,
    runTool,
    toolDefs,
    TOOL_RESULT_MAX_CHARS,
} from '@/app-layer/ai/assistant/tools';

const ctx = {
    userId: 'u1',
    tenantId: 't1',
    role: 'EDITOR',
    permissions: {},
    appPermissions: {},
} as never;

describe('assistant tools (#2578)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        listTasks.mockResolvedValue([]);
    });

    it('the set is closed and every def matches its key', () => {
        const names = toolDefs().map((d) => d.name);
        console.log(`[assistant-tools] ${names.length} tool(s): ${names.join(', ')}`);
        expect(names.length).toBeGreaterThanOrEqual(1);
        for (const [key, tool] of Object.entries(ASSISTANT_TOOLS)) {
            // A def whose name differs from its key is a tool the model can
            // call and the dispatcher cannot find.
            expect(tool.def.name).toBe(key);
            expect(tool.def.parameters).toMatchObject({ additionalProperties: false });
        }
    });

    it('every declared link template names a REAL screen', async () => {
        // A tool whose template is not a screen produces links that 404 — and
        // the failure would land on a phone rather than in CI. Asserted here
        // rather than in the text-reading guard, because answering it needs
        // the generated template set loaded.
        const { linkTemplateIsReal } = await import('@/app-layer/ai/assistant/links');
        const declared = Object.values(ASSISTANT_TOOLS)
            .map((t) => t.link?.template)
            .filter((t): t is string => typeof t === 'string');
        console.log(`[assistant-tools] ${declared.length} link template(s): ${declared.join(', ')}`);
        // A control: if no tool declared one, the loop below would pass over
        // nothing. One tool does today.
        expect(declared.length).toBeGreaterThanOrEqual(1);
        for (const template of declared) {
            expect(linkTemplateIsReal(template)).toBe(true);
        }
    });

    it('returns links built from the ROWS, before truncation', async () => {
        listTasks.mockResolvedValue([
            { id: 'a1', title: 'Пръскане', status: 'OPEN' },
            { id: 'a2', title: 'Торене', status: 'OPEN' },
        ]);
        const out = await runTool(ctx, 'list_farm_tasks', '{}');
        expect(out.links).toEqual([
            { route: '/farm-tasks/a1', label: 'Пръскане' },
            { route: '/farm-tasks/a2', label: 'Торене' },
        ]);
    });

    it('a TRUNCATED result still carries its links', async () => {
        // Built from the rows rather than parsed back out of `content`, so
        // truncation cannot silently drop the links for records the model was
        // still shown.
        listTasks.mockResolvedValue(
            Array.from({ length: 400 }, (_, i) => ({
                id: `t${i}`,
                title: 'a'.repeat(40),
                status: 'OPEN',
            })),
        );
        const out = await runTool(ctx, 'list_farm_tasks', '{}');
        expect(out.truncated).toBe(true);
        expect(out.links.length).toBeGreaterThan(0);
    });

    it('calls the USECASE, which is what enforces the policy', async () => {
        await runTool(ctx, 'list_farm_tasks', '{"due":"overdue"}');
        expect(listTasks).toHaveBeenCalledTimes(1);
        const [gotCtx, filters, options] = listTasks.mock.calls[0] as [unknown, unknown, unknown];
        expect(gotCtx).toBe(ctx);
        expect(filters).toEqual({ due: 'overdue' });
        // Bounded, so one tool call cannot pull the whole table into a prompt.
        expect(options).toEqual({ take: 20 });
    });

    it('refuses a hallucinated tool name without throwing', async () => {
        const out = await runTool(ctx, 'delete_everything', '{}');
        expect(out.ok).toBe(false);
        expect(out.content).toContain('No such tool');
        expect(listTasks).not.toHaveBeenCalled();
    });

    it('refuses malformed JSON arguments without throwing', async () => {
        const out = await runTool(ctx, 'list_farm_tasks', '{oops');
        expect(out).toMatchObject({ ok: false, truncated: false });
        expect(listTasks).not.toHaveBeenCalled();
    });

    it('refuses an argument the schema does not admit — including `q`', async () => {
        // `TaskFilters.q` is real and deliberately NOT exposed: it is the one
        // argument whose content cannot be bounded by a charset, and a list
        // question needs `due`, not prose.
        for (const raw of [
            '{"q":"пшеница"}',
            '{"assigneeUserId":["x"]}',
            '{"take":9999}',
            // `DONE` is NOT a WorkItemStatus — I invented it, and the schema
            // enum is now the source for both the validator and what the model
            // is told. A value that does not exist must be refused rather than
            // handed to Prisma.
            '{"status":["DONE"]}',
        ]) {
            const out = await runTool(ctx, 'list_farm_tasks', raw);
            expect(out.ok).toBe(false);
            expect(out.content).toContain('Arguments rejected');
        }
        expect(listTasks).not.toHaveBeenCalled();
    });

    it('a POLICY refusal from the usecase comes back as a failed tool, not a throw', async () => {
        // This is the per-tool enforcement the route's permission carve-out
        // depends on: a role the policy refuses gets refused here, by the same
        // code path an HTTP route would have used.
        listTasks.mockRejectedValue(new Error('Forbidden: cannot read tasks'));
        const out = await runTool(ctx, 'list_farm_tasks', '{}');
        expect(out.ok).toBe(false);
        expect(out.content).toContain('Forbidden');
    });

    it('omits the ENCRYPTED free-text columns from the projection', async () => {
        // `Task.description` and `Task.resolution` are in ENCRYPTED_FIELDS and
        // the extension decrypts them on read, so naming them would hand the
        // model the farm's longest sensitive free text for a list question.
        listTasks.mockResolvedValue([
            {
                id: 't1',
                title: 'Пръскане',
                status: 'OPEN',
                priority: 'HIGH',
                dueDate: '2026-11-05',
                description: 'SENSITIVE-DESCRIPTION',
                resolution: 'SENSITIVE-RESOLUTION',
            },
        ]);
        const out = await runTool(ctx, 'list_farm_tasks', '{}');
        expect(out.ok).toBe(true);
        expect(out.content).toContain('Пръскане');
        expect(out.content).not.toContain('SENSITIVE-DESCRIPTION');
        expect(out.content).not.toContain('SENSITIVE-RESOLUTION');
    });

    it('TRUNCATES a large result and says so, rather than dropping it', async () => {
        listTasks.mockResolvedValue(
            Array.from({ length: 400 }, (_, i) => ({
                id: `t${i}`,
                title: 'a'.repeat(40),
                status: 'OPEN',
                priority: 'LOW',
                dueDate: '2026-11-05',
            })),
        );
        const out = await runTool(ctx, 'list_farm_tasks', '{}');
        expect(out).toMatchObject({ ok: true, truncated: true });
        expect(out.content.length).toBe(TOOL_RESULT_MAX_CHARS);
        // The flag is what makes the answer's incompleteness reportable as
        // ASSISTANT_TRUNCATED_RESULT instead of silent.
    });
});
