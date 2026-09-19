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

function findAsAnyHits(): Hit[] {
    const hits: Hit[] = [];
    for (const abs of listTsFiles(SRC_DIR)) {
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Skip line-level matches inside block comments would require
            // a proper parser. Heuristic: skip lines whose stripped form
            // starts with `*` (JSDoc/block-comment continuations) or
            // `//` (single-line comment) — these are docstring mentions
            // of historical casts, not actual code casts.
            const stripped = line.trim();
            if (stripped.startsWith('*') || stripped.startsWith('//')) continue;
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

    it('control: findAsAnyHits agrees with an independent scan of the same tree', () => {
        // Mirrors the documented heuristic — skip `*` and `//` continuation
        // lines, count every occurrence on a line — computed here rather
        // than trusted from the helper. A gutted `findAsAnyHits` returns 0
        // while this still returns the real number, so the two disagree.
        //
        // This stays correct if the codebase ever reaches zero casts: both
        // sides go to 0 together and still agree. It is the DIVERGENCE that
        // is the signal, not the value.
        let independent = 0;
        for (const abs of listTsFiles(SRC_DIR)) {
            for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
                const stripped = line.trim();
                if (stripped.startsWith('*') || stripped.startsWith('//')) continue;
                independent += (line.match(new RegExp(AS_ANY_RE.source, 'g')) ?? []).length;
            }
        }
        expect(findAsAnyHits().length).toBe(independent);
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
            ' * as any in jsdoc',                  // jsdoc — should NOT count
        ].join('\n');

        // Count direct, code-level matches only — same heuristic as
        // findAsAnyHits.
        let count = 0;
        for (const line of fakeSrc.split('\n')) {
            const stripped = line.trim();
            if (stripped.startsWith('*') || stripped.startsWith('//')) continue;
            const matches = line.match(new RegExp(AS_ANY_RE.source, 'g'));
            if (matches) count += matches.length;
        }
        // Lines 1, 2, 3 each have exactly one `as any` (the `z: any`
        // parameter annotation on line 3 doesn't match — the regex
        // requires the literal `as any`). Lines 4 and 5 are skipped
        // by the comment heuristic. Total: 3.
        expect(count).toBe(3);
    });
});
