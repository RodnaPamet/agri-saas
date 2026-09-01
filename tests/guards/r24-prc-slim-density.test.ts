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
 *     ⚠️ SUPERSEDED by #776 — see the note above the (removed)
 *     height describe block below.
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

    /*
     * REMOVED (#776) — describe('Heights NOT touched (form-control
     * parity preserved)').
     *
     * It held ONE assertion:
     *
     *     it('default size (md) still uses h-9 (parity with <Input>)', …)
     *       expect(read('src/components/ui/button-variants.ts'))
     *           .toMatch(/md:\s*"h-9\s/);
     *
     * What it meant. R24-PR-C was a radius-only pass, and the
     * assertion was the receipt for that scope line: the button `md`
     * height was pinned to `h-9` in lockstep with `<Input size="md">`
     * (the R20-PR-A form-control parity lock), so a filter-toolbar row
     * of buttons and inputs sat on one baseline. The comment inside it
     * even named the sanctioned way out — "a future roadmap can drop
     * the whole control family to h-8 together".
     *
     * Why it is gone rather than retargeted. #776 adopted the sibling
     * product's single-rung ladder: every `size` on `button-variants.ts`
     * now resolves to the SAME 28px rung, and `controlSize` collapsed
     * with it. So both halves of the assertion are false BY DESIGN —
     * the button `md` is `h-7`, and the parity it was named for is
     * broken in the one direction that matters, because `input.tsx`
     * keeps its own `md: "h-9 …"` map and was deliberately left alone
     * (collapsing typing surfaces is a separate decision; see the
     * docblock on `controlSize`). Retargeting it to `/md:\s*"h-7\s/`
     * would keep the words and drop the meaning: it would no longer be
     * a parity lock, just a fourth restatement of a rung that four
     * identical size strings already state, and that the ladder guards
     * assert at their source. The uniform-rung invariant — the four
     * sizes are IDENTICAL — is owned there, not here; this file is the
     * radius ratchet.
     *
     * The history is the point: the h-9 lock was deliberate for four
     * roadmap passes, and it was reversed deliberately, not eroded.
     * Restoring a graded height ladder means reopening #776, not
     * un-deleting this block.
     */
});
