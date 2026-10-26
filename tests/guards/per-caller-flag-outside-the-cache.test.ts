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
 *
 * ## Every read here is blanked first (#1774)
 *
 * This guard text-matches source, so it would otherwise count PROSE as the code
 * it polices, and all three of its reads had a live route to that:
 *
 *   - `task.ts:128` is a COMMENT reading "see `withMayDelete`", sitting a few
 *     lines after a `cachedListRead` call. It is outside that call's argument
 *     span today and so matched nothing — but the span is whatever the braces
 *     happen to be, and an example written INSIDE the options object would turn
 *     correct code red.
 *   - the rename check asks whether `function withMayDelete` exists. A comment
 *     saying so satisfies a text match while the function is gone, which is the
 *     "a scar is not a wound" direction.
 *   - the premise check looks for the cache key's template literal.
 *     `list-cache.ts` holds exactly one occurrence and it is code — measured,
 *     not assumed — but a docblock quoting the key format would be found FIRST
 *     by `.find()` and the assertion would then be about prose.
 *
 * The two controls below are load-bearing for this, because the cap that asked
 * for the conversion is itself a text match for `blankNonCode`: importing it
 * and never calling it satisfies that cap completely. `COMMENTED_FIXTURE` fails
 * unless the blanking actually runs, and `QUOTED_PAREN_FIXTURE` fails unless it
 * runs with `{ strings: true }` — both verified by mutation, the second only
 * after its first version turned out to prove nothing (see its docblock).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

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
 *
 * The blanking happens HERE rather than at the three call sites, so the
 * controls exercise the same pipeline the real files go through. A control that
 * skips a step the subject performs is testing a different function
 * (`[[a-crosscheck-in-the-old-method]]`).
 *
 * `{ strings: true }` because the subject is a CALL SHAPE, not message text,
 * and `callArgs` counts parentheses: a `)` inside a string literal ends the
 * argument span early and hides every offender after it. That is a false
 * NEGATIVE in a security guard, which is the direction that does damage.
 */
function offendersIn(raw: string, label: string): { offenders: string[]; scanned: number } {
    const src = blankNonCode(raw, { strings: true });
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

/**
 * Correct code whose COMMENT describes the violation.
 *
 * This is the one that fails if `blankNonCode` is imported and not called, and
 * it is the shape #1774 was opened for: a docblock naming the thing a guard
 * hunts for reads as the thing itself.
 */
const COMMENTED_FIXTURE = `
    const rows = await cachedListRead({
        ctx,
        entity: 'task',
        operation: 'list',
        // WRONG: loader: () => withMayDelete(ctx, load(ctx)) — the cache key
        // carries no caller, so this would serve one caller's flag to all.
        loader: () => load(ctx),
    });
    return withMayDelete(ctx, rows);
`;

/**
 * A real violation hidden behind an UNBALANCED `)` inside a string literal.
 *
 * Fails without `{ strings: true }`: `callArgs` reads the quoted paren as the
 * end of the argument list and never reaches the decorator.
 *
 * **Unbalanced is the whole point, and I got this wrong first.** The fixture
 * originally read `'treated area (dca)'` and the mutation SURVIVED — a quoted
 * `(` and `)` increment and decrement the same counter, so a balanced pair
 * inside a string is harmless to `callArgs` and proves nothing. Only a lone
 * closer truncates the span. A label ending in `дка)` is the realistic shape.
 */
const QUOTED_PAREN_FIXTURE = `
    const rows = await cachedListRead({
        ctx,
        entity: 'task',
        operation: 'list',
        params: { label: 'treated area, dca)' },
        loader: () => load(ctx).then((r) => withMayDelete(ctx, r)),
    });
    return rows;
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

    it('CONTROL: a comment describing the violation is not the violation', () => {
        // Proves the blanking RUNS. The cap in
        // `guards-blank-comments-before-matching` only text-matches for
        // `blankNonCode`, so an unused import clears the cap and changes
        // nothing; this case is what makes the conversion real.
        const { offenders, scanned } = offendersIn(COMMENTED_FIXTURE, 'fixture');
        expect(scanned).toBe(1);
        expect(offenders).toEqual([]);
    });

    it('CONTROL: a quoted parenthesis does not truncate the argument span', () => {
        // Proves the blanking runs with `{ strings: true }`. Without it the
        // lone `)` in `'treated area, dca)'` closes the span early and this
        // real offender is missed — the silent direction. A BALANCED pair in a
        // string would not: see the fixture's docblock.
        const { offenders, scanned } = offendersIn(QUOTED_PAREN_FIXTURE, 'fixture');
        expect(scanned).toBe(1);
        expect(offenders).toHaveLength(1);
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
        // Blanked with strings on: a declaration is code, and a comment or a
        // quoted example naming it must not stand in for the function.
        const src = FILES.map((f) =>
            blankNonCode(readFileSync(join(REPO, f), 'utf8'), { strings: true }),
        ).join('\n');
        for (const dec of PER_CALLER_DECORATORS) {
            expect([dec, new RegExp(`function ${dec}\\b`).test(src)]).toEqual([dec, true]);
        }
    });

    it("cachedListRead's key still carries no caller — the premise", () => {
        // If the key ever gains a user, this guard is unnecessary and should be
        // deleted rather than left to imply a hazard that no longer exists.
        //
        // Blanked WITHOUT `strings` here, unlike every other read in this
        // file: the subject IS a template literal. Measured on the real file —
        // matching lines are raw 1, blanked 1, blanked-with-strings 0. Two
        // things follow, and they point opposite ways:
        //
        //   - `strings: false` is load-bearing. Turning it on takes the count
        //     to zero and the assertion below fails. That is a real mutation
        //     proof, not a precaution.
        //   - the blanking itself is a NO-OP today, and that mutation
        //     SURVIVES: `list-cache.ts` holds one occurrence of the key format
        //     and it is the assignment, so comments change nothing here. It
        //     stays because the cap asks every read to be routed, and because
        //     a docblock quoting the key would otherwise be picked ahead of
        //     the code. Recorded rather than claimed as proven.
        const src = blankNonCode(readFileSync(join(REPO, 'src/lib/cache/list-cache.ts'), 'utf8'));
        const keyLines = src
            .split('\n')
            .filter((l) => l.includes('${CACHE_PREFIX}:${opts.entity}:${opts.operation}'));
        // Exactly one, and it is the assignment. More than one would mean this
        // assertion is picking a line rather than reading THE key.
        expect(keyLines).toHaveLength(1);
        expect(keyLines[0]).not.toMatch(/userId|user\.id|ctx\.userId/);
    });
});
