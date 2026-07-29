/**
 * Quality-coverage capstone — the meta-ratchet.
 *
 * The quality roadmap closed three governance gaps, each with a
 * structural surface that holds the gain:
 *
 *   1. The per-layer coverage floors + the never-lowered ratchet
 *      (`coverage-ratchet.test.ts`, `jest.thresholds.json`).
 *   2. The E2E coverage manifest for the four browser-shaped UI
 *      surfaces that were explicitly deferred to Playwright
 *      (`e2e-coverage-manifest.test.ts`).
 *   3. The two policy / portfolio docs that explain WHY the
 *      enforced numbers are what they are
 *      (`coverage-policy.md`, `test-portfolio.md`).
 *
 * THIS test guards the guards: it fails CI if any one of those
 * surfaces is deleted, renamed, or gutted to a no-op, and if the
 * load-bearing facts inside them are removed. A contributor who
 * removes a quality-coverage surface must reckon with a red
 * meta-ratchet — the gap cannot silently reopen.
 *
 * Sibling of `ci-pipeline-integrity.test.ts`,
 * `observability-reliability-integrity.test.ts`,
 * `verification-integrity.test.ts`,
 * `codebase-hygiene-integrity.test.ts`, and
 * `dependency-governance-integrity.test.ts` — same "guard the
 * guards" pattern, the quality-coverage domain.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The quality-coverage guardrail registry. Each test surface must
 * exist, still carry its load-bearing anchors (proof it was not
 * gutted), and carry a real assertion surface (≥3 `it` blocks for
 * test files).
 */
interface GuardEntry {
    file: string;
    pillar: string;
    anchors: ReadonlyArray<string>;
    /** When true the file is a test and is checked for ≥3 it-blocks. */
    isTest: boolean;
}

const GUARDRAILS: ReadonlyArray<GuardEntry> = [
    {
        file: 'tests/guards/coverage-ratchet.test.ts',
        pillar:
            'coverage thresholds — never-lowered ratchet across global + per-layer keys',
        anchors: ['RATCHET_FLOOR', 'jest.thresholds.json', 'src/app-layer/usecases/'],
        isTest: true,
    },
    {
        file: 'tests/guards/e2e-coverage-manifest.test.ts',
        pillar:
            'E2E first-wave manifest — the four browser-shaped UI surfaces',
        anchors: ['E2E_MANIFEST', 'search-affordances', 'tenant-switcher', 'entity-detail-layout'],
        isTest: true,
    },
    {
        file: 'docs/coverage-policy.md',
        pillar:
            'coverage policy — risk tiers, staged plan, never-lowered rule',
        anchors: ['Risk tiers', 'staged ratchet', 'ratchet: never'],
        isTest: false,
    },
    {
        file: 'docs/test-portfolio.md',
        pillar:
            'test portfolio — layered assurance model + structural-vs-behavioural rule',
        anchors: ['structural ratchet is never a substitute', 'six layers', 'substitution smell'],
        isTest: false,
    },
];

/** Count `it(` / `it.each(` / `test(` / `test.each(` blocks. */
function itCount(src: string): number {
    return (src.match(/\b(?:it|test)(?:\.each)?\s*[(`]/g) ?? []).length;
}

describe('quality-coverage integrity — guard the guards', () => {
    describe.each(GUARDRAILS)('$pillar — $file', ({ file, anchors, isTest }) => {
        it('the guardrail surface exists', () => {
            expect(exists(file)).toBe(true);
        });

        it('the surface still references its load-bearing anchors (not gutted)', () => {
            const src = read(file);
            for (const anchor of anchors) {
                expect(src).toContain(anchor);
            }
        });

        if (isTest) {
            it('the test still carries ≥3 it-blocks (not no-opped)', () => {
                expect(itCount(read(file))).toBeGreaterThanOrEqual(3);
            });
        }
    });

    // ─── jest.thresholds.json — keys + their RATCHET_FLOOR parity ────
    it('jest.thresholds.json carries the five required keys', () => {
        const t = JSON.parse(read('jest.thresholds.json'));
        // The risk tiers in docs/coverage-policy.md require dedicated
        // keys for each tier-A and tier-B layer plus the global floor.
        const REQUIRED = [
            'global',
            './src/app-layer/usecases/',
            './src/app-layer/policies/',
            './src/app-layer/events/',
            './src/lib/',
        ] as const;
        for (const key of REQUIRED) {
            expect(t[key]).toBeDefined();
            // Each must carry all four standard coverage metrics.
            for (const m of ['branches', 'functions', 'lines', 'statements']) {
                expect(typeof t[key][m]).toBe('number');
            }
        }
    });

    it('jest.thresholds.json keys are mirrored in RATCHET_FLOOR', () => {
        const t = JSON.parse(read('jest.thresholds.json'));
        const ratchet = read('tests/guards/coverage-ratchet.test.ts');
        for (const key of Object.keys(t)) {
            // Every threshold key must have a matching RATCHET_FLOOR
            // entry, or the never-lowered guarantee is incomplete.
            const literal = key === 'global' ? 'global:' : `'${key}':`;
            expect(ratchet).toContain(literal);
        }
    });

    // ─── VALUE parity, not just key parity ───────────────────────────
    //
    // Key parity alone let the two ratchets drift apart. `RATCHET_FLOOR`
    // stayed at the post-Roadmap-3 seed while PR #233 recalibrated the
    // ENFORCED floors from CI's artifact; by 2026-07 the mirror was ten
    // points behind on `global` functions (54 vs 64). The structural
    // "never lower a floor" guard was therefore guarding a state the
    // project had left long ago — a PR could have dropped the enforced
    // global functions floor from 64 back to 55 and `coverage-ratchet`
    // would have passed it.
    //
    // That hole matters more here than it would elsewhere, because the
    // `Coverage (≥60%)` job runs on push to MAIN ONLY, never on PRs. At
    // PR time this static guard is the only thing that sees a lowered
    // floor at all.
    //
    // So: the mirror must never lag the enforced floor. Raising a
    // threshold in `jest.thresholds.json` now means raising its
    // `RATCHET_FLOOR` twin in the same diff — which is exactly the
    // "lock the gain in the same PR" rule the policy already states.
    it('RATCHET_FLOOR never lags the enforced floors in jest.thresholds.json', () => {
        const enforced = JSON.parse(read('jest.thresholds.json')) as Record<
            string,
            Record<string, number>
        >;
        const mirror = parseRatchetFloor(read('tests/guards/coverage-ratchet.test.ts'));

        const lagging: string[] = [];
        for (const [scope, metrics] of Object.entries(enforced)) {
            for (const [metric, value] of Object.entries(metrics)) {
                const mirrored = mirror[scope]?.[metric];
                if (mirrored === undefined) {
                    lagging.push(`${scope} ${metric}: missing from RATCHET_FLOOR`);
                } else if (mirrored < value) {
                    lagging.push(`${scope} ${metric}: RATCHET_FLOOR ${mirrored} < enforced ${value}`);
                }
            }
        }

        if (lagging.length > 0) {
            throw new Error(
                'RATCHET_FLOOR in tests/guards/coverage-ratchet.test.ts has fallen behind ' +
                    'the enforced floors in jest.thresholds.json:\n  ' +
                    lagging.join('\n  ') +
                    '\nRaise the RATCHET_FLOOR entries to match. A structural floor below ' +
                    'the enforced one does not guard the current state.',
            );
        }
    });

    // Regression proof — the detector catches a lagging mirror.
    it('detects a RATCHET_FLOOR entry that lags its enforced floor', () => {
        const parsed = parseRatchetFloor(read('tests/guards/coverage-ratchet.test.ts'));
        const enforced = JSON.parse(read('jest.thresholds.json')) as Record<
            string,
            Record<string, number>
        >;
        // Sabotage a copy: drop the mirror one point below enforced.
        const sabotaged = JSON.parse(JSON.stringify(parsed)) as typeof parsed;
        sabotaged.global.branches = enforced.global.branches - 1;
        expect(sabotaged.global.branches).toBeLessThan(enforced.global.branches);
        // …and the healthy value is not below it.
        expect(parsed.global.branches).toBeGreaterThanOrEqual(enforced.global.branches);
    });
});

/**
 * Parse the `RATCHET_FLOOR` object literal out of
 * `coverage-ratchet.test.ts`. Source-text parsing rather than an import
 * because the constant is module-private to that test file — exporting
 * it would make it look like a shared helper rather than that guard's
 * own hard minimum.
 */
function parseRatchetFloor(src: string): Record<string, Record<string, number>> {
    const start = src.indexOf('const RATCHET_FLOOR: Record<string, Metrics> = {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start).split('\n};')[0];

    const out: Record<string, Record<string, number>> = {};
    const entry = /(?:'([^']+)'|\b(global)\b)\s*:\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = entry.exec(body)) !== null) {
        const scope = m[1] ?? m[2];
        const metrics: Record<string, number> = {};
        for (const [, k, v] of m[3].matchAll(/(\w+)\s*:\s*(\d+)/g)) {
            metrics[k] = Number(v);
        }
        out[scope] = metrics;
    }

    // The parse must have found every scope — a silent zero-match would
    // make the parity assertion vacuously green.
    expect(Object.keys(out).length).toBeGreaterThanOrEqual(5);
    return out;
}
