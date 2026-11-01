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
const listLogEntriesPaginated = jest.fn<Promise<{ rows: unknown[] }>, unknown[]>();
// `{ rows, totalCount, truncated }` — the usecase's REAL shape. The first
// version of this double returned a bare array, so the tool read `.map` on an
// object and the test passed anyway. A double whose shape is wrong verifies
// the wiring and nothing about the dependency.
const listCostEntries = jest.fn<
    Promise<{ rows: unknown[]; totalCount: number; truncated: boolean }>,
    unknown[]
>();
jest.mock('@/app-layer/usecases/task', () => ({
    listTasks: (...a: unknown[]) => listTasks(...a),
}));
jest.mock('@/app-layer/usecases/journal', () => ({
    listLogEntriesPaginated: (...a: unknown[]) => listLogEntriesPaginated(...a),
}));
jest.mock('@/app-layer/usecases/cost-entry', () => ({
    listCostEntries: (...a: unknown[]) => listCostEntries(...a),
}));
// `{ rows, nextCursor }` — the browse usecase's REAL shape.
//
// `toPublicListing` is deliberately NOT mocked. It is the one place that
// applies the seller's own disclosure choice, so a double would verify that
// the tool calls something and nothing about the rule it exists to enforce.
const listActiveListings = jest.fn<
    Promise<{ rows: unknown[]; nextCursor: string | null }>,
    unknown[]
>();
jest.mock('@/app-layer/usecases/exchange', () => ({
    listActiveListings: (...a: unknown[]) => listActiveListings(...a),
}));
// #2629 — the module gate. Every surface these tools read is gated in its
// ROUTE, not its usecase, so a tool calling the usecase directly bypassed it.
const assertModuleEnabled = jest.fn<Promise<void>, unknown[]>();
jest.mock('@/app-layer/usecases/modules', () => ({
    assertModuleEnabled: (...a: unknown[]) => assertModuleEnabled(...a),
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
        listLogEntriesPaginated.mockResolvedValue({ rows: [] });
        listCostEntries.mockResolvedValue({ rows: [], totalCount: 0, truncated: false });
        listActiveListings.mockResolvedValue({ rows: [], nextCursor: null });
        assertModuleEnabled.mockResolvedValue(undefined);
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

    it('every tool args schema REJECTS an unknown key — behaviourally', async () => {
        // The property the guard used to approximate by counting `.strict()`
        // in one file, which broke when a schema moved to its own module.
        // Handing each schema a bad key is the actual question.
        for (const [name, tool] of Object.entries(ASSISTANT_TOOLS)) {
            const r = tool.args.safeParse({ __not_a_real_arg__: 1 });
            expect({ name, accepted: r.success }).toEqual({ name, accepted: false });
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

    it('the ДНЕВНИК tool is BOUNDED and does not widen the register', async () => {
        await runTool(ctx, 'list_journal_entries', '{"status":["DONE"]}');
        expect(listLogEntriesPaginated).toHaveBeenCalledTimes(1);
        const [gotCtx, params] = listLogEntriesPaginated.mock.calls[0] as [
            unknown,
            { limit?: number; filters?: Record<string, unknown> },
        ];
        expect(gotCtx).toBe(ctx);
        // Bounded, so one call cannot pull the register into a prompt.
        expect(params.limit).toBe(20);
        expect(params.filters).toEqual({ status: ['DONE'] });
        // The owner ruling: «journal should be entered manually only». The
        // usecase defaults to manual-only, so the tool must not pass this at
        // all — passing it even as `false` would mean a caller deciding
        // something the ruling already decided.
        expect(params.filters).not.toHaveProperty('includeTaskWritten');
    });

    it('the ДНЕВНИК tool refuses free text and record ids', async () => {
        for (const raw of [
            '{"q":"пшеница"}',
            '{"locationId":"loc1"}',
            '{"cropPlanId":"cp1"}',
            '{"includeTaskWritten":true}',
        ]) {
            const out = await runTool(ctx, 'list_journal_entries', raw);
            expect({ raw, ok: out.ok }).toEqual({ raw, ok: false });
        }
        expect(listLogEntriesPaginated).not.toHaveBeenCalled();
    });

    it('the ДНЕВНИК projection omits the long notes, and links to the entry', async () => {
        listLogEntriesPaginated.mockResolvedValue({
            rows: [
                {
                    id: 'j1',
                    title: 'Пръскане',
                    type: 'INPUT_APPLICATION',
                    status: 'DONE',
                    occurredAt: '2026-10-01',
                    notes: 'SENSITIVE-NOTES',
                },
            ],
        });
        const out = await runTool(ctx, 'list_journal_entries', '{}');
        expect(out.content).toContain('Пръскане');
        expect(out.content).not.toContain('SENSITIVE-NOTES');
        expect(out.links).toEqual([{ route: '/journal/j1', label: 'Пръскане' }]);
    });

    it('the expense tool is bounded, refuses ids, and PARSES its dates', async () => {
        await runTool(ctx, 'list_cost_entries', '{"incurredFrom":"2026-01-01"}');
        const [, filters, opts] = listCostEntries.mock.calls[0] as [
            unknown,
            Record<string, unknown>,
            { take?: number },
        ];
        expect(opts).toEqual({ take: 20 });
        // A Date, not the string — the usecase takes `Date`, and handing it a
        // string reaches Prisma as `Invalid Date` far from its cause.
        expect(filters.incurredFrom).toBeInstanceOf(Date);

        jest.clearAllMocks();
        // A value that is not a date is refused HERE rather than passed on.
        const bad = await runTool(ctx, 'list_cost_entries', '{"incurredFrom":"not-a-date"}');
        expect(bad.ok).toBe(false);
        expect(listCostEntries).not.toHaveBeenCalled();

        jest.clearAllMocks();
        for (const raw of ['{"q":"x"}', '{"parcelIds":["p1"]}', '{"itemIds":["i1"]}']) {
            expect((await runTool(ctx, 'list_cost_entries', raw)).ok).toBe(false);
        }
        expect(listCostEntries).not.toHaveBeenCalled();
    });

    /** A Борса row as the usecase really hands it over, decimals included. */
    const listingRow = (over: Record<string, unknown> = {}) => ({
        id: 'l1',
        sellerTenantId: 'other-tenant',
        side: 'SELL',
        kind: 'CULTURE',
        commodity: 'wheat',
        quantityTonnes: 25,
        pricePerTonne: 210,
        priceCurrency: 'EUR',
        regionCode: 'PDV',
        regionName: 'Пловдив',
        lat: 42.1,
        lon: 24.7,
        description: 'Хлебна пшеница, реколта 2026',
        sellerDisplayName: 'Иван Петров',
        sellerContact: '+359 888 123456',
        status: 'ACTIVE',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        expiresAt: null,
        ...over,
    });

    it('the Борса tool is BOUNDED and refuses free text and the seller-hiding control', async () => {
        await runTool(ctx, 'list_exchange_listings', '{}');
        const [, filters, page] = listActiveListings.mock.calls[0] as [
            unknown,
            Record<string, unknown>,
            Record<string, unknown>,
        ];
        expect(page).toEqual({ limit: 20 });
        // `excludeSellerTenantIds` is a privacy control shaped like a filter:
        // the usecase computes it from the tenants that switched the exchange
        // OFF, so a caller-supplied value would let a model unhide them.
        for (const key of [
            'search',
            'searchRegionCodes',
            'searchCommodities',
            'excludeSellerTenantIds',
        ]) {
            expect(filters).not.toHaveProperty(key);
            const refused = await runTool(
                ctx,
                'list_exchange_listings',
                JSON.stringify({ [key]: key === 'excludeSellerTenantIds' ? ['t2'] : 'x' }),
            );
            expect(refused.ok).toBe(false);
        }
    });

    it('does NOT name a farm that chose not to publish — the real projection decides', async () => {
        // The usecase resolves a farm brand for EVERY seller regardless of the
        // flag, so both halves are present here and only the flag differs.
        // This is the assertion a mocked `toPublicListing` could not make.
        const farm = { handle: 'zlatno-zarno', displayName: 'Златно зърно ЕООД' };

        listActiveListings.mockResolvedValue({
            rows: [listingRow({ publishAsFarm: false, farm })],
            nextCursor: null,
        });
        const hidden = await runTool(ctx, 'list_exchange_listings', '{}');
        expect(hidden.ok).toBe(true);
        expect(hidden.content).not.toContain('Златно зърно');
        expect(hidden.content).not.toContain('zlatno-zarno');
        expect(hidden.content).toContain('Иван Петров');

        // Control: with the flag SET the farm IS named, so the assertion above
        // is about the flag and not about a projection that drops farms.
        listActiveListings.mockResolvedValue({
            rows: [listingRow({ publishAsFarm: true, farm })],
            nextCursor: null,
        });
        const shown = await runTool(ctx, 'list_exchange_listings', '{}');
        expect(shown.content).toContain('Златно зърно');
    });

    it('withholds the seller contact and the precise coordinates', async () => {
        listActiveListings.mockResolvedValue({
            rows: [listingRow({ publishAsFarm: false, farm: null })],
            nextCursor: null,
        });
        const res = await runTool(ctx, 'list_exchange_listings', '{}');
        // `sellerContact` is a third party's phone number, and no egress scan
        // recognises one as sensitive — `ExchangeListingRow`'s own docblock
        // says a listing projection must never carry it.
        expect(res.content).not.toContain('888 123456');
        expect(res.content).not.toContain('sellerContact');
        // lat/lon are in the PUBLIC projection because the browse UI draws a
        // map. An answer in prose has no use for them.
        expect(res.content).not.toContain('42.1');
        expect(res.content).not.toContain('24.7');
        // Control: the row DID arrive and was projected.
        expect(res.content).toContain('wheat');
        expect(res.content).toContain('Пловдив');
    });

    it('takes its Борса enums from Prisma, not from a hand-written list', async () => {
        const ok = await runTool(
            ctx,
            'list_exchange_listings',
            JSON.stringify({ sides: ['SELL'], kinds: ['FERTILIZER'] }),
        );
        expect(ok.ok).toBe(true);
        // A plausible-looking value the database does not have. I once
        // hand-wrote five work-item statuses and three were wrong.
        const bad = await runTool(
            ctx,
            'list_exchange_listings',
            JSON.stringify({ kinds: ['CHEMICALS'] }),
        );
        expect(bad.ok).toBe(false);
    });

    /**
     * The module each tool's surface gates, READ off the route rather than
     * assumed. `/farm-tasks` gates none, which is why `list_farm_tasks` is
     * absent here and asserted separately below.
     */
    const TOOL_MODULE: Record<string, string> = {
        list_journal_entries: 'JOURNAL',
        list_cost_entries: 'GRAIN',
        list_exchange_listings: 'EXCHANGE',
        propose_journal_entry: 'JOURNAL',
    };

    it.each(Object.entries(TOOL_MODULE))(
        '%s asserts the %s module BEFORE reading anything (#2629)',
        async (tool, moduleKey) => {
            const args =
                tool === 'propose_journal_entry'
                    ? JSON.stringify({ type: 'OBSERVATION', title: 'x' })
                    : '{}';

            // Refuse the module, then require that the USECASE was never
            // reached. Asserting only that the gate was called would pass for
            // a gate placed AFTER the read, which reads the data and then
            // declines to return it — the rows have already left the database.
            assertModuleEnabled.mockRejectedValue(
                Object.assign(new Error('module is not available'), { code: 'MODULE_DISABLED' }),
            );
            const refused = await runTool(ctx, tool, args);
            expect(refused.ok).toBe(false);
            expect(refused.content).toContain('module');
            expect(listLogEntriesPaginated).not.toHaveBeenCalled();
            expect(listCostEntries).not.toHaveBeenCalled();
            expect(listActiveListings).not.toHaveBeenCalled();

            // And it names THIS tool's module, not merely some module.
            expect(assertModuleEnabled).toHaveBeenCalledWith(ctx, moduleKey);
        },
    );

    it('list_farm_tasks asserts NO module, because its route gates none', async () => {
        // The negative half, and it is a MEASUREMENT rather than an omission:
        // `/api/t/[tenantSlug]/farm-tasks/route.ts` calls no
        // `assertModuleEnabled`. Inventing one here would refuse a surface the
        // product leaves open — the mirror defect of #2629 and just as silent.
        await runTool(ctx, 'list_farm_tasks', '{}');
        expect(assertModuleEnabled).not.toHaveBeenCalled();
        expect(listTasks).toHaveBeenCalled();
    });

    it('a MODULE_DISABLED refusal is a failed tool, never a throw', async () => {
        // Same contract as a policy refusal: the stream has already sent a 200,
        // so a throw kills a socket the model cannot learn from.
        assertModuleEnabled.mockRejectedValue(new Error('module GRAIN is not available'));
        await expect(runTool(ctx, 'list_cost_entries', '{}')).resolves.toMatchObject({
            ok: false,
        });
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
