/**
 * B3 — button + card unification ratchet. Three moves; each one
 * locked here so a future PR cannot silently regress the visual
 * language.
 *
 *   1. Button base radius is `rounded-full` (pill) — picked as the
 *      canonical shape per the Audit/Frameworks button reference.
 *   2. Practice Coverage and Risk Distribution cards both stretch
 *      to row height via `h-full flex flex-col`.
 *   3. CalendarMonth has a `selectedYmd` prop and renders a
 *      selected-state on the matching cell.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B3 — button + card unify', () => {
    describe('Move 1 — pill canonicalisation on the Button cva', () => {
        const variants = read('src/components/ui/button-variants.ts');

        it('cva base classes include `rounded-full`', () => {
            // Block-scope the search to the cva base (before the
            // size variants), so a stray `rounded-full` token
            // elsewhere doesn't accidentally satisfy this.
            const baseBlock = variants.slice(
                0,
                variants.indexOf('size: {'),
            );
            expect(baseBlock).toMatch(/"border rounded-full"/);
            // Pre-B3 used `rounded-[8px]` — that string must NOT
            // be the base any more.
            expect(baseBlock).not.toMatch(/"border rounded-\[8px\]"/);
        });

        it('xs size variant no longer carries a `rounded-md` override', () => {
            // The override existed because at 8px the xs button
            // read "pill-ish". Pill is now the canonical shape, so
            // the override is redundant — and a future override
            // would silently break the unified language.
            const block = variants.slice(
                variants.indexOf('xs: "'),
                variants.indexOf('sm: "'),
            );
            expect(block).not.toMatch(/rounded-md/);
            expect(block).not.toMatch(/rounded-\[/);
        });
    });

    describe('Move 2 — Practice Coverage card height contract', () => {
        const progress = read('src/components/ui/ProgressCard.tsx');
        const dashboard = read(
            'src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx',
        );

        it('ProgressCard root uses h-full flex flex-col', () => {
            expect(progress).toMatch(
                /cardVariants\(\),\s*['"]h-full flex flex-col['"]/,
            );
        });

        it('the Risk Distribution card was removed from the dashboard', () => {
            // Move 2 originally matched ProgressCard's height to the Risk
            // Distribution card so the two read as a balanced row. That card
            // has since been removed from the dashboard entirely.
            expect(dashboard).not.toContain('id="risk-distribution"');
        });
    });

    describe('Move 3 — calendar day click colour-state feedback', () => {
        const cal = read('src/components/ui/CalendarMonth.tsx');
        const client = read(
            'src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx',
        );

        it('CalendarMonth declares the selectedYmd prop', () => {
            expect(cal).toMatch(/selectedYmd\?:\s*string\s*\|\s*null/);
        });

        it('selected cell renders the brand ring + brand-subtle wash', () => {
            // The selected-state styling lives inside the cell
            // className `cn(...)` call. Anchor on `isSelected` so
            // unrelated `bg-brand-subtle` use elsewhere can't mask
            // a regression.
            const idx = cal.indexOf('const isSelected = selectedYmd === ymd');
            expect(idx).toBeGreaterThan(0);
            const block = cal.slice(idx, idx + 2400);
            expect(block).toMatch(/isSelected &&/);
            expect(block).toMatch(
                /ring-2 ring-\[var\(--brand-default\)\]/,
            );
            expect(block).toMatch(/bg-brand-subtle/);
            expect(block).toMatch(/data-selected=/);
        });

        it('CalendarClient passes the selected date through', () => {
            // PR-C extended the CalendarMonth mount with
            // `onDoubleClickDate` between onSelectDate and
            // selectedYmd, pushing selectedYmd past the original
            // 400-char window. The pattern still locks the prop
            // wiring; widen the window so legitimate additions
            // between sibling props don't trip the assertion.
            expect(client).toMatch(
                /<CalendarMonth[\s\S]{0,800}selectedYmd=\{selectedDate\}/,
            );
        });
    });
});
