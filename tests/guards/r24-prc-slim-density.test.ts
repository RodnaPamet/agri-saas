/**
 * R24-PR-C — Slim radius re-tune ratchet.
 *
 * R22-PR-A took the button radius from `rounded-lg` (12px) to
 * `rounded-[10px]`. R24-PR-C tightens one more step: 10px → 8px.
 * 8px sits at the boundary between "gentle modern" and "carved
 * card" — far enough from a hard right angle to read soft, far
 * enough from a pill to read deliberate.
 *
 * Why ratchet: a future PR that softens the radius back to 10px
 * or 12px would lose the R24 slim signal without anyone noticing
 * in code review. The five touched files (button + input + date-
 * picker trigger + control-variants + button.tsx disabled
 * fallback) must move in lockstep — they're the chrome-parity
 * surface.
 *
 * Scope clarification — what PR-C deliberately did NOT touch:
 *   - Heights (h-9 default). Form-control parity locked at h-9
 *     by R20-PR-A; dropping the button to h-8 would break Input
 *     alignment in filter toolbars. A later roadmap can drop the
 *     whole control family to h-8 in lockstep.
 *   - `gap-tight` token (8px). 287 consumers across the codebase
 *     would ripple if changed. Out of R24's scope.
 *   - Tracking + weight ladder (R20-PR-C / R20-PR-E). Glass
 *     materials don't change typography opinions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

// B3 (2026-05-24) — buttons are now pill (`rounded-full`), so the
// button surfaces are out of the R24 slim-radius family. The form-
// control family (Input + date-picker trigger + control-variants)
// stays at R24's 8px slim radius — text-entry surfaces remain
// rectangular per the B3 design decision.
const SLIM_RADIUS_SITES = [
    'src/components/ui/control-variants.ts',
    'src/components/ui/input.tsx',
    'src/components/ui/date-picker/trigger.tsx',
] as const;

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('R24-PR-C — Slim radius re-tune', () => {
    for (const site of SLIM_RADIUS_SITES) {
        describe(site, () => {
            const src = read(site);

            it('uses `rounded-[8px]` (the R24 slim shape)', () => {
                expect(src).toMatch(/rounded-\[8px\]/);
            });

            it('does NOT carry the legacy `rounded-[10px]` radius', () => {
                // Strip comments so the historical-context comment in
                // button-variants.ts ("R22-PR-A radius calibration —
                // R19 shipped rounded-lg (12px); R22 dropped to
                // rounded-[10px]") doesn't false-positive.
                const stripped = src
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\/\/[^\n]*/g, '');
                expect(stripped).not.toMatch(/rounded-\[10px\]/);
            });
        });
    }

    describe('Heights NOT touched (form-control parity preserved)', () => {
        const src = read('src/components/ui/button-variants.ts');

        it('default size (md) still uses h-9 (parity with <Input>)', () => {
            // R20-PR-A locked the button md height at h-9 in lockstep
            // with <Input>. R24-PR-C does not change heights — a
            // future roadmap can drop the whole control family to
            // h-8 together, but R24's scope is radius-only.
            expect(src).toMatch(/md:\s*"h-9\s/);
        });
    });
});
