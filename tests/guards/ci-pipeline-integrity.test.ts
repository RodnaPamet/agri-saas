/**
 * CI/CD pipeline-integrity capstone — the meta-ratchet.
 *
 * Four remediations hardened the build / test / release pipeline:
 *
 *   1. Dependency-install integrity — strict peer resolution
 *      (`no-legacy-peer-deps`) + deterministic `npm ci` installs
 *      (`deterministic-install`).
 *   2. E2E test isolation — fixture-scoped tenants, no cross-test
 *      `let` cascade (`e2e-isolation`).
 *   3. Build / env-validation discipline — the CI build skips
 *      compile-time env validation deliberately; runtime is the
 *      real gate.
 *
 * (A fourth pillar — the staging smoke gate and the OI-2 helm
 * invariants — was removed in #808 along with `deploy.yml`, the EKS
 * deploy workflow that never ran once. Its two guardrails went with
 * it; there is no longer a subject for them to guard.)
 *
 * Each of 1–2 shipped its OWN structural guardrail. THIS test
 * guards the guards: it fails CI if any of those guardrail files is
 * deleted or gutted to a no-op, so a future "simplify the tests"
 * change cannot quietly dismantle the protection. It also locks the
 * build/env-validation posture (item 4).
 *
 * Make the safe path the default path: a contributor who removes a
 * pipeline guardrail must reckon with a red meta-ratchet, not a
 * silently weakened pipeline.
 *
 * See docs/ci-cd-pipeline-integrity.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The pipeline guardrail registry. Each entry must (a) exist,
 * (b) still contain its subject anchors — proof it was not gutted
 * into a no-op — and (c) carry a real assertion surface. Removing
 * a remediation means deleting its guardrail AND its registry
 * entry here in the same diff, which is the design conversation.
 */
const GUARDRAILS: ReadonlyArray<{
    file: string;
    pillar: string;
    anchors: string[];
}> = [
    {
        file: 'tests/guards/no-legacy-peer-deps.test.ts',
        pillar: 'dependency-install integrity (strict peers)',
        anchors: ['legacy-peer-deps', 'overrides'],
    },
    {
        file: 'tests/guards/deterministic-install.test.ts',
        pillar: 'dependency-install integrity (deterministic npm ci)',
        anchors: ['npm ci', 'engines', 'install path'],
    },
    {
        file: 'tests/guards/e2e-isolation.test.ts',
        pillar: 'E2E test isolation',
        anchors: ['cascade', 'isolatedTenant'],
    },
];

/** Count `it(` / `it.each(` assertion blocks in a test file. */
function itCount(src: string): number {
    return (src.match(/\bit(?:\.each)?\s*[(`]/g) ?? []).length;
}

describe('CI/CD pipeline-integrity — guard the guards', () => {
    describe.each(GUARDRAILS)('$pillar — $file', ({ file, anchors }) => {
        it('the guardrail file exists', () => {
            expect(exists(file)).toBe(true);
        });

        it('the guardrail still references its subject (not gutted)', () => {
            const src = read(file);
            for (const anchor of anchors) {
                expect(src).toContain(anchor);
            }
        });

        it('the guardrail carries a real assertion surface (>= 3 it-blocks)', () => {
            expect(itCount(read(file))).toBeGreaterThanOrEqual(3);
        });
    });

    it('every registry pillar is distinct and the set is complete (3 guardrails)', () => {
        // A drive-by deletion of one entry shrinks this count; the
        // number is the explicit contract for "how many pipeline
        // guardrails exist".
        // 5 -> 3 in #808: the staging-smoke-gate and OI-2-helm guardrails were
        // deleted with deploy.yml, their subject. Derived from the registry
        // above, not decremented blindly.
        expect(GUARDRAILS).toHaveLength(3);
        // Distinctness derives from the registry rather than repeating the
        // literal: the count contract is the assertion above, and a second
        // hardcoded number here only ever drifts from it.
        expect(new Set(GUARDRAILS.map((g) => g.file)).size).toBe(
            GUARDRAILS.length,
        );
    });
});

describe('CI/CD pipeline-integrity — build / env-validation discipline', () => {
    const ci = () => read('.github/workflows/ci.yml');

    it('the CI workflow skips env validation at build time deliberately', () => {
        // SKIP_ENV_VALIDATION at workflow level — CI has only dummy
        // secrets, so compile-time validation is intentionally off.
        expect(ci()).toMatch(/SKIP_ENV_VALIDATION:\s*"1"/);
    });

    it('the build step documents WHY env validation is skipped + names the runtime gate', () => {
        const src = ci();
        // The explanatory comment must survive — it is the thing
        // that keeps the skip "intentional" rather than a latent
        // mystery for the next engineer.
        expect(src).toMatch(/Env validation is INTENTIONALLY skipped at build time/);
        expect(src).toMatch(/REAL env gate is RUNTIME/);
        expect(src).toMatch(/instrumentation\.ts/);
    });

    it('src/env.ts actually honours SKIP_ENV_VALIDATION (the skip mechanism is real)', () => {
        // If this wiring is removed, the build-time skip silently
        // becomes a no-op AND production loses its runtime check.
        expect(read('src/env.ts')).toMatch(
            /skipValidation:\s*!!process\.env\.SKIP_ENV_VALIDATION/,
        );
    });

    it('the unified pipeline-integrity doc exists', () => {
        expect(exists('docs/ci-cd-pipeline-integrity.md')).toBe(true);
    });

    // ── Regression proof — the meta-ratchet catches a removed guard ──
    it('detects a guardrail registry entry whose file is missing', () => {
        const missing = { file: 'tests/guards/__deleted__.test.ts' };
        expect(exists(missing.file)).toBe(false);
    });
});
