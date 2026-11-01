/**
 * The assistant's tools — #2578.
 *
 * Arguments come from the MODEL, so the assertions that matter are the
 * refusals: a hallucinated tool, malformed JSON, an argument the schema does
 * not admit, and a policy refusal from the usecase. None of them may throw,
 * because a throw ends a stream that has already sent a 200 and the model
 * cannot learn from a dead socket.
 */
/**
 * Double return types are DERIVED from the real usecase, never hand-written.
 *
 * This file used to declare `listLogEntriesPaginated` as
 * `jest.fn<Promise<{ rows: unknown[] }>, …>()`. The usecase returns
 * `{ items, pageInfo }` — every repository `listPaginated` here does, and four
 * integration tests already read `.items` from this one. So the double and the
 * tool shared a false belief about a dependency neither owns, the tool read
 * `.rows`, `?? []` turned the miss into an EMPTY JOURNAL for every farm, and
 * this suite was green throughout.
 *
 * The comment that used to sit on `listCostEntries` had already learned the
 * lesson — "a double whose shape is wrong verifies the wiring and nothing
 * about the dependency" — and fixed THAT double by hand while the one two
 * lines above stayed wrong. A comment explaining why something is load-bearing
 * is evidence the author knew, which makes every unfixed neighbour a
 * deliberate-looking accident.
 *
 * `ReturnType<typeof import(…).fn>` makes tsc the enforcer: a double that
 * resolves the wrong shape is now a compile error rather than a green test,
 * and it cannot drift when a usecase is reshaped.
 */
type Ret<T extends (...a: never[]) => unknown> = ReturnType<T>;

// Deliberately NOT derived. `listTasks` returns a BARE ARRAY, and the bug
// class this derivation exists for is a misnamed WRAPPER field — which a bare
// array cannot have. Deriving it would force every double to carry a dozen
// required WorkItem fields for tests whose subject is a refusal, which buys
// noise rather than a guarantee. The line is: derive the shape where a wrapper
// can be got wrong, stay loose where there is no wrapper.
const listTasks = jest.fn<Promise<unknown[]>, unknown[]>();
const listLogEntriesPaginated = jest.fn<
    Ret<typeof import('@/app-layer/usecases/journal').listLogEntriesPaginated>,
    unknown[]
>();
const listCostEntries = jest.fn<
    Ret<typeof import('@/app-layer/usecases/cost-entry').listCostEntries>,
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
// `{ items, pageInfo: { nextCursor, hasNextPage } }` — the usecase's REAL
// shape, and a FOURTH distinct pagination shape in this codebase. A double
// returning `{ rows }` would agree with the tool and tell us nothing about the
// dependency, which is what `listCostEntries` already cost.
const listLocationsPaginated = jest.fn<
    Promise<{ items: unknown[]; pageInfo: { nextCursor: string | null; hasNextPage: boolean } }>,
    unknown[]
>();
jest.mock('@/app-layer/usecases/location', () => ({
    listLocationsPaginated: (...a: unknown[]) => listLocationsPaginated(...a),
}));
const analyzeBlockRisk = jest.fn<Promise<Record<string, unknown>>, unknown[]>();
jest.mock('@/app-layer/usecases/parcel-risk', () => ({
    analyzeBlockRisk: (...a: unknown[]) => analyzeBlockRisk(...a),
}));
const getPriceTrends = jest.fn<Promise<Record<string, unknown>>, unknown[]>();
jest.mock('@/app-layer/usecases/trends', () => ({
    getPriceTrends: (...a: unknown[]) => getPriceTrends(...a),
}));
const getGrainNetWorth = jest.fn<Promise<Record<string, unknown>>, unknown[]>();
jest.mock('@/app-layer/usecases/grain-net-worth', () => ({
    getGrainNetWorth: (...a: unknown[]) => getGrainNetWorth(...a),
}));
// `buildCalculatorPayload` is deliberately NOT mocked: it is the projection the
// ROUTE serves, and a double would verify the tool calls something while
// saying nothing about the shape it produces.
const assertNotPastDueRestricted = jest.fn<Promise<void>, unknown[]>();
jest.mock('@/lib/billing/entitlements', () => ({
    assertNotPastDueRestricted: (...a: unknown[]) => assertNotPastDueRestricted(...a),
}));

import { makeRequestContext } from '../../helpers/make-context';
import {
    ASSISTANT_TOOLS,
    runTool,
    toolDefs,
    TOOL_RESULT_MAX_CHARS,
} from '@/app-layer/ai/assistant/tools';

/**
 * A REAL context, not a hand-rolled stub — changed when `runTool` began
 * asserting the read policy centrally.
 *
 * The stub was `{ userId, tenantId, role, permissions: {}, appPermissions: {} }
 * as never`, and `assertCanRead` reads `ctx.permissions.canRead`. So every
 * tool test was passing a context that CANNOT read, and passing only because
 * each usecase was mocked and its own assert never ran. The central assert
 * reddened seven of them immediately, which is the assert being real rather
 * than a problem with it.
 */
const ctx = makeRequestContext('EDITOR', { userId: 'u1', tenantId: 't1' });

describe('assistant tools (#2578)', () => {
    /** A GrainNetWorthResult as `buildCalculatorPayload` really consumes it. */
    const grainResult = (over: Record<string, unknown> = {}) => ({
        generatedAt: '2026-11-01T06:00:00.000Z',
        seasonId: 's-2026',
        rows: [
            {
                commodity: 'wheat',
                pricePerTonne: 210,
                priceCurrency: 'EUR',
                priceObservedAt: '2026-08-04',
                priceSource: 'SAPI',
                standingCropAreaHa: 120,
                grainOnHandTonnes: 480,
                grainOnHandValue: 100_800,
                standingCropValue: 50_000,
                cashCostTotal: 61_000,
                breakEven: 127,
                netWorth: 89_800,
                netWorthUnavailableCode: null,
                // `buildCalculatorPayload` does
                // `row.cashCostCurrencies.filter(...)`, so this array is
                // REQUIRED. Omitting it threw "Cannot read properties of
                // undefined (reading 'filter')" — the real projection telling
                // me my double's shape was wrong, which is exactly what a
                // double that is NOT mocked is for.
                cashCostCurrencies: ['EUR'],
            },
        ],
        farm: { totals: [{ currency: 'EUR', netWorth: 89_800 }], perArea: {} },
        exclusions: { commoditiesWithNoPrice: [{ id: 'maize' }], lotsUnresolvedUnit: [] },
        unvalued: { noUnitCost: 0, unitMismatch: 0 },
        cashOut: 0,
        unallocatedToCrop: 0,
        imputedLandCharge: 0,
        truncated: false,
        ...over,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        listTasks.mockResolvedValue([]);
        listLogEntriesPaginated.mockResolvedValue({ items: [], pageInfo: { hasNextPage: false } });
        listCostEntries.mockResolvedValue({ rows: [], totalCount: 0, truncated: false });
        listActiveListings.mockResolvedValue({ rows: [], nextCursor: null });
        assertModuleEnabled.mockResolvedValue(undefined);
        assertNotPastDueRestricted.mockResolvedValue(undefined);
        getPriceTrends.mockResolvedValue({
            commodity: 'wheat',
            range: '3m',
            generatedAt: '2026-11-01T06:00:00.000Z',
            series: [],
        });
        getGrainNetWorth.mockResolvedValue(grainResult());
        listLocationsPaginated.mockResolvedValue({
            items: [],
            pageInfo: { nextCursor: null, hasNextPage: false },
        });
        analyzeBlockRisk.mockResolvedValue({
            locationName: 'Голямо поле',
            analysed: 0,
            total: 0,
            worst: 'unknown',
            counts: { unknown: 0, good: 0, watch: 0, stress: 0 },
            configured: true,
            parcels: [],
            generatedAt: '2026-11-01T00:00:00.000Z',
        });
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
            Array.from({ length: 20 }, (_, i) => ({
                id: `t${i}`,
                title: 'a'.repeat(900),
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
        // 21: the tool over-reads by one to learn whether a 21st task exists,
        // because `listTasks` returns a bare array with no count (#2647). The
        // extra row is discarded.
        expect(options).toEqual({ take: 21 });
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
            pageInfo: { hasNextPage: false },
            items: [
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
        propose_treatment: 'JOURNAL',
        propose_activity: 'JOURNAL',
    };

    it.each(Object.entries(TOOL_MODULE))(
        '%s asserts the %s module BEFORE reading anything (#2629)',
        async (tool, moduleKey) => {
            const args =
                tool.startsWith('propose_')
                    ? JSON.stringify({ kind: tool === 'propose_treatment' ? 'SPRAY' : 'PRUNE' })
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

    it.each(['list_blocks', 'analyze_block_risk'])(
        '%s asserts NO module — its route gates none, measured',
        async (tool) => {
            // `/locations/route.ts` and `/agro/parcels/[parcelId]/analysis/route.ts`
            // call no `assertModuleEnabled`. Inventing one would refuse a
            // surface the product leaves open — #2629's defect inverted.
            const args = tool === 'analyze_block_risk' ? '{"locationId":"loc-1"}' : '{}';
            await runTool(ctx, tool, args);
            expect(assertModuleEnabled).not.toHaveBeenCalled();
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

    it('list_blocks reads .items, is bounded, and withholds the owner', async () => {
        listLocationsPaginated.mockResolvedValue({
            items: [
                {
                    id: 'loc-1',
                    name: 'Голямо поле',
                    key: 'GP',
                    kind: 'FIELD',
                    status: 'ACTIVE',
                    _count: { parcels: 7 },
                    owner: { id: 'u-9', name: 'Иван Петров' },
                    boundsJson: { type: 'Polygon' },
                },
            ],
            pageInfo: { nextCursor: null, hasNextPage: false },
        });
        const res = await runTool(ctx, 'list_blocks', '{}');
        expect(res.ok).toBe(true);
        const [, params] = listLocationsPaginated.mock.calls[0] as [unknown, Record<string, unknown>];
        expect(params).toMatchObject({ limit: 20 });
        // Read off `.items`. A tool reading `.rows` here gets undefined and
        // the test would fail on the projection rather than silently pass.
        expect(res.content).toContain('Голямо поле');
        expect(res.content).toContain('"parcelCount":7');
        // The owner is a person's NAME, and an answer about land has no use
        // for it. Geometry likewise.
        expect(res.content).not.toContain('Иван Петров');
        expect(res.content).not.toContain('boundsJson');
        // And a link to the real block screen.
        expect(res.links).toEqual([{ route: '/locations/loc-1', label: 'Голямо поле' }]);
    });

    it('list_blocks refuses free text and an unknown kind', async () => {
        for (const bad of [{ q: 'поле' }, { kinds: ['PADDOCK'] }, { search: 'x' }]) {
            const out = await runTool(ctx, 'list_blocks', JSON.stringify(bad));
            expect({ bad: Object.keys(bad)[0], ok: out.ok }).toEqual({
                bad: Object.keys(bad)[0],
                ok: false,
            });
        }
        // Control: the real enum values are accepted.
        expect((await runTool(ctx, 'list_blocks', '{"kinds":["FIELD","BIN"]}')).ok).toBe(true);
    });

    it('analyze_block_risk reports analysed OUT OF total, and whether it is complete', async () => {
        // The property the batch usecase exists for. Without it a model
        // counting levels scores the un-analysed parcels as merely `unknown`
        // and answers "nothing stressed" about a farm it did not finish.
        analyzeBlockRisk.mockResolvedValue({
            locationName: 'Голямо поле',
            analysed: 24,
            total: 30,
            worst: 'stress',
            counts: { unknown: 0, good: 22, watch: 1, stress: 1 },
            configured: true,
            parcels: [
                { name: 'П-1', overall: 'stress', vegetation: 'stress', moisture: 'good', acquiredDate: '2026-10-28' },
                { name: 'П-2', overall: 'watch', vegetation: 'watch', moisture: 'good', acquiredDate: '2026-10-28' },
                { name: 'П-3', overall: 'good', vegetation: 'good', moisture: 'good', acquiredDate: '2026-10-28' },
            ],
            generatedAt: '2026-11-01T00:00:00.000Z',
        });
        const res = await runTool(ctx, 'analyze_block_risk', '{"locationId":"loc-1"}');
        expect(res.ok).toBe(true);
        expect(res.content).toContain('"analysed":24');
        expect(res.content).toContain('"total":30');
        expect(res.content).toContain('"complete":false');
        // Parcels needing attention are NAMED, and the fine one is not listed.
        expect(res.content).toContain('П-1');
        expect(res.content).toContain('П-2');
        expect(res.content).not.toContain('П-3');
    });

    it('analyze_block_risk takes a DERIVED id but refuses a malformed one', async () => {
        // The first tool that accepts a record id, and the distinction is
        // provenance: a `locationId` comes from a prior `list_blocks` result,
        // which the model READ rather than composed. The charset bound is the
        // same one `links.ts` applies, so junk is refused here rather than
        // reaching Prisma.
        expect((await runTool(ctx, 'analyze_block_risk', '{"locationId":"loc-1"}')).ok).toBe(true);
        for (const bad of ['', 'a'.repeat(65), "'; DROP TABLE", '../../etc/passwd']) {
            const out = await runTool(ctx, 'analyze_block_risk', JSON.stringify({ locationId: bad }));
            expect(out.ok).toBe(false);
        }
        // And the id is required — a block-risk question about no block is
        // not a question this tool can answer.
        expect((await runTool(ctx, 'analyze_block_risk', '{}')).ok).toBe(false);
    });

    it('EVERY tool asserts the read policy, even where the usecase cannot', async () => {
        // `assertCanRead` is called centrally by `runTool`. Most usecases
        // assert it too, but `getPriceTrends` takes no RequestContext and can
        // assert nothing — "the one tool whose usecase cannot must remember
        // to" is a rule with no enforcement.
        const denied = makeRequestContext('READER', {
            permissions: { canRead: false } as never,
        });
        for (const name of Object.keys(ASSISTANT_TOOLS)) {
            const args =
                name === 'analyze_block_risk'
                    ? '{"locationId":"loc-1"}'
                    : name === 'price_trends'
                      ? '{"commodity":"wheat"}'
                      : name.startsWith('propose_')
                        ? JSON.stringify({ kind: name === 'propose_treatment' ? 'SPRAY' : 'PRUNE' })
                        : '{}';
            const out = await runTool(denied, name, args);
            expect({ name, ok: out.ok }).toEqual({ name, ok: false });
        }
    });

    it('grain_calculator reports what the totals LEFT OUT, not just the totals', async () => {
        const res = await runTool(ctx, 'grain_calculator', '{}');
        expect(res.ok).toBe(true);
        expect(res.content).toContain('"complete":false');
        expect(res.content).toContain('"rowsLeftOut":1');
        expect(res.content).toContain('commoditiesWithNoPrice');
        // An EMPTY exclusion list is not reported as a reason.
        expect(res.content).not.toContain('lotsUnresolvedUnit');
        // Real field names, through the route's own projection. The first
        // version of this projection guessed `tonnes`/`value`/`cost` — none of
        // which exist on a calculator row.
        expect(res.content).toContain('"grainOnHandTonnes":480');
        expect(res.content).toContain('"netWorth":89800');
        // The price's age travels with the money it produced.
        expect(res.content).toContain('2026-08-04');
    });

    it('grain_calculator reports truncation SEPARATELY from exclusions', async () => {
        // Different causes: a bounded read hitting its cap is ours, a missing
        // price is ours too but a missing yield estimate is the farmer's.
        // Collapsing them would point them at the wrong thing.
        getGrainNetWorth.mockResolvedValue(
            grainResult({ truncated: true, exclusions: { lotsUnresolvedUnit: [] } }),
        );
        const res = await runTool(ctx, 'grain_calculator', '{}');
        expect(res.content).toContain('"truncated":true');
        expect(res.content).toContain('"rowsLeftOut":0');
        expect(res.content).toContain('"complete":false');
    });

    it('price_trends gates on `trends` — the usecase cannot', async () => {
        await runTool(ctx, 'price_trends', '{"commodity":"wheat"}');
        expect(assertNotPastDueRestricted).toHaveBeenCalledWith(ctx, 'trends');
        assertNotPastDueRestricted.mockRejectedValue(new Error('PAST_DUE_RESTRICTED'));
        await expect(
            runTool(ctx, 'price_trends', '{"commodity":"wheat"}'),
        ).resolves.toMatchObject({ ok: false });
    });

    it('price_trends ages each series against generatedAt, not the wall clock', async () => {
        // The payload is Redis-cached for 6h and this process's clock is not
        // the observation's. The openapi description is explicit that a dead
        // series' last point "looks equally current" as a live one's.
        getPriceTrends.mockResolvedValue({
            commodity: 'wheat',
            range: '3m',
            // `generatedAt` is deliberately WEEKS OLD, and that is what gives
            // this test its teeth. The first fixture used today's date, so
            // `generatedAt` and `Date.now()` agreed and a mutation computing
            // staleness from the wall clock PASSED — a fixture with no
            // discriminating power. A payload this old is also the realistic
            // case: it is Redis-cached and shared across tenants.
            generatedAt: '2026-09-01T00:00:00.000Z',
            series: [
                {
                    source: 'SAPI', region: 'BG', stage: 'DELIVERED', unit: 't',
                    currency: 'EUR', label: null, lastObservedAt: '2026-08-30',
                    points: [{ date: '2026-08-30', price: 212 }],
                },
                {
                    source: 'OLD', region: 'BG', unit: 'kg', currency: 'BGN',
                    label: null, lastObservedAt: '2026-06-01',
                    points: [{ date: '2026-06-01', price: 0.41 }],
                },
            ],
        });
        const res = await runTool(ctx, 'price_trends', '{"commodity":"wheat"}');
        expect(res.ok).toBe(true);
        expect(res.content).toContain('"staleDays":2');
        expect(res.content).toContain('"staleDays":92');
        // Unit and currency travel WITH each price: these two are not
        // comparable, and a bare number invites an average.
        expect(res.content).toContain('"unit":"kg"');
        expect(res.content).toContain('"currency":"BGN"');
        expect(res.content).toContain('"stage":"DELIVERED"');
    });

    it('price_trends refuses a commodity the usecase does not chart', async () => {
        expect((await runTool(ctx, 'price_trends', '{"commodity":"wheat"}')).ok).toBe(true);
        for (const bad of ['WHEAT', 'rapeseed', '']) {
            const out = await runTool(ctx, 'price_trends', JSON.stringify({ commodity: bad }));
            expect({ bad, ok: out.ok }).toEqual({ bad, ok: false });
        }
    });

    it('list_farm_tasks OVER-READS by one and discards the probe row (#2647)', async () => {
        // `listTasks` returns a bare array with no count and no cursor, so the
        // only way to learn whether a 21st task exists is to ask for 21.
        listTasks.mockResolvedValue(
            Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, status: 'OPEN' })),
        );
        const res = await runTool(ctx, 'list_farm_tasks', '{}');
        expect(res.ok).toBe(true);
        const [, , options] = listTasks.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
        expect(options).toEqual({ take: 21 });
        const body = JSON.parse(res.content) as { rows: unknown[]; hasMore: boolean };
        // Twenty returned, the 21st DISCARDED — it is a probe, not data.
        expect({ rows: body.rows.length, hasMore: body.hasMore }).toEqual({
            rows: 20,
            hasMore: true,
        });
        expect(res.content).not.toContain('"T20"');
        expect(res.partial).toBe(true);
    });

    it('a FULL page that is not partial says so — the control', async () => {
        // Without this, `hasMore` could be "the page is full", which would
        // tell a farm with exactly 20 tasks its answer was incomplete every
        // time. A claim the data does not support, firing constantly on small
        // farms.
        listTasks.mockResolvedValue(
            Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, status: 'OPEN' })),
        );
        const res = await runTool(ctx, 'list_farm_tasks', '{}');
        const body = JSON.parse(res.content) as { rows: unknown[]; hasMore: boolean };
        expect({ rows: body.rows.length, hasMore: body.hasMore }).toEqual({
            rows: 20,
            hasMore: false,
        });
        expect(res.partial).toBe(false);
    });

    it.each([
        // `items`, and NO `as never`. The cast is why this entry could carry
        // `rows` — a shape the usecase has never returned — while asserting
        // that the tool reported `hasMore` correctly from it.
        ['list_journal_entries', () => listLogEntriesPaginated.mockResolvedValue({
            items: [{ id: 'j1', title: 'Пръскане' }],
            pageInfo: { nextCursor: 'c', hasNextPage: true },
        })],
        ['list_cost_entries', () => listCostEntries.mockResolvedValue({
            rows: [{ id: 'c1', category: 'FUEL' }], totalCount: 99, truncated: false,
        } as never)],
        ['list_exchange_listings', () => listActiveListings.mockResolvedValue({
            rows: [], nextCursor: 'cur-1',
        } as never)],
        ['list_blocks', () => listLocationsPaginated.mockResolvedValue({
            items: [{ id: 'l1', name: 'Поле' }],
            pageInfo: { nextCursor: 'c', hasNextPage: true },
        } as never)],
    ])('%s reports hasMore from its OWN usecase signal (#2647)', async (tool, arrange) => {
        // Each usecase says "there is more" differently —
        // `pageInfo.hasNextPage`, `totalCount`, `nextCursor` — and the tool
        // reads whichever its own dependency provides rather than guessing
        // from the row count.
        arrange();
        const res = await runTool(ctx, tool, '{}');
        expect(res.ok).toBe(true);
        const body = JSON.parse(res.content) as { hasMore: boolean };
        expect({ tool, hasMore: body.hasMore, partial: res.partial }).toEqual({
            tool,
            hasMore: true,
            partial: true,
        });
    });

    it('LINKS survive the wrapper — the regression that blocked this once', async () => {
        // `runTool` hands the result straight to `linksFromRows`, which opened
        // with `if (!Array.isArray(rows)) return []` — SILENTLY. So wrapping a
        // list result to carry `hasMore` would have dropped the links on three
        // tools with no error, which is why the first attempt at #2647 was
        // abandoned. `linksFromRows` now unwraps `rows`/`items`.
        listLogEntriesPaginated.mockResolvedValue({
            items: [{ id: 'j1', title: 'Пръскане' }],
            pageInfo: { hasNextPage: false },
        });
        const journal = await runTool(ctx, 'list_journal_entries', '{}');
        expect(journal.links).toEqual([{ route: '/journal/j1', label: 'Пръскане' }]);

        listLocationsPaginated.mockResolvedValue({
            items: [{ id: 'l1', name: 'Голямо поле' }],
            pageInfo: { hasNextPage: false },
        } as never);
        const blocks = await runTool(ctx, 'list_blocks', '{}');
        expect(blocks.links).toEqual([{ route: '/locations/l1', label: 'Голямо поле' }]);
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
            Array.from({ length: 20 }, (_, i) => ({
                id: `t${i}`,
                title: 'a'.repeat(900),
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
