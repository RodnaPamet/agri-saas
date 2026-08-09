/**
 * Guardrail: npm-audit exemptions stay small, justified and time-boxed.
 *
 * `scripts/audit-gate.mjs` keeps the production audit gate at moderate+
 * while allowing named, per-advisory exemptions for advisories with no
 * upstream fix. That mechanism is strictly safer than lowering the gate
 * — but only while each entry stays honest, so the shape is asserted
 * here rather than trusted.
 *
 * The gate script itself already fails CI on an EXPIRED or STALE
 * exemption at audit time. This test covers what the script cannot see
 * without running npm: that every entry is well-formed, that the
 * rationale is a real explanation rather than a placeholder, and that
 * the list has not quietly grown into a blanket waiver.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const GATE = path.join(REPO_ROOT, 'scripts/audit-gate.mjs');
const CI = path.join(REPO_ROOT, '.github/workflows/ci.yml');

/**
 * A ceiling, not a target. Exemptions are accepted risk; a list that
 * grows without anyone noticing is the failure mode this bounds. Raising
 * it is a deliberate act that shows up in a diff.
 */
const MAX_EXEMPTIONS = 4;

/** Parse the EXEMPTIONS array out of the gate script without executing it (it shells out to npm). */
function readExemptions(): Array<Record<string, string>> {
    const src = readFileSync(GATE, 'utf8');
    const entries: Array<Record<string, string>> = [];
    // Each entry is a `{ ... }` block introduced by a `ghsa:` field.
    const blocks = src.split(/\n\s*\{\s*\n/).slice(1);
    for (const block of blocks) {
        const body = block.split(/\n\s*\},?\s*\n/)[0];
        if (!/ghsa:/.test(body)) continue;
        const field = (name: string) => {
            const m = body.match(new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n\\s{8}[a-zA-Z]+:|$)`));
            if (!m) return '';
            return m[1]
                .replace(/['"+\n]/g, ' ')
                .replace(/\s+/g, ' ')
                // The final field in a block runs up to the closing `},`,
                // so strip any trailing separator/brace debris. Without
                // this the last entry's value fails its own format check.
                .replace(/[\s,}]+$/, '')
                .trim();
        };
        entries.push({
            ghsa: field('ghsa'),
            package: field('package'),
            reason: field('reason'),
            voidedIf: field('voidedIf'),
            reviewBy: field('reviewBy'),
        });
    }
    return entries;
}

describe('npm audit exemptions', () => {
    const exemptions = readExemptions();

    it('parses at least one exemption (the parser itself is not silently broken)', () => {
        // Without this, a regex that matched nothing would make every
        // per-entry assertion below vacuously pass.
        expect(exemptions.length).toBeGreaterThan(0);
    });

    it(`holds no more than ${MAX_EXEMPTIONS} entries`, () => {
        expect(exemptions.length).toBeLessThanOrEqual(MAX_EXEMPTIONS);
    });

    it.each(readExemptions())('$ghsa is well-formed and justified', (e) => {
        expect(e.ghsa).toMatch(/^GHSA-[0-9a-z-]+$/i);
        expect(e.package).not.toHaveLength(0);
        expect(e.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // A rationale must actually explain. These lengths are low bars
        // that "n/a", "TODO" or "unfixable" all fail.
        expect(e.reason.length).toBeGreaterThan(80);
        expect(e.voidedIf.length).toBeGreaterThan(10);
        expect(e.reason).not.toMatch(/\b(TODO|TBD|FIXME|n\/?a)\b/i);
    });

    it('every exemption has a future review date', () => {
        const today = new Date().toISOString().slice(0, 10);
        for (const e of exemptions) {
            // The gate script fails CI once this passes, so an entry
            // landing already-expired would break main on merge.
            expect(e.reviewBy > today).toBe(true);
        }
    });

    it('CI runs the gate script, not a bare npm audit that would bypass it', () => {
        const ci = readFileSync(CI, 'utf8');
        expect(ci).toMatch(/node scripts\/audit-gate\.mjs/);
    });

    it('the gate script still audits production deps at moderate+', () => {
        const src = readFileSync(GATE, 'utf8');
        // Mirrors security-gate-strictness: the level must not drift up.
        expect(src).toMatch(/const AUDIT_LEVEL = 'moderate'/);
        expect(src).toMatch(/'--omit=dev'/);
        expect(src).not.toMatch(/const AUDIT_LEVEL = '(high|critical)'/);
    });
});
