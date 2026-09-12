/**
 * The lint ceiling must fail on the things it exists to catch (#874).
 *
 * The gate itself is a selection-based check, which is the defect class this
 * repo keeps re-finding: `expect(offenders).toEqual([])` passes just as happily
 * over a broken selector as over a clean tree. So every assertion here is a
 * MUTATION — it takes a passing measurement, breaks one thing, and requires the
 * gate to notice. A test that only confirms the clean tree passes would certify
 * nothing (see `tests/guards/guard-mutation-proof`-style reasoning in #865).
 *
 * These drive `evaluate()` with fabricated measurements rather than running
 * ESLint. That is deliberate: a real lint pass is ~90s, and — more importantly
 * — a double whose input cannot express the failing case defeats the proof. A
 * `Measurement` is a plain record, so every failure mode below is expressible,
 * including the ones that do not exist in the tree today.
 */
import { evaluate, measure, LIMITS, type Limits, type Measurement } from '../../scripts/lint-ceiling';

/** A measurement that sits exactly at every limit — the pass baseline. */
function atCeiling(): Measurement {
    return {
        files: LIMITS.fileFloor + 400,
        errors: 0,
        warnings: LIMITS.warningCeiling,
        suppressed: LIMITS.suppressionCeiling,
        unjustified: LIMITS.unjustifiedCeiling,
        severity2: { ...LIMITS.severity2 },
    };
}

describe('lint ceiling — the control', () => {
    it('PASSES a measurement that sits at every limit', () => {
        // Without this, every mutation below could be passing for the wrong
        // reason (a gate that fails on everything catches nothing).
        expect(evaluate(atCeiling())).toEqual([]);
    });
});

describe('lint ceiling — muting a finding must not buy a pass', () => {
    it('FAILS when a warning is converted into a suppression', () => {
        // The whole point. `eslint --max-warnings` sees warningCount only, so
        // adding a disable comment lowers the number it checks. Here the
        // finding moves rather than disappears, and the total is unchanged.
        const m = atCeiling();
        m.warnings -= 1;
        m.suppressed += 1;

        const failures = evaluate(m);
        expect(failures.join('\n')).toMatch(/suppressed findings/);
        expect(failures.length).toBeGreaterThan(0);
    });

    it('FAILS when a brand-new mute is added with no reason', () => {
        const m = atCeiling();
        m.suppressed += 1;
        m.unjustified += 1;

        const text = evaluate(m).join('\n');
        expect(text).toMatch(/suppressed findings/);
        expect(text).toMatch(/no `-- reason`/);
    });

    it('a justified mute still counts — a reason is not an exemption', () => {
        const m = atCeiling();
        m.suppressed += 1; // justified, so `unjustified` does not move

        const text = evaluate(m).join('\n');
        expect(text).toMatch(/suppressed findings/);
        expect(text).not.toMatch(/no `-- reason`/);
    });
});

describe('lint ceiling — error-severity rules cannot be muted quietly', () => {
    it('FAILS when a rule configured at severity 2 gains a suppression', () => {
        // `react-hooks/rules-of-hooks` is `error` (eslint.config.mjs:71) because
        // a conditional hook shipped a real crash (#872). A file-level disable
        // turns that off wholesale, and errorCount stays 0.
        const m = atCeiling();
        m.severity2['src/components/GanttChart.tsx|react-hooks/rules-of-hooks'] = 1;

        const text = evaluate(m).join('\n');
        expect(text).toMatch(/error-severity rule muted/);
        expect(text).toMatch(/GanttChart/);
    });

    it('FAILS when an existing error-severity mute grows in place', () => {
        const m = atCeiling();
        const key = 'src/lib/security/pii-middleware.ts|@typescript-eslint/no-explicit-any';
        m.severity2[key] = (m.severity2[key] ?? 0) + 1;

        expect(evaluate(m).join('\n')).toMatch(/error-severity rule muted/);
    });

    it('FAILS when a recorded mute disappears, so the map cannot go stale', () => {
        const m = atCeiling();
        delete m.severity2['src/lib/security/saml-client.ts|@typescript-eslint/no-explicit-any'];

        expect(evaluate(m).join('\n')).toMatch(/error-severity mute removed/);
    });
});

describe('lint ceiling — an empty selection is not a pass', () => {
    it('FAILS when almost nothing was linted, even with zero findings', () => {
        // The cleanest possible numbers, produced by looking at nothing. Every
        // ceiling is satisfied; the file floor is the only thing that objects.
        const m: Measurement = {
            files: 0,
            errors: 0,
            warnings: 0,
            suppressed: 0,
            unjustified: 0,
            severity2: {},
        };
        // Ceilings zeroed so ONLY the floor and the stale-map check can speak —
        // otherwise this would pass for the drift-sentinel's reasons instead.
        const limits: Limits = {
            ...LIMITS,
            warningCeiling: 0,
            suppressionCeiling: 0,
            unjustifiedCeiling: 0,
            severity2: {},
        };
        const text = evaluate(m, limits).join('\n');
        expect(text).toMatch(/files were linted/);
        expect(text).toMatch(/inspected almost nothing/);
    });

    it('FAILS on errors regardless of every other number', () => {
        const m = atCeiling();
        m.errors = 1;
        expect(evaluate(m).join('\n')).toMatch(/ESLint error/);
    });
});

describe('lint ceiling — the ratchet keeps ratcheting', () => {
    it('FAILS when a ceiling drifts far above reality', () => {
        const m = atCeiling();
        m.warnings = LIMITS.warningCeiling - (LIMITS.slack + 1);

        const text = evaluate(m).join('\n');
        expect(text).toMatch(/ratchet has slack/);
        expect(text).toMatch(/warningCeiling/);
    });

    it('tolerates a small improvement without nagging', () => {
        const m = atCeiling();
        m.warnings = LIMITS.warningCeiling - 1;
        expect(evaluate(m)).toEqual([]);
    });
});

describe('measure() reads the fields the gate depends on', () => {
    const cwd = '/repo';

    it('counts a suppressed message, its missing reason, and its severity', () => {
        // Shaped like a real ESLint result: the finding is in
        // `suppressedMessages`, NOT `messages`, and errorCount is 0 — which is
        // exactly why a warningCount-only gate cannot see it.
        const results = [
            {
                filePath: '/repo/src/a.ts',
                errorCount: 0,
                warningCount: 0,
                messages: [],
                suppressedMessages: [
                    { ruleId: 'react-hooks/rules-of-hooks', severity: 2, line: 5, suppressions: [{ kind: 'directive', justification: '' }] },
                    { ruleId: '@typescript-eslint/no-explicit-any', severity: 1, line: 9, suppressions: [{ kind: 'directive', justification: 'third-party shape' }] },
                ],
            },
        ] as unknown as Parameters<typeof measure>[0];

        const m = measure(results, cwd);
        expect(m.files).toBe(1);
        expect(m.errors).toBe(0);
        expect(m.warnings).toBe(0);
        expect(m.suppressed).toBe(2);
        expect(m.unjustified).toBe(1);
        expect(m.severity2).toEqual({ 'src/a.ts|react-hooks/rules-of-hooks': 1 });
    });

    it('tolerates results with no suppressedMessages field', () => {
        const results = [
            { filePath: '/repo/src/b.ts', errorCount: 1, warningCount: 2, messages: [] },
        ] as unknown as Parameters<typeof measure>[0];

        const m = measure(results, cwd);
        expect(m.suppressed).toBe(0);
        expect(m.errors).toBe(1);
        expect(m.warnings).toBe(2);
    });
});
