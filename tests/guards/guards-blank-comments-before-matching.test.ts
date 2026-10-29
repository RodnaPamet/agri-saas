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

import { blankNonCode } from '../helpers/blank-non-code';
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
 *
 * Batch 10 moved it 409 -> 405 and finished the NARROW register: the six it
 * converted each needed a per-read decision, because each reads something that
 * is not TypeScript alongside something that is — a dotenv file, a Markdown
 * doc, `package.json`, `*.prisma`, `migration.sql`. Those reads stay raw and
 * say so at the call site.
 *
 * This cap is NOT finished at 405. It counts every guard reading `src/` text
 * unblanked, which is a broader population than the narrow register ever
 * covered; the narrow one is done, this one has 405 to go.
 *
 * Batch 9 moved it 418 -> 409 (twelve conversions), same diff again.
 *
 * Batch 8 moved it 422 -> 418, in the same diff as its conversions. The live
 * count was 418 against a cap of 422 — drift 4, INSIDE the allowance, so this
 * would have merged green without touching the constant. That is exactly how
 * batch 6 hid a collision, so the rule taken from it is: lower the cap every
 * batch, never bank the slack.
 *
 * Batches 5-7 (#2038, #2040, #2042) moved it 431 -> 422. They were authored
 * without noticing this file, which is the mistake the serialisation note
 * above is about: a second sweep ran in parallel with this one and only the
 * cap caught it. #2040 happened to land inside the drift allowance and went
 * green, which is the uncomfortable half — the collision was already live and
 * invisible for one merge. Those PRs also add a NARROWER register in
 * `a-source-scanning-guard-blanks-its-comments`: this file counts every guard
 * reading `src/` text unblanked (422), that one counts the subset matching a
 * code-shaped literal against file CONTENT (26), which is the actionable
 * list. Two scopes, deliberately; see #1774 for which to use when.
 */
/**
 * Every test root that can hold a source-scanning guard — owner ruling for
 * issue 2400, 2026-10-27.
 *
 * This was `['tests/guards', 'tests/guardrails']`: **2 of 5 roots**, leaving 57
 * unblanked source-scanners invisible to the cap below. Measured on
 * `e4a7bc636`:
 *
 *   | root               | .test.ts | read src | UNBLANKED | was in scope |
 *   | ------------------ | -------- | -------- | --------- | ------------ |
 *   | tests/guards       |      708 |      537 |       354 | yes          |
 *   | tests/guardrails   |      108 |       69 |        52 | yes          |
 *   | tests/contracts    |       11 |        6 |         4 | NO           |
 *   | tests/regression   |        1 |        0 |         0 | NO           |
 *   | tests/unit         |      970 |       60 |        53 | NO           |
 *
 * The hazard a blanked comment prevents — a scanner matching its own prose, or
 * a removal note read as the removal being undone — does not care which
 * directory the test file sits in. `tests/unit` holds the bulk of it, and #2385
 * moved guards OUT of there, so what remains are ordinary unit tests that grep
 * `src/` and are exposed identically.
 *
 * `tests/regression` contributes nothing today. It is listed deliberately
 * rather than omitted as "empty anyway": a root left out because it is empty is
 * a root nobody adds back when it fills.
 *
 * Declared ONCE and read by both the cap and the denominator below. These were
 * two separate copies of the same two-root list — the drift this guard exists
 * to notice in other people's code.
 */
const SCANNED_ROOTS = [
    'tests/guards',
    'tests/guardrails',
    'tests/contracts',
    'tests/regression',
    'tests/unit',
];

/**
 * Separates "nothing is wrong" from "nothing was examined".
 *
 * Raised with the roots, and chosen to be LOAD-BEARING rather than merely low:
 * the widened population is ~1,800 files while the two original roots are ~816,
 * so a floor of 1,200 FAILS if `tests/unit` is dropped from the list again. A
 * floor of 300 cleared a two-root scan silently, which is exactly how 57
 * scanners stayed invisible while the cap looked healthy.
 */
const POPULATION_FLOOR = 1200;

/**
 * NOT carried over from the two-root era. Set to the count the widened scan
 * actually prints on this branch — a cap taken from a stale measurement is
 * either red on arrival or silently slack.
 */
/**
 * 462 → 463 for `acquisition-probe-is-inert`, which is a DETECTOR FALSE
 * POSITIVE rather than new debt — recorded here because this file's own rule is
 * "lower the cap every batch, never bank the slack", so a rise needs a reason.
 *
 * `readsSource` pairs any `readFileSync` with any quoted `src/…` literal, and
 * reads RAW text on purpose: the comment at its call site explains that its
 * subject IS a quoted path literal, so blanking strings first would erase what
 * it looks for. That breadth is the safe direction for a cap, and it is not a
 * defect.
 *
 * But that guard holds a path to `src/lib/db/acquisition-probe.ts` only to hand
 * the module to a subprocess, and the only file it reads is the probe's own
 * JSONL output. It scans no source text, so there are no comments to blank.
 * Satisfying `blanksComments` — which matches merely on the string
 * `blankNonCode` — would mean importing the stripper without using it.
 *
 * I tried the alternative first: restructuring so the subprocess read its own
 * output, removing the pairing. It did not work (the detector matches file
 * TEXT, so `readFileSync` inside the subprocess script string still counts) and
 * it made the test worse. Raising the number and saying why is the honest
 * version of the same outcome.
 */
/**
 * 463 -> 464 for `no-raw-nul-bytes` (#2446), a second DETECTOR FALSE POSITIVE
 * of exactly the kind recorded above — and a stronger case than the first.
 *
 * `readsSource`'s `aimsAtSrc` matches the bare `'src'` in that guard's ROOTS
 * array, so it is paired as a source reader. It cannot satisfy
 * `blanksComments`, and must not: `blankNonCode` replaces string and comment
 * CONTENTS, and every raw NUL this repo has ever carried sits inside a string
 * or template literal. Blanking would erase the exact bytes the guard exists
 * to find, turning it into a control that cannot express failure.
 *
 * Where `acquisition-probe-is-inert` scanned no source text at all (so
 * blanking was merely pointless), this one scans BYTES and blanking is
 * actively destructive. Raising the number and saying why is the honest
 * version, as that entry concluded.
 */
const UNBLANKED_CAP = 464;

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

/**
 * Does it route that text through the shared stripper — by actually CALLING it?
 *
 * This was `/blankNonCode|blank-non-code/.test(src)` on the RAW file (#2403),
 * which asked whether the name APPEARS. Three things then counted as
 * compliance that are not: an unused import, a docblock mentioning the
 * helper, and this guard's own detector regex. The cap exists to stop prose
 * being read as code, and its own compliance test read prose as code.
 *
 * One live instance when #2403 was filed: `one-resolve-delivery` read `src/`
 * raw and said so in a docblock headed "Raw source, deliberately" — the
 * mention alone cleared the cap. Converted in #2405, so the count does not
 * move here.
 *
 * Comments AND strings are blanked before looking for the call, so a quoted
 * example or a docblock cannot stand in for one. `strings: true` is right
 * because the subject is a CALL.
 *
 * ## Two things this does NOT need, both nearly added
 *
 * **A self-exemption.** This file matches `aimsAtSrc` through its own control
 * fixture, and before the change it named the helper without calling one — so
 * it looked like it would report itself, and I wrote an exemption for that
 * with a confident explanation. The mutation that removes the exemption
 * passes: the count is 462 either way, because `blanksComments` now CALLS
 * `blankNonCode` on the line above, so this file satisfies its own predicate
 * honestly. The exemption was dead code justifying itself.
 *
 * **Blanking before `readsSource` as well.** That looks tidier and collapses
 * the population from **462 to 1**, because `aimsAtSrc` matches a QUOTED
 * `'src/…'` and blanking strings destroys exactly what it looks for. A cap
 * falling 462 -> 1 is a detector that stopped detecting, not 462 guards
 * fixing themselves (`[[relaxing-a-caller-removes-the-teeth]]`). So
 * `readsSource` keeps its RAW read — its subject is a path literal — and only
 * the call check blanks.
 */
function blanksComments(src: string): boolean {
    return /blankNonCode\s*\(/.test(blankNonCode(src, { strings: true }));
}


function unblankedGuards(): string[] {
    const files = collectSourceFiles({
        roots: SCANNED_ROOTS,
        extensions: ['.test.ts'],
        // ~600 guard files at the time of writing; a floor well below it
        // separates "nothing is wrong" from "nothing was examined".
        floor: POPULATION_FLOOR,
    });
    return files
        .map((abs) => abs.slice(REPO_ROOT.length + 1))
        .filter((rel) => {
            const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
            // `readsSource` reads the RAW text on purpose: its subject is a
            // quoted path literal, so blanking strings first would erase what
            // it looks for. Only the CALL check blanks.
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
        // A real CALL is compliance. An import alone is not, and neither is a
        // docblock — which is the whole of #2403: the old predicate asked
        // whether the NAME appeared.
        const calls = `${greps}\n const code = blankNonCode(readFileSync(f, 'utf8'));`;
        const importOnly = `${greps}\n import { blankNonCode } from '../helpers/blank-non-code';`;
        const mentionOnly = `${greps}\n // TODO: route this through blankNonCode one day.`;

        expect(readsSource(greps) && !blanksComments(greps)).toBe(true);
        expect(readsSource(calls) && !blanksComments(calls)).toBe(false);
        // The two that used to pass for compliance and no longer do.
        expect(readsSource(importOnly) && !blanksComments(importOnly)).toBe(true);
        expect(readsSource(mentionOnly) && !blanksComments(mentionOnly)).toBe(true);
        // A guard that reads no source at all is not this guard's business.
        expect(readsSource(`expect(1).toBe(1);`)).toBe(false);
    });

    it('prints the numbers — the denominator and the gap', () => {
        const all = collectSourceFiles({
            roots: SCANNED_ROOTS,
            extensions: ['.test.ts'],
            floor: POPULATION_FLOOR,
        });
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
            // `comment-stripper-order` was here and is NOT a converted
            // consumer — #2403 found that out by requiring a real call.
            //
            // It never calls `blankNonCode`; it names it nine times in prose,
            // which the old name-matching predicate counted as compliance. And
            // it should not call it: this guard's docblock describes it as the
            // SIBLING of this one — "it governs HOW a stripper is written where
            // this governs WHETHER one is used" — and it classifies individual
            // LINES through its own `IS_FIXTURE` skip rather than text-matching
            // a whole file. It also has no `aimsAtSrc` match at all, so it has
            // never been in this cap's population.
            //
            // So its presence on a list of "instances #1774 records as fixed"
            // was an artefact of a predicate that could not tell a mention from
            // a call. Removed rather than converted, because there is nothing
            // here to convert.
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
            // Batches 5-7, #1774 (#2038 / #2040 / #2042). Two of these were
            // not hygiene: `cva-primitives` asserted a token that existed
            // only in the comment recording its REMOVAL, and
            // `admin-route-coverage` asserted `hasGuard` TRUE from a match
            // that a docblock naming `requirePermission` would satisfy.
            'tests/guardrails/admin-route-coverage.test.ts',
            'tests/guardrails/api-read-rate-limit.test.ts',
            'tests/guardrails/cva-primitives.test.ts',
            'tests/guardrails/form-primitive-adoption.test.ts',
            'tests/guardrails/pr-1-tenant-tables-org-parity.test.ts',
            'tests/guardrails/redis-prod-required.test.ts',
            'tests/guards/api-key-auth-enabled.test.ts',
            'tests/guards/audit-structured-events.test.ts',
            'tests/guards/oi-3-backup-restore.test.ts',
            'tests/guards/r31-left-palette.test.ts',
            'tests/guards/slow-mode-escape-is-not-throttled.test.ts',
            'tests/unit/filter-standardization.test.ts',
            'tests/unit/middleware-org-route-structural.test.ts',
            'tests/guards/observability-guards.test.ts',
            'tests/unit/tenant-isolation-structural.test.ts',
            // Batch 8, #1774. Three needed care rather than the batch
            // converter: `table-platform-drift` reads GUIDE.md among four
            // `.ts` files and that read stays RAW, `rls-coverage-skip-
            // visibility` names a `.sql` file in a test title but reads a
            // `.ts` one, and `no-direct-prisma` carried a line-PREFIX comment
            // filter that misses a trailing `// prisma.user.findMany()` — now
            // retired in favour of the helper.
            'tests/guardrails/no-compact-filter-bar.test.ts',
            'tests/guardrails/table-platform-drift.test.ts',
            'tests/guards/automation-event-catalog-coherence.test.ts',
            'tests/guards/donut-chart-centering.test.ts',
            'tests/guards/p-polish-a.test.ts',
            'tests/guards/rls-coverage-skip-visibility.test.ts',
            'tests/guards/no-direct-prisma.test.ts',
            'tests/unit/rsc-regression.test.ts',
            // Batch 9, #1774 — twelve whose reads are all `.ts`/`.tsx`, found
            // by pre-flighting the remaining eighteen for file type and for a
            // hand-rolled skipper before converting any. The other six read
            // `.sh`, `.md`, `.json`, `.prisma` or `.sql`, or carry their own
            // comment filter, and are left for individual handling.
            'tests/guards/cardvariants-server-import.test.ts',
            'tests/guards/download-route-gate-reachability.test.ts',
            'tests/guards/epic-67-rollout-coverage.test.ts',
            'tests/guards/invite-email-locale-wiring.test.ts',
            'tests/guards/modal-payload-schema-parity.test.ts',
            'tests/guards/notif-task-due-emit-coverage.test.ts',
            'tests/guards/offline-spec-chunk-warmup.test.ts',
            'tests/guards/optimistic-status-rollback.test.ts',
            'tests/guards/sign-out-purges.test.ts',
            'tests/guards/audit-guardrails.test.ts',
            'tests/unit/job-scope-audit.test.ts',
            'tests/unit/job-tenant-isolation-regression.test.ts',
            // Batch 10, #1774 — the last six of the narrow register. Each
            // reads a NON-TypeScript file alongside its source, and that read
            // is left raw with the reason at the call site: a dotenv file
            // (`#` comments), a Markdown doc, `package.json` (where a `//` in
            // a URL is data and a `/*` would eat the quotes `JSON.parse`
            // needs), `*.prisma`, and `migration.sql` (`--` comments).
            'tests/guardrails/deploy-env-parity.test.ts',
            'tests/guardrails/keyboard-shortcut-conventions.test.ts',
            'tests/guards/p-polish-c.test.ts',
            'tests/guards/p5a-snapshots-table-sidebar.test.ts',
            'tests/unit/data-table.test.ts',
            'tests/guards/notification-eligibility-guardrail.test.ts',
        ]) {
            const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
            expect(`${rel}: ${blanksComments(src)}`).toBe(`${rel}: true`);
        }
    });
});
