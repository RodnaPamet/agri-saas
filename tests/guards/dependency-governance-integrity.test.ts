/**
 * Dependency-governance capstone — the meta-ratchet.
 *
 * The build-integrity roadmap closed the dependency story with a set
 * of structural guardrails, each protecting a distinct regression
 * class:
 *
 *   1. Deterministic installs   — `npm ci`, pinned Node, locked tree.
 *   2. Strict peer resolution   — no `--legacy-peer-deps`.
 *   3. Framework version coherence — `@next/swc-*` tracks `next`.
 *   4. Reviewed runtime risk    — CVE-active packages stay correctly
 *                                 classified, on their reviewed major.
 *   5. Auth-stack pin           — `next-auth` stays on v4 stable
 *                                 (the NextAuth-v5 policy).
 *   6. Override structural decay — every `overrides` entry still has a
 *                                 target, can act, excludes something,
 *                                 and widens nothing.
 *
 * Each of those five shipped its own guardrail. THIS test guards the
 * guards: it fails CI if any one of them is deleted or gutted to a
 * no-op, and it asserts the governance docs survive with their
 * load-bearing policy statements intact. A contributor who removes a
 * dependency guardrail must reckon with a red meta-ratchet — the gap
 * cannot silently reopen.
 *
 * Sibling of `ci-pipeline-integrity.test.ts`,
 * `observability-reliability-integrity.test.ts`, and
 * `verification-integrity.test.ts` — same "guard the guards"
 * pattern, the dependency-governance domain.
 *
 * See docs/dependency-governance.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The dependency-governance guardrail registry. Each must exist,
 * still contain its subject anchors (proof it was not gutted), and
 * carry a real assertion surface.
 */
const GUARDRAILS: ReadonlyArray<{
    file: string;
    pillar: string;
    anchors: string[];
}> = [
    {
        file: 'tests/guards/deterministic-install.test.ts',
        pillar: 'deterministic installs — npm ci + pinned Node + locked tree',
        anchors: ['npm ci', 'engines', '.nvmrc'],
    },
    {
        file: 'tests/guards/no-legacy-peer-deps.test.ts',
        pillar: 'strict peer resolution — no --legacy-peer-deps',
        anchors: ['legacy-peer-deps'],
    },
    {
        file: 'tests/guards/swc-version-coherence.test.ts',
        pillar: 'framework version coherence — @next/swc-* tracks next',
        anchors: ['@next/swc', 'next'],
    },
    {
        file: 'tests/guards/dependency-risk-review.test.ts',
        pillar: 'reviewed runtime risk — CVE-active packages stay classified',
        anchors: ['REVIEWED', 'devDependencies'],
    },
    {
        file: 'tests/guardrails/auth-stack-pinning.test.ts',
        pillar: 'auth-stack pin — next-auth stays on v4 stable',
        anchors: ['next-auth', 'beta'],
    },
    {
        // Registered here on purpose: this one ships with a waiver list, and
        // the cheapest way to silence a guard that carries waivers is to
        // delete the guard rather than an entry. The anchors are the two
        // rules that make the list shrink — `WAIVERS` plus the review-date
        // expiry — so gutting it to a permanent allowlist also fails.
        file: 'tests/guards/overrides-structural-decay.test.ts',
        pillar: 'override structural decay — every overrides entry still does an override\'s job',
        anchors: ['WAIVERS', 'DORMANT_FLOORS', 'expired', 'analyseOverrides'],
    },
];

/** Docs that make the dependency-governance model explicit. */
const GOVERNANCE_DOCS: ReadonlyArray<{ file: string; role: string }> = [
    { file: 'docs/dependency-governance.md', role: 'the unified governance model' },
    { file: 'docs/dependency-policy.md', role: 'install-time policy — strict peers, npm ci, overrides' },
    { file: 'docs/dependency-risk-review.md', role: 'the package-by-package risk review' },
];

/** Count `it(` / `it.each(` assertion blocks in a test file. */
function itCount(src: string): number {
    return (src.match(/\bit(?:\.each)?\s*[(`]/g) ?? []).length;
}

describe('dependency-governance integrity — guard the guards', () => {
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

    it('the registry is complete (6 dependency guardrails, distinct)', () => {
        expect(GUARDRAILS).toHaveLength(6);
        expect(new Set(GUARDRAILS.map((g) => g.file)).size).toBe(6);
    });

    it.each(GOVERNANCE_DOCS)('$role — $file exists', ({ file }) => {
        expect(exists(file)).toBe(true);
    });

    it('the governance doc states the four-pillar enforcement model', () => {
        // The load-bearing structure of the model — if the doc is
        // hollowed out, this catches it.
        const doc = read('docs/dependency-governance.md');
        expect(doc).toMatch(/deterministic install/i);
        expect(doc).toMatch(/strict peer/i);
        expect(doc).toMatch(/version coherence/i);
        expect(doc).toMatch(/risk/i);
    });

    it('the governance doc states the NextAuth stay-on-v4 policy', () => {
        // The deliberate-decision rationale — must name v4, the v5
        // beta-only status, and the recheck trigger.
        const doc = read('docs/dependency-governance.md');
        expect(doc).toMatch(/next-?auth/i);
        expect(doc).toMatch(/\bv4\b/);
        expect(doc).toMatch(/5\.0\.0|beta-only|GA/);
        expect(doc).toMatch(/recheck|dist-tag/i);
    });

    it('the governance doc states the contributor dependency lifecycle', () => {
        // Adding / upgrading / removing — the safe-path workflow.
        const doc = read('docs/dependency-governance.md');
        expect(doc).toMatch(/adding a dependency/i);
        expect(doc).toMatch(/upgrading a dependency/i);
        expect(doc).toMatch(/removing a dependency/i);
    });

    it('the governance doc explains the two kinds of override', () => {
        // Bridge vs security override — conflating them is how a
        // security override gets dropped on convenience.
        const doc = read('docs/dependency-governance.md');
        expect(doc).toMatch(/bridge override/i);
        expect(doc).toMatch(/security override/i);
    });
});
