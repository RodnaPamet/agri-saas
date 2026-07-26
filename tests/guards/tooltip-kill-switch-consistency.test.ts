/**
 * Tooltip kill-switch consistency.
 *
 * `TOOLTIPS_ENABLED` in `src/components/ui/tooltip.tsx` is a temporary
 * app-wide kill-switch: hover/focus tooltips misbehave on touch devices (the
 * Radix popup opens on the synthesised focus of a tap and then sits over the
 * UI, intercepting the next touch), so `<Tooltip>` renders its trigger with no
 * popup wiring until a touch-aware fix lands.
 *
 * Seven tests currently skip because of that flag. Six of them do it CORRECTLY:
 * `tests/rendered/tooltip.test.tsx` derives `itWhenEnabled` from the exported
 * constant, so they re-arm the moment the flag flips.
 *
 * The seventh did not. `tests/e2e/tooltip-and-copy.spec.ts` hard-skips its
 * hover-reveal case with a comment saying "until tooltips are re-enabled" —
 * nothing connects it to the flag, so flipping the switch back to `true` would
 * leave that test silently dead forever. A skipped test nobody is told about is
 * a missing assertion, not a paused one.
 *
 * Playwright specs in this repo never import from `src/` (the alias exists but
 * pulling a React/Radix module into the Playwright process for one boolean is a
 * poor trade), so the linkage is enforced HERE instead: while the flag is off
 * the hard skip is allowed; the moment it flips to `true`, this guard fails and
 * names the file that has to be re-enabled.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const TOOLTIP_SRC = path.join(ROOT, 'src/components/ui/tooltip.tsx');
const JEST_SPEC = path.join(ROOT, 'tests/rendered/tooltip.test.tsx');
const E2E_SPEC = path.join(ROOT, 'tests/e2e/tooltip-and-copy.spec.ts');

function read(p: string): string {
    return fs.readFileSync(p, 'utf-8');
}

/** The literal value of the exported kill-switch. */
function tooltipsEnabled(): boolean {
    const src = read(TOOLTIP_SRC);
    const m = src.match(/export const TOOLTIPS_ENABLED\s*=\s*(true|false)\s*;/);
    if (!m) {
        throw new Error(
            'Could not read TOOLTIPS_ENABLED from src/components/ui/tooltip.tsx. ' +
                'If the kill-switch was removed (tooltips permanently on), delete this guard ' +
                'and un-skip the hover cases in tests/rendered/tooltip.test.tsx + ' +
                'tests/e2e/tooltip-and-copy.spec.ts.',
        );
    }
    return m[1] === 'true';
}

describe('tooltip kill-switch consistency', () => {
    it('is still a boolean literal this guard can read', () => {
        expect(typeof tooltipsEnabled()).toBe('boolean');
    });

    it('the jest hover cases derive their skip from the exported flag', () => {
        // This is the pattern that makes a skip self-restoring. If someone
        // converts these to `it.skip(...)`, they stop coming back.
        const src = read(JEST_SPEC);
        expect(src).toMatch(
            /const\s+itWhenEnabled\s*=\s*TOOLTIPS_ENABLED\s*\?\s*it\s*:\s*it\.skip/,
        );
        expect(src).toContain("TOOLTIPS_ENABLED");
        // No hard skips in the jest spec — they would not re-arm.
        expect(src).not.toMatch(/^\s*it\.skip\(/m);
    });

    it('the e2e hover case is re-enabled as soon as tooltips are', () => {
        const e2e = read(E2E_SPEC);
        const hardSkip = /^\s*test\.skip\(\s*['"]/m.test(e2e);

        if (tooltipsEnabled()) {
            // The flag is back on: the hover-reveal hint renders again, so the
            // e2e case must run. This is the assertion the old comment-only
            // linkage could not make.
            expect(hardSkip).toBe(false);
        } else {
            // Flag is off — the hard skip is the intended state. Assert it still
            // explains itself, so the next reader knows it is flag-driven and
            // not an abandoned test.
            expect(hardSkip).toBe(true);
            expect(e2e).toContain('TOOLTIPS_ENABLED');
        }
    });

    it('the kill-switch documents that it is temporary', () => {
        // The flag is a stopgap for a real touch-device bug. If that comment
        // disappears, the "temporary" framing is lost and the disabled state
        // quietly becomes permanent.
        const src = read(TOOLTIP_SRC);
        expect(src).toMatch(/kill-switch \(temporary\)/i);
    });
});
