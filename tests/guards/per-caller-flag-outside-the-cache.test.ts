/**
 * A per-caller flag must be computed OUTSIDE `cachedListRead` (#2395).
 *
 * `cachedListRead`'s key is
 * `prefix:entity:operation:tenantId:vN:filterHash` — the tenant, the filters and
 * a version counter. **No caller.** So anything caller-dependent inside the
 * cached payload is computed once and served to every other user of the same
 * tenant and filters for the TTL: a non-creator shown a delete that then 403s,
 * or a creator shown none and losing a row they are entitled to remove.
 *
 * ## Why this is a SOURCE guard and not a behavioural test
 *
 * Because a behavioural test cannot do it here, and I only found that out by
 * trying. `tests/integration/task-row-may-delete.test.ts` has a two-callers case
 * written for exactly this, and the mutation that puts the flag back inside the
 * loader SURVIVES it — `cachedListRead` opens with
 * `const redis = getRedis(); if (!redis) return opts.loader();`, and there is no
 * Redis in the test environment, so every test runs on the uncached path. The
 * test asserts the flag is derived per call; it cannot assert where from.
 *
 * So the property is pinned structurally, where it is checkable, and the
 * integration test says plainly what it does and does not cover.
 *
 * `[[a-probe-with-no-discriminating-power]]` is the shape: a test that returns
 * the same answer in both worlds is zero evidence, however reasonable it looks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..');

/** Decorators that depend on the CALLER and must stay outside the cache. */
const PER_CALLER_DECORATORS = ['withMayDelete'] as const;

/** Files that both cache a list and decorate it. */
const FILES = ['src/app-layer/usecases/task.ts'] as const;

/** The balanced argument span of a call opening at `start` (just past its paren). */
function callArgs(src: string, start: number): string {
    let depth = 1;
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return src.slice(start, i);
        }
    }
    return src.slice(start);
}

/**
 * The scan, over TEXT rather than over a path.
 *
 * Parameterised so the controls below can feed it the offending shape — which
 * the repository does not contain and must not. A guard that can only read the
 * real tree can only assert over what the tree happens to hold, so the day it
 * stops holding a counter-example the guard silently stops being a guard. Gut
 * `callArgs` to return `''` and a path-only version passes with no offenders:
 * the selector has no teeth until a control can express the failure.
 */
function offendersIn(src: string, label: string): { offenders: string[]; scanned: number } {
    const offenders: string[] = [];
    let scanned = 0;
    for (const m of src.matchAll(/cachedListRead\(/g)) {
        scanned++;
        const args = callArgs(src, m.index! + m[0].length);
        for (const dec of PER_CALLER_DECORATORS) {
            if (args.includes(`${dec}(`)) {
                const line = src.slice(0, m.index!).split('\n').length;
                offenders.push(`${label}:${line} — ${dec}() inside the cachedListRead at this line`);
            }
        }
    }
    return { offenders, scanned };
}

/** The shape this guard exists to refuse. Not present anywhere in `src`. */
const OFFENDING_FIXTURE = `
    const rows = await cachedListRead({
        ctx,
        entity: 'task',
        operation: 'list',
        params: filters,
        loader: () => load(ctx).then((r) => withMayDelete(ctx, r)),
    });
    return rows;
`;

/** The same call with the decorator correctly outside it. */
const CLEAN_FIXTURE = `
    const rows = await cachedListRead({
        ctx,
        entity: 'task',
        operation: 'list',
        params: filters,
        loader: () => load(ctx),
    });
    return withMayDelete(ctx, rows);
`;

describe('a per-caller flag is computed outside the list cache (#2395)', () => {
    it('CONTROL: the scan flags a decorator inside the cache call', () => {
        // Without this the guard is green forever: gutting `callArgs` makes the
        // real-file check find nothing and pass.
        const { offenders, scanned } = offendersIn(OFFENDING_FIXTURE, 'fixture');
        expect(scanned).toBe(1);
        expect(offenders).toHaveLength(1);
        expect(offenders[0]).toContain('withMayDelete() inside the cachedListRead');
    });

    it('CONTROL: and does not flag the same call with the decorator outside', () => {
        // The other half — a scan that flagged everything would also pass the
        // control above while refusing correct code.
        const { offenders, scanned } = offendersIn(CLEAN_FIXTURE, 'fixture');
        expect(scanned).toBe(1);
        expect(offenders).toEqual([]);
    });

    it.each(FILES)('%s calls no per-caller decorator inside cachedListRead', (rel) => {
        const src = readFileSync(join(REPO, rel), 'utf8');
        const { offenders, scanned } = offendersIn(src, rel);
        // The denominator. A file that stopped calling `cachedListRead` would
        // otherwise pass by having nothing to examine.
        console.log(`[cache-placement] ${rel}: ${scanned} cachedListRead call(s) examined`);
        expect(scanned).toBeGreaterThan(0);
        expect(offenders).toEqual([]);
    });

    it('the decorators it watches for still exist', () => {
        // A guard naming a function that has been renamed watches nothing and
        // says so to nobody. `[[a-needle-loses-the-thread-at-a-rename]]`.
        const src = FILES.map((f) => readFileSync(join(REPO, f), 'utf8')).join('\n');
        for (const dec of PER_CALLER_DECORATORS) {
            expect([dec, new RegExp(`function ${dec}\\b`).test(src)]).toEqual([dec, true]);
        }
    });

    it("cachedListRead's key still carries no caller — the premise", () => {
        // If the key ever gains a user, this guard is unnecessary and should be
        // deleted rather than left to imply a hazard that no longer exists.
        const src = readFileSync(join(REPO, 'src/lib/cache/list-cache.ts'), 'utf8');
        const keyLine = src
            .split('\n')
            .find((l) => l.includes('${CACHE_PREFIX}:${opts.entity}:${opts.operation}'));
        expect(keyLine).toBeDefined();
        expect(keyLine).not.toMatch(/userId|user\.id|ctx\.userId/);
    });
});
