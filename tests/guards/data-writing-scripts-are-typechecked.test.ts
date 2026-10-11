/**
 * Guard: a script that can WRITE to a database is typechecked (#1485).
 *
 * ## The gap
 *
 * `tsconfig.json` excludes `scripts`. A second program,
 * `tsconfig.scripts.json`, exists to close that for the files where it matters
 * — and its include list was two entries, so **2 of 48 scripts were
 * typechecked** and nothing (not `tsc`, not `tsx`, not jest) read the other 46.
 *
 * That was deliberate, and the config said why: the rest of `scripts/` is
 * "one-off operational tooling that does not hold to the app's strictness, and
 * folding it in would make this a migration instead of a gate".
 *
 * **The premise was measured and is mostly false.** Of the 18 scripts that can
 * modify data, 15 passed that program unchanged. And the three that failed were
 * not strictness mismatches — they were BROKEN SCRIPTS:
 *
 *   `seed-staging.ts`  called `hashForLookup` with no import, so it threw
 *                      `ReferenceError` at step 2 and could never resolve its
 *                      admin user. Its own docblock already blames this
 *                      exclusion for three OTHER field bugs it carried; this
 *                      one survived that pass.
 *   `seed-demo.ts`     `billingAccount.create` was missing the required
 *                      `stripeCustomerId`, so it threw every time into a
 *                      `catch` that swallowed it under the comment
 *                      "BillingAccount shape varies by deployment". It does
 *                      not vary. The plan differentiator those personas exist
 *                      for never happened.
 *   `itest-spray.ts`   imports `importLocationSpatialFile`, which #40 renamed
 *                      to `stageLocationSpatialImport` and made off-thread.
 *                      Broken since then. See EXCLUSIONS.
 *
 * Two of three were fixed in the same change. The point is that a typecheck
 * would have caught all three at the moment they were introduced, and instead
 * they sat in scripts an operator runs against live data.
 *
 * ## Why WRITES is the criterion
 *
 * The config's criterion is *runs in production*. These scripts' risk is
 * *writes to production* — and for a type error the two are the same class,
 * because either way it surfaces when somebody runs the thing against live
 * data with no earlier signal. The difference is that a broken `worker.ts`
 * fails loudly on a schedule somebody watches, while a broken backfill fails
 * once, in front of an operator, mid-incident.
 *
 * `scripts/backfill-journal-title-descriptors.ts` rewrites entries in the
 * journal a REGULATORY register is generated from, and its own docblock says it
 * was "actually run against production".
 *
 * ## Derived, not curated
 *
 * The population comes from the filesystem. #1485 named the choice — enumerate
 * or derive — and #805 already recorded the answer for the `ci-failure`
 * watchlist: *"a curated list is a list somebody forgets"*. So the include list
 * is still literal (a tsconfig cannot glob a semantic property), and this guard
 * is what makes it answerable: add a data-writing script and CI tells you to
 * list it.
 *
 * Note the ORIGINAL measurement in #1485 was "38 scripts, 14 write" — a
 * non-recursive scan that missed `scripts/rag/`. It is 48 and 18.
 *
 * ## Not a duplicate of `scripts-typechecked`
 *
 * That guard pins the PLUMBING: the config exists, `npm run typecheck` runs it,
 * CI invokes it as its own step, and the two queue entrypoints are in it. This
 * one pins WHAT IS IN the program. Neither can see the other's failure — a
 * complete include list is worth nothing if CI stopped invoking the program,
 * and an invoked program is worth nothing if the list fell behind — so do not
 * merge them.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * A Prisma write. The same verb set #1485 measured with, which is the set that
 * can change stored data — a `findMany` in a reporting script is not this.
 */
const WRITE_CALL =
    /\.(update|updateMany|create|createMany|delete|deleteMany|upsert)\s*\(/;

/**
 * Data-writing scripts deliberately NOT typechecked, each with the reason.
 *
 * An entry is a script that can modify data and that nothing reads. The reason
 * has to say why listing it is more than a line — "it fails" is not one, since
 * a failure is the finding rather than the excuse.
 */
const EXCLUSIONS: Readonly<Record<string, string>> = {
    'scripts/itest-spray.ts':
        'Broken since #40 and a REWORK rather than a rename. It imports ' +
        '`importLocationSpatialFile`, which that PR renamed to ' +
        '`stageLocationSpatialImport` AND made off-thread: the old function ' +
        'returned `{ parcelCount, bounds, fileRecordId, format }` synchronously, ' +
        'the new one returns `{ jobId, fileRecordId, format }` and enqueues a ' +
        'BullMQ job. This harness asserts on `parcelCount` and `bounds`, so ' +
        'fixing it means teaching it to WAIT for the import — poll the job, or ' +
        'run the executor inline — which is a design question about an ' +
        'integration harness and not part of adding a typecheck. Filed as ' +
        '#1659; the script cannot even load today, so nothing regresses while ' +
        'it waits.',
};

/** The include list, with the comments the file is full of stripped first. */
function includeList(): string[] {
    const raw = readFileSync(`${REPO_ROOT}/tsconfig.scripts.json`, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as {
        include?: string[];
    };
    return parsed.include ?? [];
}

describe('data-writing scripts are typechecked (#1485)', () => {
    const scripts = collectSourceFiles({
        roots: ['scripts'],
        extensions: ['.ts'],
        // 48 today. A floor near reality catches a renamed directory rather
        // than reporting an empty tree clean.
        floor: 30,
    });

    const writers = scripts
        .filter((abs) => WRITE_CALL.test(blankNonCode(readFileSync(abs, 'utf8'))))
        .map((abs) => relative(REPO_ROOT, abs))
        .sort();

    const included = new Set(includeList());

    it('prints the denominator', () => {
        const excused = writers.filter((w) => w in EXCLUSIONS);
        console.log(
            `[data-writing-scripts-are-typechecked] ${scripts.length} script(s); ` +
                `${writers.length} write to a database; ` +
                `${writers.filter((w) => included.has(w)).length} in the program; ` +
                `${excused.length} excluded.`,
        );
        expect(scripts.length).toBeGreaterThan(30);
        // The population must be a real subset, not everything and not nothing
        // — a detector that matched every file would satisfy the main
        // assertion by making the include list's own entries sufficient.
        expect(writers.length).toBeGreaterThan(5);
        expect(writers.length).toBeLessThan(scripts.length);
    });

    it('has every data-writing script in tsconfig.scripts.json', () => {
        const missing = writers.filter((w) => !included.has(w) && !(w in EXCLUSIONS));
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} script(s) can WRITE to a database and are ` +
                    `typechecked by nothing:\n\n` +
                    missing.map((m) => `  ${m}`).join('\n') +
                    `\n\nAdd each to "include" in tsconfig.scripts.json. If it does ` +
                    `not compile, that is the finding — three of these turned out to ` +
                    `be scripts that could never run at all. If it genuinely must ` +
                    `stay out, add an EXCLUSIONS entry here saying why listing it is ` +
                    `more than a line.`,
            );
        }
        expect(missing).toEqual([]);
    });

    it('lists nothing that does not exist', () => {
        // A stale entry is not harmless: tsconfig `include` silently ignores a
        // path that matches no file, so a renamed script leaves the program
        // reading one file fewer and reporting itself clean.
        const all = new Set(scripts.map((abs) => relative(REPO_ROOT, abs)));
        for (const entry of includeList()) {
            if (!entry.startsWith('scripts/')) continue; // the .d.ts glob
            expect(all.has(entry)).toBe(true);
        }
    });

    it('carries a substantive reason for every exclusion, and no stale ones', () => {
        for (const [path, reason] of Object.entries(EXCLUSIONS)) {
            expect(reason.trim().length).toBeGreaterThan(150);
            // Removes the cover the moment the script stops writing, or goes.
            expect(writers).toContain(path);
        }
    });

    // ── The teeth ────────────────────────────────────────────────────────
    //
    // Zero unexcused writers, so the assertion above runs over an empty set.
    describe('the write detector', () => {
        const writes = (src: string): boolean =>
            WRITE_CALL.test(blankNonCode(src));

        it('finds each verb', () => {
            for (const verb of [
                'update',
                'updateMany',
                'create',
                'createMany',
                'delete',
                'deleteMany',
                'upsert',
            ]) {
                expect(writes(`await prisma.thing.${verb}({ data: {} });`)).toBe(true);
            }
        });

        it('does NOT fire on a read, which is what keeps the population a subset', () => {
            // The half a presence-only test would miss: a detector matching
            // everything makes the main assertion pass for the wrong reason.
            expect(writes('await prisma.thing.findMany({});')).toBe(false);
            expect(writes('await prisma.thing.findUnique({ where: {} });')).toBe(false);
            expect(writes('await prisma.thing.count();')).toBe(false);
            expect(writes('const x = 1;\nconsole.log(x);\n')).toBe(false);
            expect(writes('')).toBe(false);
        });

        it('does not read a COMMENT about a write as a write', () => {
            // This change left scars: `seed-demo.ts` carries a comment naming
            // `billingAccount.create` to explain what was wrong with it, and
            // this guard's own docblock does the same.
            expect(writes('// `billingAccount.create(` was missing a field.')).toBe(false);
            expect(writes('/**\n * calls .upsert( on every run\n */')).toBe(false);
        });
    });
});
