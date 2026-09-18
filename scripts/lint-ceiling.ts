/**
 * The Lint gate, with a ceiling — and with SUPPRESSIONS counted (#874).
 *
 * ## What was broken
 *
 * `package.json` ran `eslint .` with no `--max-warnings`. ESLint exits 0 on
 * warnings, `Lint` is a required status context, and `next.config.js:147` sets
 * `eslint.ignoreDuringBuilds: true` so Build does not backstop it. 121 warnings
 * stood and the gate was green over all of them. It had already shipped a real
 * crash: `react-hooks/rules-of-hooks` was `warn`, `GanttChart` called `useMemo`
 * after an early return, ESLint reported it on every run, and CI stayed green
 * (fixed in #872; that rule is now `error` at `eslint.config.mjs:71`).
 *
 * ## Why a ceiling on warnings is NOT enough
 *
 * `errorCount` and `warningCount` both EXCLUDE anything silenced by an inline
 * `eslint-disable` comment — those findings move to `result.suppressedMessages`,
 * which a naive gate never reads. Measured on a clean tree at `0a109317b`:
 *
 *     121 warnings          <- what a --max-warnings ceiling sees
 *   1,580 suppressed        <- what it does not
 *
 * So 93% of this repo's lint findings are already outside any warning ceiling,
 * and 1,416 of the 1,580 are `@typescript-eslint/no-explicit-any` alone. Worse,
 * the channel is open at ERROR severity too: 13 suppressed findings come from
 * rules configured at severity 2, including two `react-hooks/rules-of-hooks`
 * mutes — the exact rule promoted to `error` to stop the #872 crash class.
 *
 * A gate that counts only `warningCount` therefore makes muting the CHEAPEST
 * way to go green: add a disable comment and the number goes down. That is the
 * same defect this repo keeps finding elsewhere — an observable that the
 * healthy path and the broken path both produce.
 *
 * The repo's own `as any` ratchet already reached the opposite conclusion and
 * says so in its failure text (`tests/guardrails/no-explicit-any-ratchet.test.ts`:
 * "The cast still counts toward the baseline") — it counts by scanning text
 * precisely so an `eslint-disable` cannot erase a cast from the tally. This
 * script applies that same rule to lint findings as a whole.
 *
 * ## The invariant
 *
 * **Converting a warning into a suppression must never reduce a number.**
 * Muting a warning moves it from `warnings` to `suppressed`, so the warning
 * ceiling relaxes by one and the suppression ceiling is exceeded by one. The
 * gate fails. Silencing costs exactly as much as leaving it.
 *
 * Ceilings may be LOWERED freely in any PR. Raising one is a visible, reviewable
 * line in the diff — which is the whole mechanism. A drift sentinel forces each
 * ceiling down as findings are genuinely fixed, so slack cannot accumulate and
 * be spent silently later (the same shape as `CURRENT_BASELINE` in the two
 * existing ratchets).
 *
 * ## The file floor
 *
 * A lint run whose config stops resolving reports zero findings and satisfies
 * every ceiling above. An empty selection is a PASS. So the linted-file count
 * has a floor: this gate must fail when it is inspecting nothing, rather than
 * reporting the cleanest run in the project's history.
 */
import { ESLint } from 'eslint';

/** `${relative file path}|${ruleId}` */
export type Severity2Key = string;

export interface Measurement {
    /** Files ESLint actually inspected. Floored, so a collapsed config cannot pass. */
    files: number;
    errors: number;
    warnings: number;
    /** Findings silenced by an inline `eslint-disable*` comment. */
    suppressed: number;
    /** Of those, the ones whose directive carries no `-- reason` text. */
    unjustified: number;
    /** Suppressions of rules configured at severity 2, keyed by file and rule. */
    severity2: Record<Severity2Key, number>;
}

export interface Limits {
    fileFloor: number;
    warningCeiling: number;
    suppressionCeiling: number;
    unjustifiedCeiling: number;
    /** Exact expected counts. Both a new mute and a removed one fail, so the map stays true. */
    severity2: Record<Severity2Key, number>;
    /** How far a ceiling may sit above reality before it must be ratcheted down. */
    slack: number;
}

/**
 * Measured on a clean tree at `0a109317b` with the same single ESLint pass this
 * script performs. Every number here is reproducible by running the script.
 *
 * To LOWER a ceiling after genuinely fixing findings: run `npm run lint`, take
 * the reported actual, and set the ceiling to it in the same PR.
 */
export const LIMITS: Limits = {
    // 3,868 files linted today. The floor is not a target — it exists only to
    // separate "nothing is wrong" from "nothing was examined", so it sits well
    // below the real count and still catches a config that stops resolving.
    fileFloor: 3400,
    warningCeiling: 120,
    suppressionCeiling: 1580,
    unjustifiedCeiling: 461,
    // The 13 error-severity mutes that exist today. `no-explicit-any` is
    // escalated to `error` for the security surface by the override at
    // `eslint.config.mjs:116`, so those mutes turn the repo's STRICTEST scoping
    // off from inside the file it is meant to constrain.
    //
    // `tests/e2e/fixtures.ts` is a genuine plugin false positive — Playwright's
    // `use` fixture parameter read as React's `use()` hook, in a file that
    // imports nothing from React. It wants config scoping rather than a mute;
    // recorded here so the debt is visible instead of invisible.
    severity2: {
        'src/components/ui/table/selection-toolbar.tsx|react/display-name': 1,
        'src/lib/security/pii-middleware.ts|@typescript-eslint/no-explicit-any': 9,
        'src/lib/security/saml-client.ts|@typescript-eslint/no-explicit-any': 1,
        'tests/e2e/fixtures.ts|react-hooks/rules-of-hooks': 2,
    },
    slack: 25,
};

/** Reduce ESLint's per-file results to the numbers the gate is expressed in. */
export function measure(results: ESLint.LintResult[], cwd: string): Measurement {
    const m: Measurement = {
        files: 0,
        errors: 0,
        warnings: 0,
        suppressed: 0,
        unjustified: 0,
        severity2: {},
    };
    const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;

    for (const result of results) {
        m.files += 1;
        m.errors += result.errorCount;
        m.warnings += result.warningCount;

        for (const msg of result.suppressedMessages ?? []) {
            m.suppressed += 1;

            // ESLint fills `justification` from the `-- reason` half of a
            // directive. Empty means the mute states no reason at all.
            const reasons = (msg.suppressions ?? [])
                .map((s) => (s.justification ?? '').trim())
                .filter((s) => s.length > 0);
            if (reasons.length === 0) m.unjustified += 1;

            // Severity survives suppression, so an error-level mute is
            // identifiable without re-resolving each file's config.
            if (msg.severity === 2) {
                const file = result.filePath.startsWith(prefix)
                    ? result.filePath.slice(prefix.length)
                    : result.filePath;
                const key = `${file}|${msg.ruleId ?? '(no rule)'}`;
                m.severity2[key] = (m.severity2[key] ?? 0) + 1;
            }
        }
    }
    return m;
}

/** Every reason this measurement fails the gate. Empty means pass. */
export function evaluate(m: Measurement, limits: Limits = LIMITS): string[] {
    const failures: string[] = [];

    // Checked FIRST. Every count below is a selection, and an empty selection
    // satisfies every ceiling — so "did we look at anything?" has to be settled
    // before any number derived from looking is believed.
    if (m.files < limits.fileFloor) {
        failures.push(
            `Only ${m.files} files were linted (floor ${limits.fileFloor}).\n` +
                `  This is not a clean result — it is a run that inspected almost nothing.\n` +
                `  Check the flat config's ignores and that the working directory is the repo root.`,
        );
    }

    if (m.errors > 0) {
        failures.push(`${m.errors} ESLint error(s). Errors are never allowed.`);
    }

    const ceilings: Array<{ label: string; actual: number; ceiling: number; hint: string }> = [
        {
            label: 'warnings',
            actual: m.warnings,
            ceiling: limits.warningCeiling,
            hint: 'Fix the finding. Silencing it moves it to the suppression count below, which does NOT reduce the total.',
        },
        {
            label: 'suppressed findings',
            actual: m.suppressed,
            ceiling: limits.suppressionCeiling,
            hint: 'A new `eslint-disable` costs the same as a new warning. Fix the finding, or raise this ceiling explicitly in the diff and say why.',
        },
        {
            label: 'suppressions with no `-- reason`',
            actual: m.unjustified,
            ceiling: limits.unjustifiedCeiling,
            hint: 'Write the reason into the directive: `// eslint-disable-next-line rule -- why this is safe here`.',
        },
    ];

    for (const c of ceilings) {
        if (c.actual > c.ceiling) {
            failures.push(
                `${c.label}: ${c.actual} (ceiling ${c.ceiling}, +${c.actual - c.ceiling})\n  ${c.hint}`,
            );
        }
    }

    // Error-severity mutes are few enough to track exactly, and each one turns
    // off a rule the config says must never be violated. Exact match in BOTH
    // directions: a new mute fails, and a removed one fails until the map is
    // updated, so the list cannot quietly stop describing the tree.
    const keys = new Set([...Object.keys(m.severity2), ...Object.keys(limits.severity2)]);
    for (const key of [...keys].sort()) {
        const actual = m.severity2[key] ?? 0;
        const allowed = limits.severity2[key] ?? 0;
        if (actual > allowed) {
            failures.push(
                `error-severity rule muted: ${key} — ${actual} suppression(s), ${allowed} recorded.\n` +
                    `  This rule is configured at severity 2, so the config says it must never be violated.\n` +
                    `  Fix it, or scope the rule in eslint.config.mjs. Recording a new mute here needs a stated reason in review.`,
            );
        } else if (actual < allowed) {
            failures.push(
                `error-severity mute removed: ${key} — ${actual} left, ${allowed} recorded.\n` +
                    `  Good news. Update LIMITS.severity2 in scripts/lint-ceiling.ts so the map stays accurate.`,
            );
        }
    }

    // Drift sentinels. A ceiling far above reality has stopped ratcheting, and
    // the gap is headroom a future regression spends without going red.
    const sentinels: Array<{ label: string; actual: number; ceiling: number; field: string }> = [
        { label: 'warnings', actual: m.warnings, ceiling: limits.warningCeiling, field: 'warningCeiling' },
        { label: 'suppressed', actual: m.suppressed, ceiling: limits.suppressionCeiling, field: 'suppressionCeiling' },
        { label: 'unjustified', actual: m.unjustified, ceiling: limits.unjustifiedCeiling, field: 'unjustifiedCeiling' },
    ];
    for (const s of sentinels) {
        const gap = s.ceiling - s.actual;
        if (gap > limits.slack) {
            failures.push(
                `ratchet has slack: ${s.label} is ${s.actual} but the ceiling is ${s.ceiling} (gap ${gap}, max ${limits.slack}).\n` +
                    `  Lower LIMITS.${s.field} to ${s.actual} in scripts/lint-ceiling.ts so the gap cannot be spent by a later regression.`,
            );
        }
    }

    return failures;
}

/** The measured-vs-ceiling table. Printed on success too — a gate should show its work. */
export function report(m: Measurement, limits: Limits = LIMITS): string {
    const row = (label: string, actual: number, ceiling: number, cmp: '≤' | '≥') =>
        `  ${label.padEnd(34)} ${String(actual).padStart(6)}  ${cmp} ${String(ceiling).padStart(6)}`;
    return [
        '',
        '  lint ceiling                       actual    limit',
        '  ' + '-'.repeat(50),
        row('files linted', m.files, limits.fileFloor, '≥'),
        row('errors', m.errors, 0, '≤'),
        row('warnings', m.warnings, limits.warningCeiling, '≤'),
        row('suppressed findings', m.suppressed, limits.suppressionCeiling, '≤'),
        row('  ...without a `-- reason`', m.unjustified, limits.unjustifiedCeiling, '≤'),
        row('  ...of error-severity rules', Object.values(m.severity2).reduce((a, b) => a + b, 0),
            Object.values(limits.severity2).reduce((a, b) => a + b, 0), '≤'),
        '',
    ].join('\n');
}

export async function main(): Promise<number> {
    const cwd = process.cwd();
    const eslint = new ESLint({ cwd });
    const results = await eslint.lintFiles(['.']);

    // Human-readable findings first, so the gate's output is a superset of what
    // `eslint .` used to print rather than a replacement for it.
    const formatter = await eslint.loadFormatter('stylish');
    const text = await formatter.format(results);
    if (text.trim().length > 0) console.log(text);

    const m = measure(results, cwd);
    console.log(report(m));

    const failures = evaluate(m);
    if (failures.length === 0) {
        console.log('  lint ceiling: PASS\n');
        return 0;
    }
    console.error(`  lint ceiling: FAIL — ${failures.length} problem(s)\n`);
    for (const f of failures) console.error(`  • ${f}\n`);
    return 1;
}

// See scripts/rag/ingest-corpus.ts for why this is guarded rather than a bare
// `require.main === module`: the named exports above are imported from a test,
// and `module` is not defined in a real ESM context.
if (typeof module !== 'undefined' && require.main === module) {
    main()
        .then((code) => process.exit(code))
        .catch((err) => {
            console.error('lint ceiling failed to run:', err);
            process.exit(1);
        });
}
