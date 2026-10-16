/**
 * Guard: a NEW guard that greps source for a code pattern blanks comments
 * first (#1774), on a shrink-only cap.
 *
 * ## The defect, four confirmed instances
 *
 * A guard that text-matches source counts PROSE as the code it polices. Both
 * directions are live in this repo:
 *
 * 1. `api-error-wrapper-coverage` read `content.includes('withApiErrorHandling')`
 *    over whole files. A deliberately bare webhook whose docblock explains WHY
 *    it sits outside the wrapper read as wrapped — and because it read as
 *    wrapped, the "every bare route is exempted in writing" assertion SKIPPED
 *    it. A genuinely unprotected route could hide behind a docblock that merely
 *    names the wrapper. Fixed in #1770.
 * 2. `no-explicit-any-ratchet` counts a colon followed by the escape-hatch
 *    keyword across `src/**`. A docblock reading "compares the two: any farm
 *    the database grants…" pushed the count 131 → 132 and reddened three
 *    shards (#1773). It happened AGAIN on 2026-10-15 to a comment in the
 *    treatment form, and the rewording failed on its first attempt because the
 *    replacement quoted the sequence it was explaining.
 * 3. `swr-paths-resolve`, added 2026-10-15, reported `useTenantSWR('/practices')`
 *    from the hook's OWN docblock as an unresolved route on its first run.
 *    Caught before merge only because the example path happens to name no real
 *    route.
 * 4. The inverse — "a scar is not a wound" — where a comment saying "we no
 *    longer call X" satisfies a guard asserting X is called.
 *
 * `tests/helpers/blank-non-code.ts` exists for this and is state-aware:
 * `{ strings: true }` when the subject is a call or a structure, without it
 * when the subject is message text.
 *
 * ## Why a cap and not a conversion
 *
 * 457 guards read source text without blanking at the time of writing, and
 * converting them is a programme rather than a change: many legitimately match
 * COPY rather than code, each conversion needs its own mutation proof, and the
 * 29 that carry a numeric cap need that cap re-measured in the same diff —
 * which is a shared-ratchet edit, and 29 of those at once is how a floor lands
 * wrong when another branch merges first.
 *
 * So the existing population is grandfathered collectively and this cap can
 * only fall. What it stops is the 458th, which is the one thing that makes the
 * conversion programme finite. Same shape as `comment-stripper-order`, which
 * governs HOW a stripper is written where this governs WHETHER one is used.
 *
 * ## What it does NOT claim
 *
 * That the 457 are wrong. Many are right. The cap says only that the number
 * must not grow while nobody is looking.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * Guards that read source text and match against it WITHOUT blanking.
 *
 * Measured 2026-10-16: **432** — 457 → 449 (batch 1, 8 files) → 433 (batch 2,
 * 16 files) → 432 (batch 3, 1 file). Shrink-only: lower it when a batch
 * converts, never raise it. A new guard that greps source must call
 * `blankNonCode`.
 *
 * Batch 4 (431) is `no-raw-skeleton-pulse`, the second CAPPED member — and
 * its cap did not move either, measured before converting: inside that
 * guard's own scope (`src/app`) 14 files match `animate-pulse` with or
 * without blanking. Two capped guards in, "the cap must come down" has been
 * false both times, which is worth knowing before pricing the remaining ten.
 *
 * Batch 3 is ONE file on purpose. It is `no-explicit-any-ratchet`, the second
 * of the two instances #1774 opened with and the one it declined to fix in
 * place because "blanking comments LOWERS the measured count, and the cap has
 * to come down with it". Measured before converting: it does not. The
 * heuristic and the stripper agree exactly at 4, with zero files disagreeing
 * across `src/`, so `CURRENT_BASELINE` did not move — the capped class turned
 * out to be cheaper than the issue priced it, for this member at least.
 *
 * Raised to the branch's LIVE count each time rather than to a round number:
 * slack here is how the next unblanked guard arrives unnoticed, which is what
 * `DRIFT_ALLOWANCE` below also guards.
 *
 * Both batches take only guards WITHOUT a numeric cap of their own — the safe
 * class, since a capped guard needs its cap re-measured in the same diff and
 * #1774's own reasoning is that 29 of those at once is how a shared floor
 * lands wrong. 12 capped guards remain, not the 29 that issue estimated; the
 * figure came from a looser match for cap-shaped constants.
 *
 * Batches must SERIALISE, which is the one scheduling constraint here: both
 * move this constant, so two in flight at once is the shared-ratchet collision
 * the cap exists to prevent, one level up.
 */
const UNBLANKED_CAP = 431;

/**
 * How far below the cap the live count may sit before this fails as slack.
 *
 * Without it the cap drifts upward in effect: a batch converts twenty, nobody
 * lowers the number, and twenty new unblanked guards can arrive unnoticed.
 * Same reasoning as `comment-stripper-order`'s DRIFT_ALLOWANCE.
 */
const DRIFT_ALLOWANCE = 5;

/** Does this guard read files under `src/`? */
function readsSource(src: string): boolean {
    const collects = /collectSourceFiles|collectTrackedFiles|readFileSync/.test(src);
    const aimsAtSrc = /'src[/']|"src[/"]|roots:\s*\[\s*'src'/.test(src);
    return collects && aimsAtSrc;
}

/** Does it route that text through the shared stripper? */
function blanksComments(src: string): boolean {
    return /blankNonCode|blank-non-code/.test(src);
}

function unblankedGuards(): string[] {
    const files = collectSourceFiles({
        roots: ['tests/guards', 'tests/guardrails'],
        extensions: ['.test.ts'],
        // ~600 guard files at the time of writing; a floor well below it
        // separates "nothing is wrong" from "nothing was examined".
        floor: 300,
    });
    return files
        .map((abs) => abs.slice(REPO_ROOT.length + 1))
        .filter((rel) => {
            const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
            return readsSource(src) && !blanksComments(src);
        })
        .sort();
}

describe('a guard that greps source blanks comments first (#1774)', () => {
    const unblanked = unblankedGuards();

    it('the detector tells the two apart — the control it needs', () => {
        // Without this, a `readsSource` that matched nothing would report a
        // clean tree and the cap below would pass for free, forever.
        const greps = `
            import { collectSourceFiles } from '../helpers/collect-files';
            const files = collectSourceFiles({ roots: ['src'] });
            expect(readFileSync(files[0], 'utf8')).not.toContain('withApiErrorHandling');
        `;
        const blanks = `${greps}\n import { blankNonCode } from '../helpers/blank-non-code';`;
        expect(readsSource(greps) && !blanksComments(greps)).toBe(true);
        expect(readsSource(blanks) && !blanksComments(blanks)).toBe(false);
        // A guard that reads no source at all is not this guard's business.
        expect(readsSource(`expect(1).toBe(1);`)).toBe(false);
    });

    it('prints the numbers — the denominator and the gap', () => {
        const all = collectSourceFiles({
            roots: ['tests/guards', 'tests/guardrails'],
            extensions: ['.test.ts'],
            floor: 300,
        });
        // eslint-disable-next-line no-console
        console.log(
            `[guards-blank-comments] ${all.length} guard files; ` +
                `${unblanked.length} read src text without blanking (cap ${UNBLANKED_CAP}, ` +
                `drift allowance ${DRIFT_ALLOWANCE})`,
        );
        expect(all.length).toBeGreaterThan(300);
    });

    it('no NEW guard greps source without blanking — the cap', () => {
        if (unblanked.length <= UNBLANKED_CAP) {
            expect(unblanked.length).toBeLessThanOrEqual(UNBLANKED_CAP);
            return;
        }
        // Name the overshoot rather than printing a number: the author of the
        // 458th needs to know which file is theirs, and a bare count sends
        // them to read 458 files to find out.
        throw new Error(
            [
                `${unblanked.length} guards read source text without blanking comments; the cap is ${UNBLANKED_CAP}.`,
                '',
                'A guard that text-matches source counts PROSE as the code it polices — a docblock',
                'naming `withApiErrorHandling` made a bare route read as wrapped (#1770), and a',
                'comment containing a colon and the escape-hatch keyword moved a ratchet by one',
                '(#1773). Route the read through `blankNonCode` from tests/helpers/blank-non-code.ts:',
                '',
                "    const src = blankNonCode(readFileSync(file, 'utf8'));",
                '',
                'Pass `{ strings: true }` when the subject is a call or a structure rather than',
                'message text, so a brace or a pattern inside a string literal cannot be mistaken',
                'for the thing being looked for.',
                '',
                'If this guard genuinely matches COPY rather than code, it still belongs under the',
                'cap for now — say so in its docblock and raise the matter on #1774 rather than',
                'raising this number.',
            ].join('\n'),
        );
    });

    it('the cap tracks reality — no accumulated slack', () => {
        // A cap far above the live count is a cap that stopped meaning
        // anything: conversions happened and the number was never lowered, so
        // that many new unblanked guards can arrive unnoticed.
        expect(UNBLANKED_CAP - unblanked.length).toBeLessThanOrEqual(DRIFT_ALLOWANCE);
    });

    it('every guard that has been converted stays converted', () => {
        // Named, because a revert would otherwise just free a slot under the
        // cap. These are the instances #1774 records as fixed.
        //
        // The name said "the three guards" while the list held 27 — a count in
        // a NAME goes stale with nothing failing, and the body is the thing
        // that was right. Phrased without a number now.
        for (const rel of [
            'tests/guardrails/api-error-wrapper-coverage.test.ts',
            'tests/guards/swr-paths-resolve.test.ts',
            'tests/guards/comment-stripper-order.test.ts',
            // Batch 1, #1774. Each shares one conversion: `read()` routed
            // through `blankNonCode` with comments only and NOT strings,
            // because several of these assert on string LITERALS and
            // `{ strings: true }` would blank those too and pass vacuously.
            'tests/guards/vr8-canvas-export.test.ts',
            'tests/guards/ui-action-row.test.ts',
            'tests/guards/vr7-subflow.test.ts',
            'tests/guards/automation-epic9-analytics.test.ts',
            'tests/guards/vr10-governance-graph.test.ts',
            'tests/guards/vr4-automation-inspector.test.ts',
            'tests/guards/vr6-execution-overlay.test.ts',
            'tests/guards/vr5-chain-edges.test.ts',
            // Batch 2, #1774 — same one-line conversion. Proved on
            // `automation-executor-hardening`, which is the batch's strongest
            // case: with `assertPublicAddress` (the SSRF DNS check) present
            // only in comments, the converted guard FAILS and the unconverted
            // one PASSES — so unblanked it would greenlight a webhook executor
            // whose DNS-rebinding protection had been removed, on the strength
            // of two comments naming the function.
            'tests/guards/b6-assets-cia-and-table-height.test.ts',
            'tests/guards/ui-canonical-tooltips.test.ts',
            'tests/guards/automation-conditional-branching.test.ts',
            'tests/guards/automation-epic8-templates.test.ts',
            'tests/guards/b10-create-button-dark-contrast.test.ts',
            'tests/guards/ui-tables-columns-owner.test.ts',
            'tests/guards/canvas-mode-toggle-governance.test.ts',
            'tests/guards/ui-chrome-cleanup.test.ts',
            'tests/guards/sharepoint-sp2.test.ts',
            'tests/guards/automation-epic10-monitor.test.ts',
            'tests/guards/automation-scheduled-triggers.test.ts',
            'tests/guards/automation-epic6-executions.test.ts',
            'tests/guards/automation-executor-hardening.test.ts',
            'tests/guards/b1-selection-header-bar.test.ts',
            'tests/guards/b5-entity-prev-next-nav.test.ts',
            'tests/guards/sharepoint-sp5.test.ts',
            // Batch 3, #1774 — the first CAPPED guard, and the issue's own
            // instance 2. Its cap did not move: the heuristic it replaces and
            // the stripper agree at 4 across `src/`.
            //
            // The conversion also removed a whole-tree cross-check that
            // re-implemented the old line heuristic. Keeping it would have
            // re-introduced the defect through the back door — the heuristic
            // counts `x; // as any other row` and the stripper does not, so
            // the two diverge on ordinary English and the guard would go red
            // on prose again, just with a different message. Replaced with a
            // fixture control that runs the real counter.
            'tests/guardrails/no-explicit-any-ratchet.test.ts',
            // Batch 4, #1774 — the second capped guard, cap unmoved. Its own
            // subject made the case: `src/components/ui/skeleton.tsx`, the
            // primitive it steers people toward, names `animate-pulse` twice
            // in prose and never in code, so an unblanked scan would count
            // the cure as a symptom. That file is outside its scan dir, which
            // is the only reason it had not bitten.
            'tests/guards/no-raw-skeleton-pulse.test.ts',
        ]) {
            const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
            expect(`${rel}: ${blanksComments(src)}`).toBe(`${rel}: true`);
        }
    });
});
