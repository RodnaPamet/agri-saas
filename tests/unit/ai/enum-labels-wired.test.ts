/**
 * The assistant stops echoing raw enum codes at farmers (#2691).
 *
 * The owner was shown «Дейност (ACTIVITY)» and «статус DONE». It was never a
 * translation gap: 33 members across 5 enums were complete in BOTH locales
 * before anything changed, and the web surface rendered them correctly. It was
 * a RESOLUTION gap — the serialisers emitted the enum VALUE and nothing in the
 * assistant path looked it up.
 *
 * So these tests are about the serialiser OUTPUT, which is the only place the
 * fix can be observed: a label in the row means the model never sees the code,
 * and a code it cannot see is a code it cannot echo.
 */
const mockEnumLabel = jest.fn();
jest.mock('@/lib/assistant/enum-labels', () => ({
    enumLabel: (...a: unknown[]) => mockEnumLabel(...a),
}));

const mockResolveLocale = jest.fn(() => 'bg');
jest.mock('@/lib/i18n/request-locale', () => ({
    resolveRequestLocale: () => mockResolveLocale(),
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOOLS = readFileSync(
    resolve(__dirname, '../../../src/app-layer/ai/assistant/tools.ts'),
    'utf8',
);

describe('every code-bearing field is resolved, not passed through', () => {
    it.each([
        ['taskStatus', 'status'],
        ['logType', 'type'],
        ['logStatus', 'status'],
        ['costCategory', 'category'],
    ])('%s is resolved into the row', (kind) => {
        expect(TOOLS).toContain(`enumLabel('${kind}'`);
    });

    it('no serialiser passes a raw status/type/category straight through', () => {
        /*
         * The regression this is really about. `status: r.status` is what the
         * owner saw, and it is one deleted `await enumLabel(...)` away at all
         * times.
         *
         * Matched on the ROW-BUILDING form specifically — `r.<field>` inside a
         * mapped object literal — rather than on the identifier anywhere,
         * because `r.status` legitimately appears as the ARGUMENT to
         * `enumLabel` on the very next line.
         */
        const raw = [...TOOLS.matchAll(/^\s*(status|type|category):\s*r\.\w+,\s*$/gm)].map(
            (m) => m[0].trim(),
        );
        expect(raw).toEqual([]);
    });

    it('each resolution is AWAITED — a dropped await reaches the model per row', () => {
        // `enumLabel` is async because `translateFor` loads a catalogue
        // bundle. An unawaited call stringifies as `[object Promise]` in every
        // row of a list the model then quotes back — strictly worse than the
        // raw code, which at least degrades to something recoverable.
        const calls = [...TOOLS.matchAll(/enumLabel\('(\w+)'/g)];
        expect(calls.length).toBeGreaterThanOrEqual(4);
        for (const m of calls) {
            const at = m.index ?? 0;
            const before = TOOLS.slice(Math.max(0, at - 10), at);
            expect(before).toMatch(/await\s$/);
        }
    });

    it('the row shapes are TYPED, which is what makes a dropped await a tsc error', () => {
        /*
         * Measured by agrent backend-1: against a typed target tsc reports
         * `Type 'Promise<string | null>' is not assignable to type 'string'`;
         * through `(rows as Array<Record<string, unknown>>)` with an untyped
         * object literal it reports NOTHING, because the literal declares no
         * target for the Promise to be wrong against.
         *
         * So the declared return type on each map callback is the enforcement,
         * and this pins it. Without it the suite above is a text rule that a
         * refactor walks past.
         */
        for (const shape of ['TaskRow', 'JournalRow', 'CostRow', 'LunarDayRow']) {
            expect(TOOLS).toContain(`interface ${shape} {`);
            expect(TOOLS).toContain(`Promise<${shape}>`);
        }
    });

    it('the locale is resolved ONCE per call, not per row', () => {
        /*
         * Per row would be a catalogue load for every row, and the locale
         * cannot change inside one tool run.
         *
         * DERIVED, not counted. This read `toHaveLength(3)` until #3098 added a
         * fourth resolver, and a hardcoded total fails on a tool that does the
         * right thing — the same brittleness as a ledger test pinned to the
         * ledger's contents. What the property actually says is ONE resolve per
         * tool that needs one, so the expectation is the number of TOOLS whose
         * `run` contains a resolve: a tool resolving twice, or once per row,
         * makes occurrences exceed tools and fails.
         */
        const NEEDLE = 'const locale = resolveRequestLocale();';
        // Tool entries are the 4-space-indented keys of the registry literal.
        const blocks = TOOLS.split(/\n    (?=[a-z_]+: \{\n)/);
        const toolsThatResolve = blocks.filter((b) => b.includes(NEEDLE));
        const occurrences = [...TOOLS.matchAll(new RegExp(NEEDLE.replace(/[().]/g, '\\$&'), 'g'))];
        // Control: the split must actually have found tools, or both sides are
        // zero and this passes over nothing — the empty-population defect.
        expect(blocks.length).toBeGreaterThan(5);
        expect(toolsThatResolve.length).toBeGreaterThan(0);
        expect(occurrences).toHaveLength(toolsThatResolve.length);

        /*
         * And not inside a row callback. The old form matched `async (r)` only,
         * which was a real gap: #3098's maps bind `(d)` and `(g)`, so a per-row
         * resolve there would have been invisible to it while the hardcoded
         * count above happened to catch it for the wrong reason. Any
         * single-short-name arrow parameter now, which is what a row callback
         * looks like throughout this file.
         */
        expect(TOOLS).not.toMatch(/async \([a-z]{1,2}\)[^}]*resolveRequestLocale\(\)/);
    });
});
