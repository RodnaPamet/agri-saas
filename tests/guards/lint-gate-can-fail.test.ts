/**
 * The required `Lint` check must remain able to fail.
 *
 * #874: `package.json` ran a bare `eslint .` with no `--max-warnings`, ESLint
 * exits 0 on warnings, and `next.config.js` sets `eslint.ignoreDuringBuilds`,
 * so Build was no backstop. Eleven rules sat at `warn` and the gate was green
 * over all of them — including `react-hooks/rules-of-hooks`, which reported a
 * real "rendered more hooks than during the previous render" crash on every
 * run (#872) while CI passed.
 *
 * The fix is ONE WORD in eslint.config.mjs. Measured before this file existed:
 * reverting `'error'` to `'warn'` left the full guard suite at 606/606 and
 * `npm run lint` at exit 0, and nothing in the repo referenced the config at
 * all. The fix could be deleted by a one-word edit with no check reporting it —
 * the #874 defect one level up.
 *
 * WHY THIS SHELLS OUT rather than importing ESLint: the flat config is
 * `.mjs`, and ESLint loads it by dynamic import, which jest's CJS runtime
 * refuses without --experimental-vm-modules. Shelling out is also the more
 * honest test — it runs the same binary, with the same config resolution, that
 * CI runs.
 *
 * WHY IT ASSERTS SEVERITY rather than config text: a `toContain("'error'")`
 * passes on a rule moved into a block that does not match app source, or
 * overridden later in the cascade. It catches deletion, not neutering — the
 * trap already documented on the anchors in
 * tests/guards/dependency-governance-integrity.test.ts.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const RULE = 'react-hooks/rules-of-hooks';
/** A path under src/ so the config cascade resolves the way it does in CI. */
const AS_IF = 'src/components/__lint_gate_probe__.tsx';

/** The exact shape that shipped the #872 crash: a hook after an early return. */
const CONDITIONAL_HOOK = [
    'import { useState, useMemo } from "react";',
    'export function Probe({ rows }: { rows: number[] }) {',
    '    const [n, setN] = useState(0);',
    '    if (rows.length === 0) return null;',
    '    const total = useMemo(() => rows.reduce((a, b) => a + b, 0), [rows]);',
    '    return <div onClick={() => setN(n + 1)}>{total}</div>;',
    '}',
].join('\n');

interface Msg {
    ruleId: string | null;
    severity: number;
}

function lint(source: string, extra: string[] = []): { hits: Msg[]; errorCount: number } {
    const out = execFileSync(
        'npx',
        ['eslint', '--stdin', '--stdin-filename', AS_IF, '-f', 'json', ...extra],
        {
            cwd: ROOT,
            input: source,
            encoding: 'utf8',
            env: { ...process.env, ESLINT_USE_FLAT_CONFIG: 'true' },
            // eslint exits non-zero when it reports errors; that is the point.
            maxBuffer: 32 * 1024 * 1024,
        },
    );
    const [res] = JSON.parse(out) as Array<{ messages: Msg[]; errorCount: number }>;
    return { hits: res.messages.filter((m) => m.ruleId === RULE), errorCount: res.errorCount };
}

function lintAllowingFailure(source: string, extra: string[] = []): ReturnType<typeof lint> {
    try {
        return lint(source, extra);
    } catch (e) {
        const err = e as { stdout?: string };
        const [res] = JSON.parse(err.stdout ?? '[]') as Array<{ messages: Msg[]; errorCount: number }>;
        return { hits: res.messages.filter((m) => m.ruleId === RULE), errorCount: res.errorCount };
    }
}

describe('the Lint gate can still fail', () => {
    jest.setTimeout(120_000);

    it(`a real ${RULE} violation is reported at ERROR severity`, () => {
        const { hits, errorCount } = lintAllowingFailure(CONDITIONAL_HOOK);
        // Control first: the probe must actually violate. Without it the
        // severity assertion below is vacuous over an empty selection.
        expect({ rule: RULE, violations: hits.length > 0 }).toEqual({ rule: RULE, violations: true });
        expect(hits.map((m) => m.severity)).toEqual(hits.map(() => 2));
        expect(errorCount).toBeGreaterThan(0);
    });

    it('...and it is the PROMOTION doing that — same input, rule demoted, no error', () => {
        // The discriminating control: identical source and file path, one
        // difference — the rule forced back to its pre-#874 level. If this also
        // produced an error, the assertion above would say nothing about the
        // promotion, only that the rule exists.
        const { hits, errorCount } = lintAllowingFailure(CONDITIONAL_HOOK, [
            '--rule',
            JSON.stringify({ [RULE]: 'warn' }),
        ]);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.map((m) => m.severity)).toEqual(hits.map(() => 1));
        expect(errorCount).toBe(0);
    });

    it('...and clean source produces no violation, so the probe is not always-red', () => {
        const clean = CONDITIONAL_HOOK.replace('    if (rows.length === 0) return null;\n', '');
        const { hits } = lintAllowingFailure(clean);
        expect(hits).toEqual([]);
    });
});
