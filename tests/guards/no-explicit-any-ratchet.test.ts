/**
 * `any` usage ratchet.
 *
 * The codebase has a large pre-existing `any` migration debt (1200+
 * occurrences across API routes, usecases, services). Making
 * `@typescript-eslint/no-explicit-any` an `error` meant CI was red
 * for weeks; ESLint can't gradually rollout a rule. Downgrading to
 * `warn` puts lint back in the green but loses the "no new any"
 * pressure.
 *
 * This guard bridges the gap. It caps the `any` patterns across `src/` at the
 * current floor; new code that introduces `: any`, `<any>`, `useState<any>`,
 * `as any`, or `@ts-ignore` pushes a count up, which fails this test. Caps
 * only go DOWN — as types get added, lower the cap.
 *
 * Same ratchet pattern as `tests/guardrails/raw-color-ratchet.test.ts`
 * (Epic 51 — raw Tailwind colours) and `tests/guards/epic60-ratchet.test.ts`
 * (Epic 60 — inline patterns).
 *
 * To lower the caps after a cleanup sweep:
 *   1. Run `npm run count-any` to see the new totals.
 *   2. Update the `CAPS` below to match, never higher.
 *
 * ## The patterns and the counting are NOT in this file (#1526)
 *
 * Both live in `scripts/lib/any-patterns.ts`, shared with `npm run count-any`
 * — so the number step 1 prints is, by construction, the number step 2 is
 * re-flooring against. They used to be separate implementations, and the
 * `as any` regex disagreed between the two guards that enforce it: this one
 * and `scripts/count-any.js` matched `/as\s+any\b/` with no LEADING word
 * boundary, while `tests/guardrails/no-explicit-any-ratchet.test.ts` matched
 * `/\bas\s+any\b/`. The enforcing copy was the broken one, so the words
 * "has any" counted as a cast and a docblock reddened a shard on #1523. That
 * module's docblock carries the detail.
 *
 * ## Why there is a drift sentinel now
 *
 * This guard asserted only `actual <= cap`, so nothing pulled a cap down when
 * the count fell. Measured at the time of #1526, three of the five caps had
 * accumulated slack — `: any` **226**, `<any>` 41, `useState<any>` 23 — which
 * means a PR could have added 226 new `: any` annotations and stayed green.
 * The guard's own cap comment claimed each was "lowered to the exact
 * post-cleanup floor so the gain cannot silently erode"; the gain had eroded,
 * in the direction that leaves no trace, because improvement and regression
 * were indistinguishable to a one-sided assertion.
 *
 * `tests/guardrails/no-explicit-any-ratchet.test.ts` already had this
 * sentinel, but it governs only its own `CURRENT_BASELINE` — the CODE-level
 * `as any` count, after comment stripping. It never covered these five
 * raw-text caps, so nobody owned them.
 */

import { ANY_PATTERNS, countAll } from '../../scripts/lib/any-patterns';

/**
 * Per-pattern cap. Current floor — can only go down when code is
 * migrated to real types. Raising these values requires a team
 * decision and a commit-message rationale.
 */
const CAPS: Record<string, number> = {
    // Roadmap-6 P1 (2026-05-22) — `as any` debt paydown. The cast sweep
    // across ~65 files drove every pattern down; each cap is lowered to
    // the exact post-cleanup floor so the gain cannot silently erode.
    // The `as any` cap counts comment mentions too (this ratchet does
    // not strip comments) — the code-level count is 4, tracked by
    // tests/guardrails/no-explicit-any-ratchet.test.ts.
    // R10-PR3 follow-up (2026-05-24) — `<any>` raised from 61 → 63.
    //
    // #1526 (2026-10-09) — re-floored all five to the measured count, and
    // the drift sentinel below now keeps them there. The previous values
    // (357 / 63 / 24 / 18 / 0) carried 226 / 42 / 23 / 0 / 0 of slack.
    // `as any` fell 18 → 16 because the two remaining hits were the English
    // words "has any", not casts; the other three fell because the debt was
    // genuinely paid down and nothing recorded it.
    ': any': 131,
    '<any>': 21,
    'useState<any>': 1,
    'as any': 16,
    '// @ts-ignore': 0,
};

/**
 * How much a cap may sit above the live count before this guard demands it be
 * lowered. Same tolerance the sibling guardrail uses.
 *
 * Not zero: a cap pinned exactly equal would redden main on the very PR that
 * REMOVES an `any`, which punishes the improvement the ratchet exists to
 * encourage. Five is enough room for a cleanup to land and be re-floored in a
 * follow-up, and far too little to hide a migration's worth of new debt.
 */
const MAX_SLACK = 5;

describe('`any` usage ratchet', () => {
    const { totals, filesScanned } = countAll();

    it('control: the scan found files, and the as-any regex has BOTH boundaries', () => {
        // Without the denominator this whole suite passes vacuously: a walk
        // that returns nothing counts zero of everything and satisfies every
        // cap. That is the empty-selection failure one level up from the one
        // the caps catch.
        expect(filesScanned).toBeGreaterThan(1000);

        // The #1526 defect, asserted as BEHAVIOUR rather than by eyeballing
        // the regex. A missing leading \b makes the first of these match.
        const asAny = ANY_PATTERNS.find((p) => p.label === 'as any');
        expect(asAny).toBeDefined();
        const re = () => new RegExp(asAny!.regex.source, 'g');

        // Ordinary English that must NOT count as a cast.
        expect('a category that has any history'.match(re())).toBeNull();
        expect('this was any good'.match(re())).toBeNull();
        expect('an alias any reader would follow'.match(re())).toBeNull();

        // ...and a real cast, which must still count. Without this the
        // assertions above are satisfied by a regex that matches nothing.
        expect('const x = y as any;'.match(re())).toHaveLength(1);
        expect('(foo as any).bar'.match(re())).toHaveLength(1);
    });

    test.each(ANY_PATTERNS.map((p) => p.label))('%s stays within cap', (label) => {
        const cap = CAPS[label];
        const actual = totals[label];
        if (actual > cap) {
            throw new Error(
                `Pattern "${label}" count rose to ${actual} (cap ${cap}). ` +
                    `Recent commits introduced new \`any\` usage in src/**. ` +
                    `Replace with real types, or narrow the cast (\`unknown\` + ` +
                    `type guard, generic parameter, \`ReturnType<typeof …>\`, etc.). ` +
                    `If the addition is deliberate (e.g. untyped third-party API), ` +
                    `annotate with \`// eslint-disable-next-line\` AND bump the ` +
                    `cap in this file with a committed justification.`,
            );
        }
        expect(actual).toBeLessThanOrEqual(cap);
    });

    test.each(ANY_PATTERNS.map((p) => p.label))(
        '%s cap tracks the live count (drift sentinel)',
        (label) => {
            const cap = CAPS[label];
            const actual = totals[label];
            const slack = cap - actual;
            if (slack > MAX_SLACK) {
                throw new Error(
                    `Pattern "${label}" is at ${actual} but its cap is ${cap} — ` +
                        `${slack} of slack, over the ${MAX_SLACK} allowed. The debt was ` +
                        `paid down and the cap was not lowered, so that much new \`any\` ` +
                        `could land without failing anything. Set CAPS['${label}'] to ` +
                        `${actual} (run \`npm run count-any\` to confirm). Never raise it ` +
                        `to close this gap — that is the regression this sentinel exists ` +
                        `to make visible.`,
                );
            }
            expect(slack).toBeLessThanOrEqual(MAX_SLACK);
        },
    );

    it('total stays within sum of per-pattern caps', () => {
        const total = Object.values(totals).reduce((a, b) => a + b, 0);
        const capTotal = Object.values(CAPS).reduce((a, b) => a + b, 0);
        if (total > capTotal) {
            // Covered by per-pattern tests; this is the readable roll-up.
            throw new Error(`Total \`any\` usages: ${total} (cap sum ${capTotal}).`);
        }
        expect(total).toBeLessThanOrEqual(capTotal);
    });
});
