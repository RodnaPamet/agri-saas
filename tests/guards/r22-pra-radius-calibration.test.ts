/**
 * R22-PR-A — Radius calibration ratchet — REVISED by B3 (2026-05-24).
 *
 * R22 originally carved the button silhouette from `rounded-lg`
 * (12px) to `rounded-[8px]`. B3 then took the next step and pushed
 * the button family ALL the way to `rounded-full` (pill) — the
 * canonical shape chosen from the Audit/Frameworks button.
 *
 * The form-control family (Input / date-picker trigger / combobox
 * trigger) stays at `rounded-[8px]` per the B3 design decision —
 * text-entry surfaces remain rectangular by convention. This
 * ratchet now enforces the SPLIT:
 *
 *   - Button cva base + every size variant → `rounded-full`.
 *   - button.tsx disabled-fallback paths → `rounded-full`.
 *   - control-variants.ts → `rounded-[8px]`.
 *   - input.tsx → `rounded-[8px]`.
 *   - date-picker/trigger.tsx → `rounded-[8px]`.
 *
 * `rounded-lg` is still banned across the family — R22's original
 * "not the inflated 12px" intent stands.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const BUTTON_VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button-variants.ts'),
    'utf8',
);
const BUTTON_TSX = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/button.tsx'),
    'utf8',
);
const CONTROL_VARIANTS = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/control-variants.ts'),
    'utf8',
);
const INPUT_TSX = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/input.tsx'),
    'utf8',
);
const DATE_TRIGGER = fs.readFileSync(
    path.join(ROOT, 'src/components/ui/date-picker/trigger.tsx'),
    'utf8',
);

describe('R22-PR-A — Radius calibration (post-B3 pill canonicalisation)', () => {
    describe('button-variants.ts cva base — pill canonical', () => {
        it('uses `rounded-full`, not `rounded-lg`', () => {
            const base =
                BUTTON_VARIANTS.match(/cva\(\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? '';
            const stripped = base
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            // B3 — pill base, set explicitly on the cva root.
            expect(stripped).toMatch(/rounded-full/);
            expect(stripped).not.toMatch(/\brounded-lg\b/);
            // The earlier carved 8px is ALSO gone now — B3 supersedes
            // R22-PR-A's carving on the button family.
            expect(stripped).not.toMatch(/rounded-\[8px\]/);
        });

        it('xs size variant carries no per-size radius override', () => {
            // Pre-B3 xs had `rounded-md` to avoid the "pill-ish at h-7"
            // effect when the base was 10px. Pill is now the canonical
            // shape across every size, so the override is moot — a
            // future per-size radius would silently break the unified
            // language. Strip comments first so the rationale block
            // can mention the old override without false-positiving.
            const block = BUTTON_VARIANTS.slice(
                BUTTON_VARIANTS.indexOf('xs: "'),
                BUTTON_VARIANTS.indexOf('sm: "'),
            );
            const strippedBlock = block
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(strippedBlock).not.toMatch(/rounded-md/);
            expect(strippedBlock).not.toMatch(/rounded-\[/);
        });
    });

    describe('button.tsx disabled-fallback paths', () => {
        it('disabledTooltip branch follows the pill canonical', () => {
            // Hand-rolled className branches must move in lockstep with
            // the cva. B3 swept these too — both fallbacks read as
            // pill buttons.
            const stripped = BUTTON_TSX.replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).toMatch(
                /"rounded-full border border-border-subtle bg-bg-subtle text-sm text-content-subtle"/,
            );
        });

        it('loading/disabled branch follows the pill canonical', () => {
            const stripped = BUTTON_TSX.replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).toMatch(
                /"rounded-full border border-border-subtle bg-bg-subtle text-content-subtle"/,
            );
        });

        it('no `rounded-lg` literal remains in button.tsx', () => {
            const stripped = BUTTON_TSX.replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).not.toMatch(/\brounded-lg\b/);
        });
    });

    describe('control-variants.ts mirror', () => {
        it('uses `rounded-[10px]` not `rounded-lg`', () => {
            const stripped = CONTROL_VARIANTS.replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).toMatch(/rounded-\[8px\]/);
            expect(stripped).not.toMatch(/\brounded-lg\b/);
        });
    });

    describe('inline form-control radius mirrors', () => {
        // input.tsx + date-picker/trigger.tsx don't yet wire
        // through control-variants — they roll their own radius
        // literal. R22-PR-A keeps them in lockstep with the cva
        // base.
        it('input.tsx uses `rounded-[10px]`', () => {
            const stripped = INPUT_TSX.replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).toMatch(/rounded-\[8px\]/);
            expect(stripped).not.toMatch(/\brounded-lg\b/);
        });

        it('date-picker/trigger.tsx uses `rounded-[10px]`', () => {
            const stripped = DATE_TRIGGER.replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            expect(stripped).toMatch(/rounded-\[8px\]/);
            expect(stripped).not.toMatch(/\brounded-lg\b/);
        });
    });

    describe('cross-family consistency post-B3', () => {
        it('no `rounded-lg` literal anywhere in the family', () => {
            // R22's original intent — "not the inflated 12px shape" —
            // stands across both the button family (now pill) and
            // the form-control family (still 8px).
            for (const src of [
                BUTTON_VARIANTS,
                CONTROL_VARIANTS,
                INPUT_TSX,
                DATE_TRIGGER,
                BUTTON_TSX,
            ]) {
                const stripped = src
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\/\/[^\n]*/g, '');
                expect(stripped).not.toMatch(/\brounded-lg\b/);
            }
        });
    });
});
