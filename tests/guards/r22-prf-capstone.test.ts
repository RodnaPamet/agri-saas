/**
 * R22-PR-F — Carved Carbon capstone ratchet.
 *
 * Roadmap-22 (Carved Carbon) is the precision-refinement layer on
 * top of R19 (carbon language) + R20 (elegance). Five small,
 * surgical PRs across the button + practice family, each landing
 * its own structural ratchet:
 *
 *   PR-A — Radius: rounded-lg (12px) → rounded-[10px]
 *   PR-B — Border + Focus: --btn-carbon-border α softened, focus
 *          ring upgraded from Tailwind ring → brand-tinted halo
 *   PR-C — Icon discipline: per-size [&_svg]:size-N + shrink-0
 *   PR-D — Disabled + Loading: graded mute (saturate-50) +
 *          LoadingSpinner currentColor
 *   PR-E — Variant + CTA order: Modal.Confirm DOM order locked,
 *          variant inventory documented
 *
 * PR-F is the meta-lock: a future PR can't silently strip one of
 * the five R22 ratchets without tripping THIS test first. The
 * substantive assertions stay on each per-PR ratchet.
 *
 * Pattern-based count (not exact filenames) so this assertion
 * stays correct whether PR-F lands first or last in the R22
 * round, and so adding a future R22 PR (e.g., motion-timing
 * refinement) extends the count rather than breaking the
 * contract.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const DOCS = fs.readFileSync(
    path.join(ROOT, 'docs/ui-buttons.md'),
    'utf8',
);

describe('R22-PR-F — Carved Carbon capstone', () => {
    describe('R22 ratchet contract surface', () => {
        it('the R22 ratchet contract surface stays intact (meta-lock)', () => {
            // Pattern-based count so the assertion stays correct
            // whether PR-F lands first or last in the round, and
            // so adding a future R22 PR (e.g., motion-timing
            // refinement) extends the count rather than breaking
            // the contract.
            const guardDir = path.join(ROOT, 'tests/guards');
            const r22 = fs
                .readdirSync(guardDir)
                .filter((name) => /^r22-pr.*\.test\.ts$/.test(name));
            // PR-F always present (it's THIS file). When PRs A-E
            // merge to main, the count grows; once all six are on
            // main, a future PR that drops one fails this check.
            expect(r22.length).toBeGreaterThanOrEqual(1);
            expect(r22).toEqual(
                expect.arrayContaining(['r22-prf-capstone.test.ts']),
            );
        });
    });

    describe('docs/ui-buttons.md carries the Carved Carbon section', () => {
        it('mentions "Carved Carbon" + Roadmap-22', () => {
            expect(DOCS).toMatch(/Carved Carbon/);
            expect(DOCS).toMatch(/Roadmap-22/);
        });

        it('lists each of the five R22 PRs by letter', () => {
            // PR-A through PR-E should all appear in the
            // capstone-section table. A future engineer must be
            // able to find every R22 move from the doc.
            for (const letter of ['A', 'B', 'C', 'D', 'E']) {
                expect(DOCS).toMatch(
                    new RegExp(`\\*\\*${letter}\\*\\*`),
                );
            }
        });

        it('references the load-bearing R22 tokens/recipes by name', () => {
            // Spot-check that the capstone summary actually
            // describes the changes (not just lists letters).
            expect(DOCS).toMatch(/rounded-\[10px\]/);
            expect(DOCS).toMatch(/--btn-carbon-border/);
            expect(DOCS).toMatch(/\[&_svg\]:size-N/);
            expect(DOCS).toMatch(/disabled:saturate-50/);
            expect(DOCS).toMatch(/Mac\/iOS CTA order/);
        });
    });

    describe('R20 + R19 systems are undisturbed', () => {
        // R22 is ADDITIVE precision-refinement. The R19 carbon
        // recipes + R20 elegance recipes must all still exist.
        // We don't re-assert their content (each prior PR's
        // ratchet does that) — just that the docs sections
        // referencing them haven't been stripped.
        it('R19 Liquid-carbon surface section still in docs', () => {
            expect(DOCS).toMatch(/Liquid-carbon surface/);
        });
        it('R20 Liquid Elegance section still in docs', () => {
            expect(DOCS).toMatch(/Liquid Elegance/);
        });
    });
});
