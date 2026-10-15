/**
 * Epic C — `as any` count ratchet.
 *
 * The codebase has been progressively cleaned of unsafe `as any`
 * casts. This guardrail locks in the gain by tracking the total
 * count across `src/` and refusing to let it grow.
 *
 * ## Policy
 *
 *   • The current count (`CURRENT_BASELINE` below) is the ceiling.
 *     A PR that increases it FAILS this test with an actionable
 *     message pointing at the offending lines.
 *   • The baseline only moves DOWN. When a PR removes casts, it
 *     should lower `CURRENT_BASELINE` in the same diff (or risk
 *     a future regression silently re-using the slack).
 *   • Target: <50 total. Phase 3+ work continues to drive this
 *     downward toward the high-risk-perimeter zero-cast goal.
 *
 * ## How to fix a failure
 *
 *   1. Eliminate the new `as any` cast you introduced. Prefer
 *      Prisma-generated types, `z.infer<>`, an explicit interface,
 *      or `unknown` + runtime narrowing.
 *   2. If the cast is genuinely unavoidable (Prisma `Json` columns,
 *      third-party type buggery, dynamic indexing), tag the line
 *      with `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`
 *      so the reviewer can see the intent. The cast still counts
 *      toward the baseline.
 *   3. Lower `CURRENT_BASELINE` in this file in the same PR if
 *      the count actually dropped (e.g. you removed more than you
 *      added). The ratchet only moves the floor downward.
 *
 * Test files (`tests/**`) are excluded — those are allowed to use
 * `any` for ergonomic mocking under a separate ESLint override.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

/**
 * The agreed ceiling for total `as any` occurrences in `src/`.
 *
 * History — only edit DOWNWARD. Each adjustment carries a one-line
 * rationale so the ratchet's audit trail stays legible.
 *
 *   • 274 → 175: Epic C Phase 1 (2026-04-30) — security-critical to
 *     zero, mechanical (prisma|db) cast sweep, raw-SQL row-recast
 *     cleanup in heavy data-path files, typed EntitlementError +
 *     ambient EdgeRuntime declaration. (Counting only code-level
 *     occurrences — docstring/comment mentions are excluded.)
 *   • 175 → 4: Roadmap-6 P1 (2026-05-22) — `as any` debt paydown
 *     across ~65 files: Prisma enum/Json typing in repositories,
 *     services and usecases; schema-derived (`z.infer`) input types
 *     at the API route ↔ usecase boundary; typed delegate adapters
 *     for dynamic model access; `instanceof` error narrowing. The
 *     remaining 4 are documented staged debt — onboarding's
 *     STEP_ORDER vs ONBOARDING_STEPS divergence (×3, a latent bug
 *     out of P1 scope) and retention-notifications' system-user gap
 *     (×1) — each carries an inline eslint-disable + reason.
 */
const CURRENT_BASELINE = 4;

const AS_ANY_RE = /\bas\s+any\b/;

function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    function walk(d: string) {
        for (const name of fs.readdirSync(d)) {
            const abs = path.join(d, name);
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) walk(abs);
            else if (
                (name.endsWith('.ts') || name.endsWith('.tsx')) &&
                !name.endsWith('.d.ts')
            ) out.push(abs);
        }
    }
    walk(dir);
    return out;
}

interface Hit {
    file: string;
    line: number;
    text: string;
}

/**
 * The source with comments and strings blanked, split into lines.
 *
 * Extracted so the fixture controls below run the REAL code path. The sanity
 * test used to re-implement the line heuristic inline and assert against its
 * own copy — a control that validates a duplicate of the logic cannot fail on
 * a defect in the logic.
 */
function codeLinesOf(src: string): string[] {
    return blankNonCode(src, { strings: true }).split('\n');
}

/** Occurrences of `as any` in real code, for one source string. */
function countAsAnyIn(src: string): number {
    let n = 0;
    for (const line of codeLinesOf(src)) {
        n += (line.match(new RegExp(AS_ANY_RE.source, 'g')) ?? []).length;
    }
    return n;
}

function findAsAnyHits(): Hit[] {
    const hits: Hit[] = [];
    for (const abs of listTsFiles(SRC_DIR)) {
        // Through the shared stripper, not a line heuristic (#1774 batch 3).
        //
        // The heuristic it replaces skipped lines whose TRIMMED form starts
        // with `*` or `//`, and its own comment admitted the limit: "would
        // require a proper parser". Two shapes it misses, both ordinary:
        //
        //     const x = resolve(row);   // treat it as any other row
        //     /* as any — see #123 */
        //
        // Neither line STARTS with `*` or `//`, so both counted as casts.
        // `\bas\s+any\b` is a phrase English produces freely ("as any
        // other", "such as any"), which is what makes this the live half of
        // #1774's instance 2 — the pattern has since changed from `: any` to
        // `as any`, and the prose exposure grew rather than went away.
        //
        // `{ strings: true }` because the subject is a type assertion: a
        // string containing the words "as any" is not a cast. Line and column
        // positions survive blanking, so the reported `line` is unchanged.
        //
        // MEASURED before converting, across all of `src/`: the heuristic and
        // the stripper agree exactly today — 4 and 4, with zero files
        // disagreeing. So this moves no number and `CURRENT_BASELINE` stays
        // at 4. It removes a hand-rolled stripper and closes two leaks that
        // had not yet been hit.
        const lines = codeLinesOf(fs.readFileSync(abs, 'utf8'));
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Count each occurrence on the line so a `(x as any) || (y as any)`
            // counts as 2 — the ratchet measures real cast density.
            const matches = line.match(new RegExp(AS_ANY_RE.source, 'g'));
            if (matches) {
                for (let m = 0; m < matches.length; m++) {
                    hits.push({
                        file: path.relative(REPO_ROOT, abs),
                        line: i + 1,
                        text: line.trim(),
                    });
                }
            }
        }
    }
    return hits;
}

describe('Epic C — `as any` count ratchet', () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // This file already has a "proves the detector is real" test, and it is
    // a good one — but it runs the heuristic over a SYNTHETIC string.
    // `findAsAnyHits()` takes no arguments and scans `src/` itself, so
    // nothing here touched the real traversal: `selector-teeth` (#971) found
    // both `listTsFiles` and `findAsAnyHits` survive being gutted.
    //
    // All three existing tests then pass on a scan of nothing. The ceiling
    // (`count <= 4`) is satisfied by 0. The drift sentinel only fires when
    // slack > 5, and a gutted scan gives slack 4. The detector sanity test
    // never calls the traversal at all.
    //
    // The consequence is worse than a green on an unscanned tree: the
    // documented remedy for slack is to LOWER CURRENT_BASELINE, so a
    // silently-empty scan invites someone to ratchet the ceiling to 0 and
    // lock in a false floor that every future cast then has to beat.

    it('control: the ratchet walks a real source tree', () => {
        const files = listTsFiles(SRC_DIR);
        expect(files.length).toBeGreaterThan(200);
        expect(files.every((f) => path.isAbsolute(f))).toBe(true);
        expect(files.every((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))).toBe(true);
    });

    it('control: the counter tells a cast from prose that merely says "as any"', () => {
        // This REPLACES a whole-tree cross-check that re-implemented the old
        // line heuristic and compared it with `findAsAnyHits`.
        //
        // Converting the primary to the shared stripper made that comparison
        // actively harmful: the heuristic counts `x; // as any other row` and
        // the stripper does not, so the two diverge the moment anybody writes
        // an ordinary English sentence — and the guard would go RED on prose
        // again, just with a different message. #1774's instance 2 is exactly
        // that failure, and reproducing it in the control would be a poor
        // trade for an independent implementation.
        //
        // A fixture answers the same question without ranging over the repo's
        // prose, and it exercises the real code path rather than a copy.
        const cast = 'const a = x as any;\nconst b = (y as any).foo;';
        expect(countAsAnyIn(cast)).toBe(2);

        // The two shapes the heuristic missed. Neither line STARTS with `*`
        // or `//`, which is all the heuristic ever tested.
        expect(countAsAnyIn('const x = resolve(row); // treat it as any other row')).toBe(0);
        expect(countAsAnyIn('/* as any — see #123 */')).toBe(0);
        // And a string, which `{ strings: true }` is for.
        expect(countAsAnyIn("const s = 'treat as any other';")).toBe(0);
        // The shapes it DID catch stay caught — but as REAL comments. A bare
        // ` * as any in jsdoc` line with no `/*` opener is not a comment at
        // all to a state machine, it is code, and `as any` in it is a cast.
        // The old heuristic skipped any line starting with `*`, which was
        // right for continuation lines only by coincidence; this is what that
        // coincidence looks like when the fixture is honest.
        expect(countAsAnyIn('/**\n * as any in jsdoc\n */')).toBe(0);
        expect(countAsAnyIn('// historical: as any cast was here')).toBe(0);

        // A cast on the same line as prose that mentions it — the case that
        // decides whether blanking is positional rather than whole-line.
        expect(countAsAnyIn('const c = d as any; // not as any other thing')).toBe(1);

        // And the scan over the real tree still finds the casts the ratchet
        // is counting, so this file is not green by scanning nothing.
        expect(findAsAnyHits().length).toBeGreaterThan(0);
    });

    it(`total \`as any\` count in src/ stays at or below ${CURRENT_BASELINE}`, () => {
        const hits = findAsAnyHits();
        const count = hits.length;

        if (count > CURRENT_BASELINE) {
            // Build an actionable failure message — show the most
            // recently-added candidates so reviewers can spot the
            // offending diff. Limit to first 25 to keep output legible.
            const sample = hits.slice(0, 25)
                .map((h) => `  ${h.file}:${h.line}  ${h.text}`)
                .join('\n');
            throw new Error(
                [
                    `\`as any\` count regressed:`,
                    ``,
                    `  current  : ${count}`,
                    `  ceiling  : ${CURRENT_BASELINE}`,
                    `  delta    : +${count - CURRENT_BASELINE}`,
                    ``,
                    `Sample (first 25 hits):`,
                    sample,
                    ``,
                    `Why:`,
                    `  Each \`as any\` is a hole in the type system. The codebase`,
                    `  is on a downward ratchet to <50; new casts cannot be`,
                    `  introduced silently.`,
                    ``,
                    `Fix:`,
                    `  1. Replace the new cast(s) with a typed alternative:`,
                    `       - Prisma generated types`,
                    `       - z.infer<typeof Schema>`,
                    `       - explicit interface`,
                    `       - unknown + runtime narrowing`,
                    `  2. If genuinely unavoidable, prefix the line with`,
                    `       // eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`,
                    `     The cast still counts toward the baseline.`,
                    `  3. If the diff actually REMOVED casts net-net, lower`,
                    `     CURRENT_BASELINE in this file in the same PR with`,
                    `     a one-line History entry.`,
                ].join('\n'),
            );
        }
    });

    it(`baseline is monotonically decreasing — current ${CURRENT_BASELINE} should match or exceed actual count (drift sentinel)`, () => {
        const count = findAsAnyHits().length;
        // If the count is more than 5 BELOW the baseline, the
        // baseline hasn't been ratcheted down. Bump it so future
        // regressions can't silently consume the slack.
        const slack = CURRENT_BASELINE - count;
        if (slack > 5) {
            throw new Error(
                [
                    `Ratchet has slack — please lower CURRENT_BASELINE.`,
                    ``,
                    `  current count : ${count}`,
                    `  baseline      : ${CURRENT_BASELINE}`,
                    `  slack         : ${slack}`,
                    ``,
                    `The baseline only moves downward. After a cast-removal PR,`,
                    `lower CURRENT_BASELINE to the new count (or close to it,`,
                    `e.g. count + 1 for one slot of in-flight tolerance).`,
                ].join('\n'),
            );
        }
    });

    // ── Mutation regression — proves the detector is real ──
    it('detector counts injected casts (sanity)', () => {
        const fakeSrc = [
            'const a = x as any;',
            'const b = (y as any).foo;',
            'function f(z: any) { return z as any; }',
            '// historical: as any cast was here', // commented — should NOT count
            // A REAL block comment. This fixture used to be the bare
            // continuation line ` * as any in jsdoc`, which the old line
            // heuristic skipped and a state machine correctly reads as code —
            // so the fixture was asserting the heuristic's coincidence rather
            // than the behaviour anybody wants.
            '/**',
            ' * as any in jsdoc',
            ' */'
        ].join('\n');

        // Through the real counter, not a re-implementation of it. This test
        // previously copied the heuristic inline and asserted against its own
        // copy, so a defect in the shipped path could not fail it.
        const count = countAsAnyIn(fakeSrc);
        // Lines 1, 2, 3 each have exactly one `as any` (the `z: any`
        // parameter annotation on line 3 doesn't match — the regex
        // requires the literal `as any`). Lines 4 and 5 are skipped
        // by the comment heuristic. Total: 3.
        expect(count).toBe(3);
    });
});
